# openmeteo-mcp

A reference-quality demo MCP server: **six narrow, well-typed weather tools**
over the free, **keyless** [Open-Meteo](https://open-meteo.com/) API —
written in **TypeScript** on the **official
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)**.

This repo exists to demonstrate what senior MCP server craft looks like —
zod input schemas with range constraints, deliberate response sizing,
per-endpoint TTL caching matched to upstream update cadence, error messages
written for an LLM caller, hermetic tests, and CI. It is intentionally small
enough to read in one sitting (`src/` is ~840 lines, zero build step).

Runs natively on **Bun** (first-class) and **Node ≥ 22.18** (native TS type
stripping) — no compile step, no `dist/` to keep in sync.

## Why Open-Meteo?

- **Zero credentials.** No API key, no signup, no env vars — anyone can run
  this server in under a minute. For a public demo, an auth-free upstream
  removes the single biggest source of setup friction and secret-handling
  risk.
- **Real utility, four distinct services.** Geocoding, forecast, air quality,
  and a historical archive (ERA5, back to 1940) under one provider. That
  variety is exactly what rewards *narrow-tool* decomposition instead of one
  god-tool with mode flags.
- **Well-behaved API surface.** Stable JSON, per-field units, and a
  machine-readable `reason` on errors — which this server surfaces verbatim
  so callers get actionable messages instead of opaque HTTP codes.
- **Generous free tier** (10,000 calls/day) — and this server stays far below
  it thanks to TTL caching.

## Tools

| Tool | Purpose | Key inputs (validated) | Hard caps | Cache TTL |
|---|---|---|---|---|
| `geocode_location` | Place name → coordinates, country, timezone, population | `name` (1–100 chars), `max_results` (1–10) | 10 results | 24 h |
| `get_current_weather` | Current conditions + plain-language sky description | `latitude` (−90…90), `longitude` (−180…180) | — | 10 min |
| `get_daily_forecast` | Daily rows: highs/lows, precipitation, wind, UV, sunrise/sunset | coords, `days` (1–10), `temperature_unit` (`celsius`\|`fahrenheit`) | 10 days | 15 min |
| `get_hourly_forecast` | Hourly rows: temp, apparent temp, precip probability/amount, wind | coords, `hours` (1–72) | 72 h | 15 min |
| `get_air_quality` | US EPA AQI + PM2.5, PM10, ozone, NO₂ | coords, `hours` (1–48) | 48 h | 30 min |
| `get_historical_weather` | Archived daily weather (≈1940 → ~5 days ago) | coords, `start_date`/`end_date` (ISO `YYYY-MM-DD`) | 366 days/call | 24 h |

Every tool is annotated `readOnlyHint = true`, `destructiveHint = false`,
`idempotentHint = true`, `openWorldHint = true`.

### Design principles

- **Narrow tools, not a god-tool.** One tool per question a user actually
  asks. Clients see small schemas; the LLM can't pick a wrong "mode".
- **Validation at the schema.** zod ranges, string lengths, regex date
  patterns, and enum units are declared in the tool signature, so invalid
  arguments are rejected *before any network call* — and the JSON Schema is
  visible to clients in `tools/list`.
- **Response size discipline.** Columnar API arrays are zipped into compact
  row objects with units attached, lists are capped (and *defensively
  re-sliced* even if upstream ignores the cap), geocoding drops junk fields
  like `postcodes`, and WMO weather codes are expanded inline to
  `weather_description` so no second lookup is needed.
- **TTL cache tuned to data cadence.** Current observations change every
  ~15 min → 10 min TTL; forecasts → 15 min; place metadata and archive data
  are effectively immutable → 24 h. Bounded at 256 entries with
  expire-first/FIFO eviction.
- **Errors written for an LLM.** Upstream `reason` text is surfaced verbatim;
  timeouts/network failures explain what happened and suggest a retry;
  validation failures name the field and the constraint (`MCP error -32602`).

## Quickstart

