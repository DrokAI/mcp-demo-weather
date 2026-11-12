/**
 * HTTP client for the Open-Meteo APIs with per-endpoint TTL caching.
 *
 * Design notes:
 *
 * - One fixed base URL per Open-Meteo service. Query parameters are typed
 *   and validated here — a tool caller can never redirect this client to
 *   another host, because URLs are never assembled from caller input.
 * - Upstream failures are normalized to `APIError` with an actionable,
 *   LLM-readable message (Open-Meteo usefully returns a `reason` field on
 *   errors, which we surface verbatim).
 * - Successful responses are cached with a per-endpoint TTL tuned to how
 *   often the upstream data actually changes: current observations update
 *   roughly every 15 minutes, so a 10-minute cache loses nothing and keeps
 *   us far inside the free 10,000-calls/day allowance.
 * - `fetch` is injectable so tests stay hermetic (no network, ever).
 */

import { TTLCache } from "./cache.ts";
import { VERSION } from "./version.ts";

export const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
export const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

export const USER_AGENT = `openmeteo-mcp/${VERSION} (+https://github.com/DrokAI/mcp-demo-weather)`;

/** Cache TTLs in seconds, matched to upstream update cadence. */
export const TTL_GEOCODING = 24 * 3600; // place metadata is effectively static
export const TTL_CURRENT = 600; // observations update every ~15 min
export const TTL_FORECAST = 900; // forecasts change slowly
export const TTL_AIR_QUALITY = 1800;
export const TTL_ARCHIVE = 24 * 3600; // archived history is immutable once published

/** Comma-separated Open-Meteo field lists (kept as the API spells them). */
export const CURRENT_FIELDS =
  "temperature_2m,relative_humidity_2m,apparent_temperature,is_day," +
  "precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m";
export const DAILY_FIELDS =
  "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max," +
  "precipitation_sum,precipitation_probability_max,wind_speed_10m_max," +
  "uv_index_max,sunrise,sunset";
export const HOURLY_FIELDS =
  "temperature_2m,apparent_temperature,precipitation_probability," +
  "precipitation,weather_code,wind_speed_10m,is_day";
export const AIR_QUALITY_FIELDS = "us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide";
export const ARCHIVE_DAILY_FIELDS =
  "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum," +
  "snowfall_sum,sunrise,sunset";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** An Open-Meteo request failed. The message is safe to show a caller. */
export class APIError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "APIError";
    this.statusCode = statusCode;
  }
}

export type QueryParams = Record<string, string | number>;

