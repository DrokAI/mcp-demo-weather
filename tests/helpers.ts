/** Shared hermetic-test helpers: fake upstream fetch, fixtures, transport pair. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";
import { OpenMeteoClient } from "../src/client.ts";
import { TTLCache } from "../src/cache.ts";
import { buildServer } from "../src/server.ts";

export interface RecordedCall {
  url: URL;
  init: RequestInit;
}

/**
 * Build an injectable `fetch` that records every call and delegates to
 * `handler`. Tests never touch the network.
 */
export function fakeFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): typeof fetch & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url =
      input instanceof URL
        ? input
        : typeof input === "string"
          ? new URL(input)
          : new URL(input.url);
    const call = { url, init: init ?? {} };
    calls.push(call);
    return handler(call);
  };
  return Object.assign(impl, { calls }) as typeof fetch & { calls: RecordedCall[] };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Connect a real MCP server + client over an in-memory transport pair. */
export async function makePair(fetchImpl: typeof fetch): Promise<Client> {
  const upstream = new OpenMeteoClient({ fetchImpl, cache: new TTLCache(256) });
  const server = buildServer(upstream);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: CallToolResult): string {
  const block = result.content?.[0];
  if (block !== undefined && block.type === "text") return (block as TextContent).text;
  return JSON.stringify(result.content);
}

/** Decode the JSON payload of a successful tool result. */
export async function callToolOk(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ [key: string]: unknown }> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallToolResult;
  expect(result.isError, `tool ${name} unexpectedly failed: ${textOf(result)}`).not.toBe(true);
  return JSON.parse(textOf(result)) as { [key: string]: unknown };
}

/**
 * Call a tool expecting failure. Returns the error text whether the SDK
 * rejects the call (schema violations throw McpError -32602) or the handler
 * returns an isError result (upstream failures).
 */
export async function callToolErr(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  let result: CallToolResult;
  try {
    result = (await client.callTool({ name, arguments: args })) as unknown as CallToolResult;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (result.isError !== true) {
    throw new Error(`expected tool ${name} to fail, got: ${textOf(result)}`);
  }
  return textOf(result);
}

// ---------------------------------------------------------------------------
// Fixtures: minimal, realistic Open-Meteo response shapes.
// ---------------------------------------------------------------------------

export const GEOCODE_REYKJAVIK = {
  results: [
    {
      id: 3413829,
      name: "Reykjavik",
      latitude: 64.13548,
      longitude: -21.89541,
      elevation: 61,
      country: "Iceland",
      country_code: "IS",
      admin1: "Capital Region",
      timezone: "Atlantic/Reykjavik",
      population: 123246,
      postcodes: ["101", "104"],
      feature_code: "PPLC",
    },
  ],
};

export const CURRENT_WEATHER = {
  latitude: 64.13548,
  longitude: -21.89541,
  timezone: "Atlantic/Reykjavik",
  elevation: 61,
  current: {
    time: "2026-11-12T10:30",
    temperature_2m: -0.7,
    relative_humidity_2m: 82,
    apparent_temperature: -4.1,
    is_day: 1,
    precipitation: 0,
    weather_code: 0,
    wind_speed_10m: 14.2,
    wind_direction_10m: 320,
    wind_gusts_10m: 31.3,
  },
  current_units: {
    temperature_2m: "°C",
    apparent_temperature: "°C",
    precipitation: "mm",
    wind_speed_10m: "km/h",
  },
};

function isoDaysFromNow(count: number, hour: string): string[] {
  return Array.from({ length: count }, (_, i) => `2026-11-${String(12 + i).padStart(2, "0")}T${hour}`);
}

export const DAILY_FORECAST = {
  latitude: 64.13548,
  longitude: -21.89541,
  timezone: "Atlantic/Reykjavik",
  daily: {
    // 14 rows on purpose: upstream ignoring forecast_days must still be
    // truncated by the server (defensive re-slicing).
    time: isoDaysFromNow(14, "00:00").map((t) => t.slice(0, 10)),
    weather_code: [0, 1, 2, 3, 45, 51, 61, 63, 71, 80, 95, 96, 99, 0],
    temperature_2m_max: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    temperature_2m_min: [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    precipitation_sum: [0, 0.1, 0.4, 1.2, 0, 0.2, 3.4, 5.6, 7.8, 0, 0, 0.5, 2.2, 0],
    precipitation_probability_max: [0, 10, 30, 70, 5, 20, 90, 95, 100, 0, 0, 40, 80, 0],
    wind_speed_10m_max: [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36],
    uv_index_max: [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8],
    sunrise: isoDaysFromNow(14, "09:30"),
    sunset: isoDaysFromNow(14, "17:00"),
  },
  daily_units: {
    temperature_2m_max: "°C",
    temperature_2m_min: "°C",
    precipitation_sum: "mm",
    wind_speed_10m_max: "km/h",
  },
};

export const HOURLY_FORECAST = {
  latitude: 64.13548,
  longitude: -21.89541,
  timezone: "Atlantic/Reykjavik",
  hourly: {
    time: isoDaysFromNow(10, "00:00"),
    temperature_2m: [-1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    apparent_temperature: [-4, -3.5, -3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5],
    precipitation_probability: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45],
    precipitation: [0, 0, 0.1, 0, 0, 0.2, 0, 0, 0.3, 0],
    weather_code: [0, 1, 2, 3, 45, 51, 61, 63, 71, 80],
    wind_speed_10m: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    is_day: [0, 0, 0, 1, 1, 1, 1, 1, 0, 0],
  },
  hourly_units: { temperature_2m: "°C", precipitation: "mm", wind_speed_10m: "km/h" },
};

export const AIR_QUALITY = {
  latitude: 64.13548,
  longitude: -21.89541,
  timezone: "Atlantic/Reykjavik",
  hourly: {
    time: isoDaysFromNow(5, "00:00"),
    us_aqi: [12, 14, 15, 13, 11],
    pm2_5: [2.9, 3.4, 3.6, 3.1, 2.7],
    pm10: [5.1, 6.0, 6.4, 5.5, 4.9],
    ozone: [58, 60, 61, 59, 57],
    nitrogen_dioxide: [3.2, 4.1, 4.8, 3.9, 2.9],
  },
  hourly_units: { pm2_5: "µg/m³", pm10: "µg/m³" },
};

export const ARCHIVE_DAILY = {
  latitude: 64.13548,
  longitude: -21.89541,
  timezone: "Atlantic/Reykjavik",
  daily: {
    time: ["2026-01-01", "2026-01-02", "2026-01-03"],
    weather_code: [61, 3, 71],
    temperature_2m_max: [4.2, 3.1, 1.5],
    temperature_2m_min: [-1.0, -2.2, -3.4],
    precipitation_sum: [6.1, 0.4, 8.0],
    snowfall_sum: [0, 0, 4.2],
    sunrise: ["2026-01-01T11:19", "2026-01-02T11:19", "2026-01-03T11:18"],
    sunset: ["2026-01-01T15:45", "2026-01-02T15:46", "2026-01-03T15:48"],
  },
  daily_units: { temperature_2m_max: "°C", precipitation_sum: "mm" },
};