Runs in under a minute. With [Bun](https://bun.sh) installed:

```bash
# zero-install smoke — clones, installs, and starts the stdio server
bunx github:DrokAI/mcp-demo-weather
```

or the classic way (also works with `npm install` on Node ≥ 22.18):

```bash
git clone https://github.com/DrokAI/mcp-demo-weather
cd mcp-demo-weather
bun install            # or: npm install

bun run test           # hermetic suite (71 tests, no network)
bun run verify         # LIVE check: spawns the server over stdio,
                       # handshake, tools/list, 2 real calls, 1 clean error
bun run start          # serve MCP over stdio
bun run typecheck      # tsc --noEmit (TypeScript 7)
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "open-meteo": {
      "command": "bun",
      "args": ["/absolute/path/to/mcp-demo-weather/bin/openmeteo-mcp.js"]
    }
  }
}
```

On Node ≥ 22.18, swap `"command": "bun"` for `"command": "node"` (same args).
Zero-clone alternative: `"command": "bunx", "args": ["github:DrokAI/mcp-demo-weather"]`.

### Cursor

`~/.cursor/mcp.json` (same shape):

```json
{
  "mcpServers": {
    "open-meteo": {
      "command": "bun",
      "args": ["/absolute/path/to/mcp-demo-weather/bin/openmeteo-mcp.js"]
    }
  }
}
```

## Architecture

```
src/
├── server.ts    # McpServer (official SDK) + the 6 tools: zod-typed inputs,
│                # response shaping/truncation, APIError → isError mapping
├── client.ts    # fetch wrapper: one fixed base URL per Open-Meteo service,
│                # coordinate validation, per-endpoint TTL cache wiring,
│                # error normalization (timeout / HTTP / reason passthrough)
├── cache.ts     # TTLCache: bounded (256), lazy expiry,
│                # expire-first-then-FIFO eviction (~90 lines, no deps)
├── wmo.ts       # WMO 4677 weather-code → plain-language table
├── version.ts   # single version constant
└── index.ts     # entry: buildServer() + StdioServerTransport
bin/openmeteo-mcp.js   # shebang launcher (bun or node ≥ 22.18)
```

Request flow: `tools/call` → zod schema validation (rejects before any
network) → `OpenMeteoClient` (cache hit? return) → `fetch` GET to a fixed
allowlisted host → response normalized → zipped, truncated, annotated rows →
compact JSON back to the client. Logs go to stderr only (stdout carries the
protocol).

```
tests/                      # hermetic: a fake fetch injects every upstream
                            # response; server+client connect over an
                            # in-memory transport pair (71 tests)
scripts/verify-stdio.ts     # LIVE smoke: raw initialize + SDK client,
                            # tools/list, real tool calls, clean error path
.github/workflows/ci.yml    # tsc --noEmit + vitest on Bun and Node 22
```

## Security posture

- **Read-only.** Every tool is a lookup; nothing writes, executes, or
  retains user data. Annotations declare this machine-readably.
- **No credentials, no env, no config.** There is nothing to leak; the
  server works with a completely empty environment.
- **No URL injection surface.** Base URLs are module constants; caller input
  only ever becomes typed query parameters (numbers/enums/date patterns).
  A tool call cannot redirect the server to another host (`redirect:
  "error"` — redirects are refused, not followed).
- **No tool-poisoning surface.** Tool names, descriptions, and annotations
  are static code — never derived from upstream responses or user input.
- **Bounded in and out.** Input ranges at the schema; output caps (72 h /
  10 days / 366-day archive spans) and defensive re-slicing keep responses
  context-window sized.
- **Timeboxed network.** 10 s `AbortSignal.timeout`, no redirects, no
  retries with unclear errors — no hanging tool calls.
- **stdio discipline.** Protocol on stdout, logs on stderr; no files,
  subprocesses, or shell anywhere in the codebase.

## Verification

Both of these were run against this commit:

```console
$ bun run test
 Test Files  3 passed (3)
      Tests  71 passed (71)

$ bun run verify
== initialize ==
serverInfo: open-meteo v0.2.0 | protocol: 2025-11-25
== tools/list ==
6 tools: geocode_location, get_air_quality, get_current_weather, get_daily_forecast, get_history_weather, get_hourly_forecast
== tools/call: geocode_location ==
2 results: Reykjavik, Iceland (64.13548, -21.89541) tz=Atlantic/Reykjavik
== tools/call: get_current_weather ==
Atlantic/Reykjavik: -0.3°C, Moderate snow fall
== schema violation ==
rejected as expected: MCP error -32602: Input validation error: Invalid arguments for tool get_current_weather: Too big: expected number to be <=90 at latitude

VERIFY OK: 6 steps — raw initialize (protocol version), tools/list (6 tools), 2 live tool calls, 1 clean schema-violation error
```

MCP Inspector smoke also passes:

```console
$ npx @modelcontextprotocol/inspector --cli node bin/openmeteo-mcp.js --method tools/list
# full tool schemas + annotations (readOnlyHint: true, ...)
$ npx @modelcontextprotocol/inspector --cli node bin/openmeteo-mcp.js \
    --method tools/call --tool-name geocode_location --tool-arg name=Osaka
# 5 compact place rows
```

CI runs typecheck + the same hermetic suite on every push/PR, on Bun and
Node 22.

## License

[MIT](LICENSE) © 2026 Drok AI. Weather data by [Open-Meteo](https://open-meteo.com/)
(free for non-commercial use; see their terms).
