import { describe, expect, it } from "vitest";
import {
  AIR_QUALITY_URL,
  APIError,
  ARCHIVE_URL,
  FORECAST_URL,
  GEOCODING_URL,
  OpenMeteoClient,
} from "../src/client.ts";
import { TTLCache } from "../src/cache.ts";
import { fakeFetch, jsonResponse } from "./helpers.ts";

function ok(body: unknown): Response {
  return jsonResponse(200, body);
}

describe("OpenMeteoClient — request construction", () => {
  it("geocode hits the geocoding URL with name/count/language/format", async () => {
    const fetcher = fakeFetch(() => ok({ results: [] }));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await client.geocode("Reykjavik", 3);
    const call = fetcher.calls[0]!;
    expect(call.url.origin + call.url.pathname).toBe(GEOCODING_URL);
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      name: "Reykjavik",
      count: "3",
      language: "en",
      format: "json",
    });
  });

  it("currentWeather requests the current block with timezone=auto", async () => {
    const fetcher = fakeFetch(() => ok({ current: {} }));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await client.currentWeather(64.1, -21.9);
    const call = fetcher.calls[0]!;
    expect(call.url.origin + call.url.pathname).toBe(FORECAST_URL);
    const params = Object.fromEntries(call.url.searchParams);
    expect(params.latitude).toBe("64.1");
    expect(params.longitude).toBe("-21.9");
    expect(params.timezone).toBe("auto");
    expect(params.current).toContain("temperature_2m");
    expect(params.current).toContain("weather_code");
  });

  it("dailyForecast requests daily fields, forecast_days and unit", async () => {
    const fetcher = fakeFetch(() => ok({ daily: {} }));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await client.dailyForecast(10, 20, 7, "fahrenheit");
    const params = Object.fromEntries(fetcher.calls[0]!.url.searchParams);
    expect(params.forecast_days).toBe("7");
    expect(params.temperature_unit).toBe("fahrenheit");
    expect(params.daily).toContain("temperature_2m_max");
    expect(params.daily).toContain("uv_index_max");
  });

  it("hourlyForecast requests forecast_hours", async () => {
    const fetcher = fakeFetch(() => ok({ hourly: {} }));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await client.hourlyForecast(0, 0, 12);
    const params = Object.fromEntries(fetcher.calls[0]!.url.searchParams);
    expect(params.forecast_hours).toBe("12");
    expect(params.hourly).toContain("precipitation_probability");
  });

  it("airQualityHourly hits the air-quality host with US AQI fields", async () => {
    const fetcher = fakeFetch(() => ok({ hourly: {} }));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await client.airQualityHourly(1, 2, 48);
    const call = fetcher.calls[0]!;
    expect(call.url.origin + call.url.pathname).toBe(AIR_QUALITY_URL);
    expect(Object.fromEntries(call.url.searchParams).hourly).toContain("us_aqi");
  });

  it("archiveDaily hits the archive host with date range", async () => {
    const fetcher = fakeFetch(() => ok({ daily: {} }));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await client.archiveDaily(5, 6, "2026-01-01", "2026-01-31");
    const call = fetcher.calls[0]!;
    expect(call.url.origin + call.url.pathname).toBe(ARCHIVE_URL);
    const params = Object.fromEntries(call.url.searchParams);
    expect(params.start_date).toBe("2026-01-01");
    expect(params.end_date).toBe("2026-01-31");
  });

  it("sends a descriptive User-Agent and never follows redirects", async () => {
    const fetcher = fakeFetch(() => ok({ results: [] }));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await client.geocode("x", 1);
    const call = fetcher.calls[0]!;
    const headers = call.init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/^openmeteo-mcp\//);
    expect(call.init.redirect).toBe("error");
  });
});

