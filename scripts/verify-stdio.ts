/**
 * Live end-to-end verification — this is the ONE script that touches the
 * real network. It:
 *
 *   1. spawns the server as a real subprocess and performs a raw JSON-RPC
 *      `initialize` handshake over stdio (reports the negotiated protocol
 *      version straight from the wire),
 *   2. connects an official SDK client, lists tools (expects exactly the
 *      six narrow tools),
 *   3. makes two live tool calls (geocode → current weather),
 *   4. proves one clean schema-violation error,
 *   5. exits non-zero if anything failed.
 *
 * Run from the repo root:  bun run verify
 */

import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../src/version.ts";

const isBun = (process.versions as Record<string, string | undefined>).bun !== undefined;
const serverArgs = ["src/index.ts"]; // Bun runs TS natively; Node >= 22.18 strips types

const failures: string[] = [];
let passed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

function payloadText(content: unknown): string {
  const block = Array.isArray(content) ? content[0] : undefined;
  if (
    block !== null &&
    block !== undefined &&
    typeof block === "object" &&
    "text" in block
  ) {
    return String((block as { text: unknown }).text);
  }
  return JSON.stringify(content);
}

interface RawInit {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
}

/** Raw JSON-RPC initialize over stdio — no SDK client between us and the wire. */
function rawInitialize(): Promise<RawInit> {
  return new Promise<RawInit>((resolve, reject) => {
    const child = spawn(process.execPath, serverArgs, { stdio: ["pipe", "pipe", "inherit"] });
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("raw initialize timed out after 15s"));
    }, 15_000);

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return; // partial line
      const line = buffer.slice(0, newline).trim();
      if (line.length === 0) return;
      let msg: {
        result?: { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
      };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        reject(new Error(`non-JSON on stdout: ${line.slice(0, 100)}`));
        return;
      }
      const result = msg.result;
      if (result?.protocolVersion === undefined || result.serverInfo?.name === undefined) {
        reject(new Error(`unexpected initialize response: ${line.slice(0, 200)}`));
        return;
      }
      clearTimeout(timer);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      child.stdin.end();
      child.on("exit", () =>
        resolve({
          protocolVersion: result.protocolVersion as string,
          serverName: result.serverInfo?.name as string,
          serverVersion: result.serverInfo?.version ?? "?",
        }),
      );
      child.on("error", () => resolve({
        protocolVersion: result.protocolVersion as string,
        serverName: result.serverInfo?.name as string,
        serverVersion: result.serverInfo?.version ?? "?",
      }));
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "raw-stdio-probe", version: "0.0.0" },
        },
      })}\n`,
    );
  });
}

await step("initialize (raw JSON-RPC handshake)", async () => {
  const init = await rawInitialize();
  console.log("== initialize ==");
  console.log(`serverInfo: ${init.serverName} v${init.serverVersion} | protocol: ${init.protocolVersion}`);
  if (init.serverName !== "open-meteo") throw new Error(`unexpected server name ${init.serverName}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(init.protocolVersion)) {
    throw new Error(`unexpected protocol version ${init.protocolVersion}`);
  }
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: serverArgs,
  stderr: "inherit", // server logs stay visible; stdout carries the protocol
});
const client = new Client({ name: "verify-stdio", version: VERSION });

try {
  await client.connect(transport);
} catch (err) {
  console.error(`FAIL SDK connect: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

await step("SDK client handshake + ping", async () => {
  const info = client.getServerVersion();
  if (info === undefined) throw new Error("client never completed initialize");
  await client.ping();
});

let geocoded: { latitude: number; longitude: number } | undefined;

await step("tools/list", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log("== tools/list ==");
  console.log(`${String(names.length)} tools: ${names.join(", ")}`);
  const expected = [
    "geocode_location",
    "get_air_quality",
    "get_current_weather",
    "get_daily_forecast",
    "get_history_weather",
    "get_hourly_forecast",
  ];
  const missing = expected.filter((n) => !names.includes(n));
  if (names.length !== 6 || missing.length > 0) {
    throw new Error(`expected exactly [${expected.join(", ")}], got [${names.join(", ")}]`);
  }
  const notReadOnly = tools.filter((t) => t.annotations?.readOnlyHint !== true);
  if (notReadOnly.length > 0) {
    throw new Error(`tools missing readOnlyHint: ${notReadOnly.map((t) => t.name).join(", ")}`);
  }
});

await step('tools/call: geocode_location {"name":"Reykjavik"}', async () => {
  const result = await client.callTool({
    name: "geocode_location",
    arguments: { name: "Reykjavik" },
  });
  const parsed = JSON.parse(payloadText(result.content)) as {
    count: number;
    results: Array<{ name: string; country: string; latitude: number; longitude: number; timezone: string }>;
  };
  const first = parsed.results[0];
  if (first === undefined || parsed.count < 1) throw new Error("no geocoding results");
  console.log("== tools/call: geocode_location ==");
  console.log(
    `${String(parsed.count)} result: ${first.name}, ${first.country} ` +
      `(${String(first.latitude)}, ${String(first.longitude)}) tz=${first.timezone}`,
  );
  geocoded = { latitude: first.latitude, longitude: first.longitude };
});

await step("tools/call: get_current_weather (live coordinates)", async () => {
  if (geocoded === undefined) throw new Error("skipped: geocode step did not produce coordinates");
  const result = await client.callTool({
    name: "get_current_weather",
    arguments: geocoded,
  });
  const parsed = JSON.parse(payloadText(result.content)) as {
    timezone: string;
    current: { temperature_2m: number; temperature_unit: string; weather_description: string | null };
  };
  console.log("== tools/call: get_current_weather ==");
  console.log(
    `${parsed.timezone}: ${String(parsed.current.temperature_2m)}${parsed.current.temperature_unit}, ` +
      `${parsed.current.weather_description ?? "unknown sky"}`,
  );
  if (typeof parsed.current.temperature_2m !== "number") {
    throw new Error("no temperature in live response");
  }
});

await step("schema violation is rejected cleanly", async () => {
  let message: string;
  try {
    const result = await client.callTool({
      name: "get_current_weather",
      arguments: { latitude: 999, longitude: 0 },
    });
    if (result.isError !== true) throw new Error("call unexpectedly succeeded");
    message = payloadText(result.content);
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e.code !== -32602) {
      throw new Error(`expected InvalidParams (-32602), got ${String(e.code)}: ${String(e.message)}`);
    }
    message = e.message ?? "";
  }
  console.log("== schema violation ==");
  console.log(`rejected as expected: ${message.slice(0, 140)}`);
  if (!/latitude/i.test(message)) throw new Error("error does not name the offending field");
});

await client.close();

console.log("");
if (failures.length > 0) {
  console.error(`VERIFY FAILED: ${String(failures.length)} step(s) failed (${String(passed)} passed)`);
  process.exit(1);
}
console.log(
  `VERIFY OK: ${String(passed)} steps — raw initialize (protocol version), tools/list (6 tools), 2 live tool calls, 1 clean schema-violation error`,
);
