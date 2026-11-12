/**
 * MCP server exposing narrow, well-typed tools over the keyless Open-Meteo API.
 *
 * Design goals (this repo is a reference implementation):
 *
 * - One tool per question a user actually asks — no god-tool with mode flags.
 * - Every input is typed with range constraints, so bad arguments are
 *   rejected by the schema before any network call happens.
 * - Responses are compact, row-oriented JSON with units attached — sized
 *   for an LLM context window, never a raw API firehose.
 * - Upstream failures become `isError` tool results written for an LLM
 *   caller: what failed, why, and what to try instead.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { APIError, type JsonObject, OpenMeteoClient } from "./client.ts";
import { describeWeatherCode } from "./wmo.ts";
import { VERSION } from "./version.ts";

/** Every tool here is a pure lookup: read-only, non-destructive, idempotent,
 *  but it does reach an external service (openWorldHint). */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Hard caps that keep responses LLM-sized. Documented in the README tool table. */
export const MAX_DAILY_DAYS = 10;
export const MAX_HOURLY_HOURS = 72;
export const MAX_AQ_HOURS = 48;
export const MAX_ARCHIVE_DAYS = 366;

const latitudeSchema = z
  .number()
  .min(-90)
  .max(90)
  .describe("Latitude in decimal degrees (-90 to 90).");
const longitudeSchema = z
  .number()
  .min(-180)
  .max(180)
  .describe("Longitude in decimal degrees (-180 to 180).");

/**
 * Zip columnar series into row dicts, truncated to `limit`.
 *
 * Open-Meteo returns time series as parallel arrays ({"time": [...],
 * "temperature_2m": [...]}); rows are what an LLM can quote directly. The
 * limit is applied defensively even if the upstream ignored our request.
 */
export function rows(
  columns: unknown,
  limit?: number,
): Array<{ [key: string]: unknown }> {
  if (typeof columns !== "object" || columns === null || Array.isArray(columns)) return [];
  const series = new Map<string, unknown[]>();
  for (const [key, value] of Object.entries(columns)) {
    if (Array.isArray(value)) series.set(key, value);
  }
  if (series.size === 0) return [];
  let length = Number.POSITIVE_INFINITY;
  for (const values of series.values()) length = Math.min(length, values.length);
  if (limit !== undefined) length = Math.min(length, limit);
  const out: Array<{ [key: string]: unknown }> = [];
  for (let i = 0; i < length; i += 1) {
    const row: { [key: string]: unknown } = {};
    for (const [key, values] of series) row[key] = values[i];
    out.push(row);
  }
  return out;
}

/** Attach a plain-language description to a row carrying weather_code. */
function annotateSky(row: { [key: string]: unknown }): { [key: string]: unknown } {
  row.weather_description = describeWeatherCode(
    typeof row.weather_code === "number" ? row.weather_code : undefined,
  );
  return row;
}

/** Wrap handler failures as LLM-readable isError tool results. */
function errorResult(toolName: string, err: unknown) {
  const message = err instanceof APIError ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }],
  };
}

/** Parse a strict `YYYY-MM-DD` calendar date (UTC); null if invalid. */
export function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null; // e.g. 2026-02-30
  }
  return date;
}