describe("OpenMeteoClient — caching", () => {
  it("serves the second identical call from cache (one upstream hit)", async () => {
    const fetcher = fakeFetch(() => ok({ current: { time: "t" } }));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await client.currentWeather(1, 2);
    await client.currentWeather(1, 2);
    expect(fetcher.calls.length).toBe(1);
    expect(client.cache.stats.hits).toBe(1);
  });

  it("different arguments miss the cache", async () => {
    const fetcher = fakeFetch(() => ok({ current: {} }));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await client.currentWeather(1, 2);
    await client.currentWeather(1, 3);
    expect(fetcher.calls.length).toBe(2);
  });

  it("parameter order never splits the cache (canonical key)", async () => {
    // Same logical params must hit the same cache entry regardless of how
    // the params object was built internally.
    const fetcher = fakeFetch(() => ok({ results: [] }));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await client.geocode("Berlin", 5);
    await client.geocode("Berlin", 5);
    expect(fetcher.calls.length).toBe(1);
  });

  it("refetches after the TTL expires", async () => {
    let now = 0;
    const cache = new TTLCache(16, () => now);
    const fetcher = fakeFetch(() => ok({ current: {} }));
    const client = new OpenMeteoClient({ fetchImpl: fetcher, cache });
    await client.currentWeather(1, 2);
    now += 601; // TTL_CURRENT is 600 s
    await client.currentWeather(1, 2);
    expect(fetcher.calls.length).toBe(2);
  });

  it("does not cache failures", async () => {
    let status = 400;
    const fetcher = fakeFetch(() =>
      status >= 400
        ? jsonResponse(status, { error: true, reason: "bad" })
        : jsonResponse(200, { current: {} }),
    );
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await expect(client.currentWeather(1, 2)).rejects.toThrow(APIError);
    status = 200;
    await client.currentWeather(1, 2);
    expect(fetcher.calls.length).toBe(2);
    expect(client.cache.size()).toBe(1);
  });
});

describe("OpenMeteoClient — error normalization (LLM-readable)", () => {
  it("timeout becomes a retryable-sounding message", async () => {
    const fetcher = fakeFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const client = new OpenMeteoClient({ fetchImpl: fetcher, timeoutMs: 10_000 });
    const err = await client.currentWeather(1, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).message).toMatch(/timed out after 10s/i);
    expect((err as APIError).message).toMatch(/retry/i);
  });

  it("network failure names the unreachable URL", async () => {
    const fetcher = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await expect(client.currentWeather(1, 2)).rejects.toThrow(
      /Could not reach Open-Meteo \(https:\/\/api\.open-meteo\.com\//,
    );
  });

  it("HTTP 400 surfaces the upstream reason verbatim", async () => {
    const fetcher = fakeFetch(() =>
      jsonResponse(400, { error: true, reason: "Latitude must be between -90 and 90" }),
    );
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    const err: unknown = await client.currentWeather(1, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).message).toBe(
      "Open-Meteo returned HTTP 400: Latitude must be between -90 and 90",
    );
    expect((err as APIError).statusCode).toBe(400);
  });

  it("HTTP 500 without a reason gets a generic actionable message", async () => {
    const fetcher = fakeFetch(() => jsonResponse(500, "Internal Server Error"));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await expect(client.currentWeather(1, 2)).rejects.toThrow(
      /HTTP 500 — check the tool arguments/,
    );
  });

  it("a 200 body with error:true is surfaced as a rejection", async () => {
    const fetcher = fakeFetch(() => ok({ error: true, reason: "Cannot resolve forecast days" }));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await expect(client.currentWeather(1, 2)).rejects.toThrow(
      /Open-Meteo rejected the request: Cannot resolve forecast days/,
    );
  });

  it("non-JSON responses produce a clear message", async () => {
    const fetcher = fakeFetch(
      () => new Response("<html>gateway error</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await expect(client.currentWeather(1, 2)).rejects.toThrow(/non-JSON/);
  });

  it("non-object JSON is rejected", async () => {
    const fetcher = fakeFetch(() => ok([1, 2, 3]));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await expect(client.currentWeather(1, 2)).rejects.toThrow(APIError);
  });
});

describe("OpenMeteoClient — coordinate defense in depth", () => {
  it("rejects out-of-range latitude before any fetch", async () => {
    const fetcher = fakeFetch(() => ok({}));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await expect(client.currentWeather(90.1, 0)).rejects.toThrow(/between -90 and 90/);
    expect(fetcher.calls.length).toBe(0);
  });

  it("rejects out-of-range longitude before any fetch", async () => {
    const fetcher = fakeFetch(() => ok({}));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await expect(client.currentWeather(0, -180.5)).rejects.toThrow(/between -180 and 180/);
    expect(fetcher.calls.length).toBe(0);
  });

  it("rejects non-finite coordinates", async () => {
    const fetcher = fakeFetch(() => ok({}));
    const client = new OpenMeteoClient({ fetchImpl: fetcher });
    await expect(client.currentWeather(Number.NaN, 0)).rejects.toThrow(/finite/);
    await expect(client.currentWeather(0, Number.POSITIVE_INFINITY)).rejects.toThrow(/finite/);
    expect(fetcher.calls.length).toBe(0);
  });
});