/** Stable cache key for a URL + params (sorted, so order never matters). */
export function cacheKey(url: string, params: QueryParams): string {
  const pairs = Object.entries(params)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${url}?${pairs.map(([k, v]) => `${k}=${v}`).join("&")}`;
}

function checkCoordinates(latitude: number, longitude: number): void {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new APIError("latitude and longitude must be finite numbers.");
  }
  if (latitude < -90 || latitude > 90) {
    throw new APIError(`latitude must be between -90 and 90, got ${String(latitude)}.`);
  }
  if (longitude < -180 || longitude > 180) {
    throw new APIError(`longitude must be between -180 and 180, got ${String(longitude)}.`);
  }
}

export interface OpenMeteoClientOptions {
  cache?: TTLCache;
  /** Network timeout per request (default 10 s). */
  timeoutMs?: number;
  /** Injectable fetch for hermetic tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Small fetch-based wrapper around the four public Open-Meteo services. */
export class OpenMeteoClient {
  readonly cache: TTLCache;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenMeteoClientOptions = {}) {
    this.cache = options.cache ?? new TTLCache(256);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async getJson(url: string, params: QueryParams, ttlSeconds: number): Promise<JsonObject> {
    const key = cacheKey(url, params);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached as JsonObject;

    const target = new URL(url);
    for (const [name, value] of Object.entries(params)) {
      target.searchParams.set(name, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        redirect: "error", // never follow a redirect away from the allowlisted host
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw networkError(err, url, this.timeoutMs);
    }

    if (response.status >= 400) {
      const reason = await upstreamReason(response);
      let message = `Open-Meteo returned HTTP ${String(response.status)}`;
      if (reason !== null) message += `: ${reason}`;
      else message += " — check the tool arguments.";
      throw new APIError(message, response.status);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new APIError(
        "Open-Meteo returned a non-JSON response; the service may be misbehaving. Try again shortly.",
      );
    }
    if (!isJsonObject(data)) {
      throw new APIError(
        "Open-Meteo returned an unexpected response shape; the service may be misbehaving.",
      );
    }
    if (data.error === true) {
      throw new APIError(
        `Open-Meteo rejected the request: ${String(data.reason ?? "unknown error")}`,
      );
    }
    this.cache.set(key, data, ttlSeconds);
    return data;
  }

  // -- Endpoints (one method per Open-Meteo service) -----------------------

  /** Search place names via the Open-Meteo geocoding API. */
  async geocode(name: string, count = 5): Promise<JsonObject> {
    const params: QueryParams = { name, count, language: "en", format: "json" };
    return this.getJson(GEOCODING_URL, params, TTL_GEOCODING);
  }

  /** Current conditions at a coordinate. */
  async currentWeather(latitude: number, longitude: number): Promise<JsonObject> {
    checkCoordinates(latitude, longitude);
    const params: QueryParams = {
      latitude,
      longitude,
      current: CURRENT_FIELDS,
      timezone: "auto",
    };
    return this.getJson(FORECAST_URL, params, TTL_CURRENT);
  }

  /** Daily forecast rows at a coordinate. */
  async dailyForecast(
    latitude: number,
    longitude: number,
    days = 5,
    temperatureUnit: "celsius" | "fahrenheit" = "celsius",
  ): Promise<JsonObject> {
    checkCoordinates(latitude, longitude);
    const params: QueryParams = {
      latitude,
      longitude,
      daily: DAILY_FIELDS,
      forecast_days: days,
      temperature_unit: temperatureUnit,
      timezone: "auto",
    };
    return this.getJson(FORECAST_URL, params, TTL_FORECAST);
  }

  /** Hourly forecast rows at a coordinate, starting at the current hour. */
  async hourlyForecast(latitude: number, longitude: number, hours = 24): Promise<JsonObject> {
    checkCoordinates(latitude, longitude);
    const params: QueryParams = {
      latitude,
      longitude,
      hourly: HOURLY_FIELDS,
      forecast_hours: hours,
      timezone: "auto",
    };
    return this.getJson(FORECAST_URL, params, TTL_FORECAST);
  }

  /** Hourly air-quality rows (US AQI plus key pollutants). */
  async airQualityHourly(latitude: number, longitude: number, hours = 24): Promise<JsonObject> {
    checkCoordinates(latitude, longitude);
    const params: QueryParams = {
      latitude,
      longitude,
      hourly: AIR_QUALITY_FIELDS,
      forecast_hours: hours,
      timezone: "auto",
    };
    return this.getJson(AIR_QUALITY_URL, params, TTL_AIR_QUALITY);
  }

  /** Historical daily weather from the Open-Meteo archive. */
  async archiveDaily(
    latitude: number,
    longitude: number,
    startDate: string,
    endDate: string,
  ): Promise<JsonObject> {
    checkCoordinates(latitude, longitude);
    const params: QueryParams = {
      latitude,
      longitude,
      daily: ARCHIVE_DAILY_FIELDS,
      start_date: startDate,
      end_date: endDate,
      timezone: "auto",
    };
    return this.getJson(ARCHIVE_URL, params, TTL_ARCHIVE);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract Open-Meteo's own `reason` text from an error response, if any. */
async function upstreamReason(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (isJsonObject(body) && typeof body.reason === "string" && body.reason.length > 0) {
      return body.reason;
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}

function networkError(err: unknown, url: string, timeoutMs: number): APIError {
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new APIError(
      `Open-Meteo request timed out after ${String(Math.round(timeoutMs / 1000))}s; ` +
        "the service may be busy — retrying shortly usually works.",
    );
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new APIError(`Could not reach Open-Meteo (${url}): ${detail}`);
}