export function buildServer(client: OpenMeteoClient = new OpenMeteoClient()): McpServer {
  const server = new McpServer(
    { name: "open-meteo", version: VERSION },
    {
      instructions:
        "Weather and climate tools backed by the free, keyless Open-Meteo API. " +
        "Start with geocode_location if you only have a place name; its " +
        "latitude/longitude feed every other tool. All tools are read-only and " +
        "safe to retry — identical calls within the cache TTL return cached data.",
    },
  );

  server.registerTool(
    "geocode_location",
    {
      title: "Geocode location",
      description:
        "Resolve a place name to coordinates, country, timezone and population. " +
        "Call this first when you only have a place name, then pass the returned " +
        "latitude/longitude into any weather tool.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(100)
          .describe("Place name to search for, e.g. 'Berlin', 'Austin, TX', 'Kyoto'."),
        max_results: z.number().int().min(1).max(10).describe("Maximum matches to return (1-10).").default(5),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ name, max_results }) => {
      try {
        const data = await client.geocode(name, max_results ?? 5);
        const raw = Array.isArray(data.results) ? data.results : [];
        const mapped = raw
          .filter((r): r is JsonObject => typeof r === "object" && r !== null && !Array.isArray(r))
          .slice(0, max_results ?? 5)
          .map((r) => ({
            name: r.name,
            country: r.country,
            country_code: r.country_code,
            admin1: r.admin1,
            latitude: r.latitude,
            longitude: r.longitude,
            elevation_m: r.elevation,
            timezone: r.timezone,
            population: r.population,
          }));
        const output: { [key: string]: unknown } = {
          query: name,
          count: mapped.length,
          results: mapped,
        };
        if (mapped.length === 0) {
          output.hint =
            "No place matched. Try a more common spelling, a bigger nearby city, " +
            "or add a country/region such as 'Springfield, IL'.";
        }
        return { content: [{ type: "text", text: JSON.stringify(output) }] };
      } catch (err) {
        return errorResult("geocode_location", err);
      }
    },
  );

  server.registerTool(
    "get_current_weather",
    {
      title: "Get current weather",
      description:
        "Current weather at a coordinate: temperature, apparent temperature, " +
        "humidity, precipitation, wind, and a plain-language sky description.",
      inputSchema: { latitude: latitudeSchema, longitude: longitudeSchema },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ latitude, longitude }) => {
      try {
        const data = await client.currentWeather(latitude, longitude);
        const current = (typeof data.current === "object" && data.current !== null
          ? (data.current as JsonObject)
          : {}) as { [key: string]: unknown };
        const units = (typeof data.current_units === "object" && data.current_units !== null
          ? (data.current_units as JsonObject)
          : {}) as { [key: string]: unknown };
        const code = typeof current.weather_code === "number" ? current.weather_code : undefined;
        const payload = {
          latitude: data.latitude ?? latitude,
          longitude: data.longitude ?? longitude,
          timezone: data.timezone,
          elevation_m: data.elevation,
          current: {
            time: current.time,
            temperature_2m: current.temperature_2m,
            temperature_unit: units.temperature_2m,
            apparent_temperature: current.apparent_temperature,
            apparent_temperature_unit: units.apparent_temperature,
            relative_humidity_2m: current.relative_humidity_2m,
            precipitation: current.precipitation,
            precipitation_unit: units.precipitation,
            weather_code: code,
            weather_description: describeWeatherCode(code),
            wind_speed_10m: current.wind_speed_10m,
            wind_speed_unit: units.wind_speed_10m,
            wind_direction_10m: current.wind_direction_10m,
            wind_gusts_10m: current.wind_gusts_10m,
            is_day: current.is_day === 1 || current.is_day === true,
          },
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (err) {
        return errorResult("get_current_weather", err);
      }
    },
  );

  server.registerTool(
    "get_daily_forecast",
    {
      title: "Get daily forecast",
      description:
        "Day-by-day forecast (up to 10 days): highs/lows, precipitation amount and " +
        "probability, max wind, UV index, and sunrise/sunset, in local time.",
      inputSchema: {
        latitude: latitudeSchema,
        longitude: longitudeSchema,
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_DAILY_DAYS)
          .describe("Number of forecast days to return (1-10), starting today.")
          .default(5),
        temperature_unit: z
          .enum(["celsius", "fahrenheit"])
          .describe("Unit for reported temperatures.")
          .default("celsius"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ latitude, longitude, days, temperature_unit }) => {
      const dayCount = days ?? 5;
      const unit = temperature_unit ?? "celsius";
      try {
        const data = await client.dailyForecast(latitude, longitude, dayCount, unit);
        const payload = {
          latitude: data.latitude ?? latitude,
          longitude: data.longitude ?? longitude,
          timezone: data.timezone,
          temperature_unit: unit,
          units: data.daily_units ?? {},
          days: rows(data.daily, dayCount).map(annotateSky),
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (err) {
        return errorResult("get_daily_forecast", err);
      }
    },
  );

  server.registerTool(
    "get_hourly_forecast",
    {
      title: "Get hourly forecast",
      description:
        "Hour-by-hour forecast (up to 72 hours): temperature, apparent temperature, " +
        "precipitation probability and amount, wind, and sky description.",
      inputSchema: {
        latitude: latitudeSchema,
        longitude: longitudeSchema,
        hours: z
          .number()
          .int()
          .min(1)
          .max(MAX_HOURLY_HOURS)
          .describe("Number of hours to return (1-72), starting at the current hour.")
          .default(24),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ latitude, longitude, hours }) => {
      const hourCount = hours ?? 24;
      try {
        const data = await client.hourlyForecast(latitude, longitude, hourCount);
        const zipped = rows(data.hourly, hourCount).map(annotateSky);
        const payload = {
          latitude: data.latitude ?? latitude,
          longitude: data.longitude ?? longitude,
          timezone: data.timezone,
          units: data.hourly_units ?? {},
          hour_count: zipped.length,
          hours: zipped,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (err) {
        return errorResult("get_hourly_forecast", err);
      }
    },
  );

  server.registerTool(
    "get_air_quality",
    {
      title: "Get air quality",
      description:
        "Hourly air quality (up to 48 hours): US EPA AQI plus PM2.5, PM10, ozone " +
        "and NO2 concentrations.",
      inputSchema: {
        latitude: latitudeSchema,
        longitude: longitudeSchema,
        hours: z
          .number()
          .int()
          .min(1)
          .max(MAX_AQ_HOURS)
          .describe("Number of hours to return (1-48).")
          .default(24),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ latitude, longitude, hours }) => {
      const hourCount = hours ?? 24;
      try {
        const data = await client.airQualityHourly(latitude, longitude, hourCount);
        const zipped = rows(data.hourly, hourCount);
        const payload = {
          latitude: data.latitude ?? latitude,
          longitude: data.longitude ?? longitude,
          timezone: data.timezone,
          units: data.hourly_units ?? {},
          hour_count: zipped.length,
          hours: zipped,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (err) {
        return errorResult("get_air_quality", err);
      }
    },
  );

  server.registerTool(
    "get_history_weather",
    {
      title: "Get historical weather",
      description:
        "Historical daily weather from the Open-Meteo archive (about 1950 to " +
        "roughly five days ago): highs/lows, precipitation, snowfall and sky " +
        "conditions. Ranges are capped at 366 days per call.",
      inputSchema: {
        latitude: latitudeSchema,
        longitude: longitudeSchema,
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Start date, ISO format YYYY-MM-DD."),
        end_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("End date (inclusive), ISO format YYYY-MM-DD."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ latitude, longitude, start_date, end_date }) => {
      const invalid = (why: string) => errorResult("get_history_weather", new Error(why));
      const start = parseIsoDate(start_date);
      const end = parseIsoDate(end_date);
      if (start === null || end === null) {
        return invalid(`Dates must be valid ISO calendar dates (YYYY-MM-DD): got start_date=${start_date}, end_date=${end_date}.`);
      }
      if (end.getTime() < start.getTime()) {
        return invalid(`end_date (${end_date}) is before start_date (${start_date}).`);
      }
      const span = Math.round((end.getTime() - start.getTime()) / 86_400_000);
      if (span > MAX_ARCHIVE_DAYS) {
        return invalid(
          `The requested range is ${String(span)} days; the maximum is ${String(MAX_ARCHIVE_DAYS)}. ` +
            "Split longer research into consecutive calls.",
        );
      }
      try {
        const data = await client.archiveDaily(latitude, longitude, start_date, end_date);
        const payload = {
          latitude: data.latitude ?? latitude,
          longitude: data.longitude ?? longitude,
          timezone: data.timezone,
          start_date,
          end_date,
          units: data.daily_units ?? {},
          day_count: rows(data.daily).length,
          days: rows(data.daily).map(annotateSky),
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (err) {
        return errorResult("get_history_weather", err);
      }
    },
  );

  return server;
}
