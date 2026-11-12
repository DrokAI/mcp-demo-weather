import { describe, expect, it } from "vitest";
import {
  AIR_QUALITY,
  ARCHIVE_DAILY,
  CURRENT_WEATHER,
  DAILY_FORECAST,
  GEOCODE_REYKJAVIK,
  HOURLY_FORECAST,
  callToolErr,
  callToolOk,
  fakeFetch,
  jsonResponse,
  makePair,
} from "./helpers.ts";

const LAT = 64.13548;
const LON = -21.89541;

describe("tools/list", () => {
  it("exposes exactly the six narrow tools", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, {}));
    const client = await makePair(fetcher);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "geocode_location",
      "get_air_quality",
      "get_current_weather",
      "get_daily_forecast",
      "get_history_weather",
      "get_hourly_forecast",
    ]);
  });

  it("declares every tool read-only, non-destructive, idempotent, open-world", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, {}));
    const client = await makePair(fetcher);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true);
      expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe(false);
      expect(tool.annotations?.idempotentHint, `${tool.name} idempotentHint`).toBe(true);
      expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(true);
    }
  });

  it("publishes constrained JSON Schema (ranges, enums, patterns)", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, {}));
    const client = await makePair(fetcher);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const current = byName.get("get_current_weather")?.inputSchema as {
      properties?: { [k: string]: { maximum?: number; minimum?: number } };
      required?: string[];
    };
    expect(current.properties?.latitude?.maximum).toBe(90);
    expect(current.properties?.latitude?.minimum).toBe(-90);
    expect(current.properties?.longitude?.maximum).toBe(180);
    expect(current.required).toEqual(["latitude", "longitude"]);

    const daily = byName.get("get_daily_forecast")?.inputSchema as {
      properties?: { [k: string]: { maximum?: number; enum?: string[] } };
    };
    expect(daily.properties?.days?.maximum).toBe(10);
    expect(daily.properties?.temperature_unit?.enum).toEqual(["celsius", "fahrenheit"]);

    const history = byName.get("get_history_weather")?.inputSchema as {
      properties?: { [k: string]: { pattern?: string } };
    };
    expect(history.properties?.start_date?.pattern).toContain("\\d{4}-\\d{2}-\\d{2}");
  });
});

describe("geocode_location", () => {
  it("returns compact place rows with coordinates and timezone", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, GEOCODE_REYKJAVIK));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "geocode_location", { name: "Reykjavik" });
    expect(payload.query).toBe("Reykjavik");
    expect(payload.count).toBe(1);
    const first = (payload.results as Array<{ [k: string]: unknown }>)[0]!;
    expect(first.name).toBe("Reykjavik");
    expect(first.country).toBe("Iceland");
    expect(first.latitude).toBe(LAT);
    expect(first.timezone).toBe("Atlantic/Reykjavik");
    expect(first.population).toBe(123246);
    // junk upstream fields are dropped
    expect(Object.keys(first)).not.toContain("postcodes");
    expect(Object.keys(first)).not.toContain("id");
  });

  it("re-slices results to max_results even if upstream ignores it", async () => {
    const many = {
      results: Array.from({ length: 10 }, (_, i) => ({ name: `Place ${String(i)}` })),
    };
    const fetcher = fakeFetch(() => jsonResponse(200, many));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "geocode_location", {
      name: "Place",
      max_results: 3,
    });
    expect(payload.count).toBe(3);
  });

  it("empty result sets carry a helpful hint", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, {}));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "geocode_location", { name: "Xyzzyville" });
    expect(payload.count).toBe(0);
    expect(String(payload.hint)).toMatch(/spelling|bigger nearby city/);
  });

  it("missing optional max_results applies the default of 5", async () => {
    const many = {
      results: Array.from({ length: 9 }, (_, i) => ({ name: `P${String(i)}` })),
    };
    const fetcher = fakeFetch(() => jsonResponse(200, many));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "geocode_location", { name: "P" });
    expect(payload.count).toBe(5);
  });
});

describe("get_current_weather", () => {
  it("returns current conditions with units and a plain-language sky", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, CURRENT_WEATHER));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "get_current_weather", {
      latitude: LAT,
      longitude: LON,
    });
    expect(payload.timezone).toBe("Atlantic/Reykjavik");
    const current = payload.current as { [k: string]: unknown };
    expect(current.temperature_2m).toBe(-0.7);
    expect(current.temperature_unit).toBe("°C");
    expect(current.weather_code).toBe(0);
    expect(current.weather_description).toBe("Clear sky");
    expect(current.is_day).toBe(true);
  });

  it("serves a repeat call from the TTL cache (one upstream fetch)", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, CURRENT_WEATHER));
    const client = await makePair(fetcher);
    await callToolOk(client, "get_current_weather", { latitude: LAT, longitude: LON });
    await callToolOk(client, "get_current_weather", { latitude: LAT, longitude: LON });
    expect(fetcher.calls.length).toBe(1);
  });
});

describe("get_daily_forecast", () => {
  it("zips columnar arrays into rows and expands weather codes", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, DAILY_FORECAST));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "get_daily_forecast", {
      latitude: LAT,
      longitude: LON,
      days: 3,
    });
    const days = payload.days as Array<{ [k: string]: unknown }>;
    expect(days).toHaveLength(3);
    expect(days[0]?.time).toBe("2026-11-12");
    expect(days[0]?.weather_description).toBe("Clear sky");
    expect(days[1]?.weather_description).toBe("Mainly clear");
    expect(Object.keys(days[0] ?? {}).length).toBeGreaterThan(8); // full row, not a firehose
  });

  it("defensively caps rows when upstream ignores forecast_days", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, DAILY_FORECAST)); // 14 rows!
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "get_daily_forecast", {
      latitude: LAT,
      longitude: LON,
      days: 5,
    });
    expect(payload.days).toHaveLength(5);
  });

  it("echoes the requested temperature unit", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, DAILY_FORECAST));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "get_daily_forecast", {
      latitude: LAT,
      longitude: LON,
      temperature_unit: "fahrenheit",
    });
    expect(payload.temperature_unit).toBe("fahrenheit");
    const params = Object.fromEntries(fetcher.calls[0]!.url.searchParams);
    expect(params.temperature_unit).toBe("fahrenheit");
  });

  it("defaults to 5 celsius days when optional args are omitted", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, DAILY_FORECAST));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "get_daily_forecast", {
      latitude: LAT,
      longitude: LON,
    });
    expect(payload.days).toHaveLength(5);
    expect(payload.temperature_unit).toBe("celsius");
  });
});

describe("get_hourly_forecast", () => {
  it("returns hour rows with description and hour_count", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, HOURLY_FORECAST));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "get_hourly_forecast", {
      latitude: LAT,
      longitude: LON,
      hours: 7,
    });
    expect(payload.hour_count).toBe(7);
    const hours = payload.hours as Array<{ [k: string]: unknown }>;
    expect(hours).toHaveLength(7);
    expect(hours[0]?.weather_description).toBe("Clear sky");
    expect(hours[6]?.weather_description).toBe("Slight rain");
  });

  it("caps at 72 hours even if upstream returns more", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, HOURLY_FORECAST));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "get_hourly_forecast", {
      latitude: LAT,
      longitude: LON,
      hours: 72,
    });
    expect(payload.hour_count).toBe(HOURLY_FORECAST.hourly.time.length); // only what upstream had
  });
});

describe("get_air_quality", () => {
  it("returns US AQI rows with units", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, AIR_QUALITY));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "get_air_quality", {
      latitude: LAT,
      longitude: LON,
      hours: 5,
    });
    expect(payload.hour_count).toBe(5);
    const hours = payload.hours as Array<{ [k: string]: unknown }>;
    expect(hours[0]?.us_aqi).toBe(12);
    expect((payload.units as { [k: string]: unknown }).pm2_5).toBe("µg/m³");
  });
});

describe("get_history_weather", () => {
  it("returns archive rows with descriptions", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, ARCHIVE_DAILY));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "get_history_weather", {
      latitude: LAT,
      longitude: LON,
      start_date: "2026-01-01",
      end_date: "2026-01-03",
    });
    expect(payload.day_count).toBe(3);
    const days = payload.days as Array<{ [k: string]: unknown }>;
    expect(days[0]?.weather_description).toBe("Slight rain");
    expect(days[2]?.snowfall_sum).toBe(4.2);
  });

  it("rejects end_date before start_date", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, ARCHIVE_DAILY));
    const client = await makePair(fetcher);
    const msg = await callToolErr(client, "get_history_weather", {
      latitude: LAT,
      longitude: LON,
      start_date: "2026-02-01",
      end_date: "2026-01-01",
    });
    expect(msg).toMatch(/end_date .* is before start_date/);
    expect(fetcher.calls.length).toBe(0);
  });

  it("rejects ranges longer than 366 days with a split suggestion", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, ARCHIVE_DAILY));
    const client = await makePair(fetcher);
    const msg = await callToolErr(client, "get_history_weather", {
      latitude: LAT,
      longitude: LON,
      start_date: "2024-01-01",
      end_date: "2026-01-01",
    });
    expect(msg).toMatch(/maximum is 366/);
    expect(msg).toMatch(/Split longer research/);
    expect(fetcher.calls.length).toBe(0);
  });

  it("accepts exactly a 366-day span (leap-year edge)", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, ARCHIVE_DAILY));
    const client = await makePair(fetcher);
    const payload = await callToolOk(client, "get_history_weather", {
      latitude: LAT,
      longitude: LON,
      start_date: "2024-01-01",
      end_date: "2025-01-01",
    });
    expect(payload.day_count).toBe(3);
  });

  it("rejects impossible calendar dates (2026-02-30)", async () => {
    const fetcher = fakeFetch(() => jsonResponse(200, ARCHIVE_DAILY));
    const client = await makePair(fetcher);
    const msg = await callToolErr(client, "get_history_weather", {
      latitude: LAT,
      longitude: LON,
      start_date: "2026-02-30",
      end_date: "2026-03-01",
    });
    expect(msg).toMatch(/valid ISO calendar dates/);
    expect(fetcher.calls.length).toBe(0);
  });
});

describe("schema violations are rejected before any network call", () => {
  const cases: Array<{ tool: string; args: Record<string, unknown>; match: RegExp }> = [
    {
      tool: "get_current_weather",
      args: { latitude: 999, longitude: 0 },
      match: /latitude/i,
    },
    {
      tool: "get_current_weather",
      args: { latitude: 0, longitude: -181 },
      match: /longitude/i,
    },
    {
      tool: "get_daily_forecast",
      args: { latitude: 0, longitude: 0, days: 11 },
      match: /days/i,
    },
    {
      tool: "get_daily_forecast",
      args: { latitude: 0, longitude: 0, days: 0 },
      match: /days/i,
    },
    {
      tool: "get_daily_forecast",
      args: { latitude: 0, longitude: 0, temperature_unit: "kelvin" },
      match: /temperature_unit|celsius|fahrenheit/i,
    },
    {
      tool: "get_hourly_forecast",
      args: { latitude: 0, longitude: 0, hours: 73 },
      match: /hours/i,
    },
    {
      tool: "get_hourly_forecast",
      args: { latitude: 0, longitude: 0, hours: 2.5 },
      match: /hours|integer/i,
    },
    {
      tool: "get_air_quality",
      args: { latitude: 0, longitude: 0, hours: 49 },
      match: /hours/i,
    },
    {
      tool: "geocode_location",
      args: { name: "" },
      match: /name/i,
    },
    {
      tool: "geocode_location",
      args: { name: "x".repeat(101) },
      match: /name/i,
    },
    {
      tool: "geocode_location",
      args: { name: "Berlin", max_results: 11 },
      match: /max_results/i,
    },
    {
      tool: "get_history_weather",
      args: { latitude: 0, longitude: 0, start_date: "not-a-date", end_date: "2026-01-01" },
      match: /start_date/i,
    },
    {
      tool: "get_current_weather",
      args: { latitude: "64.1", longitude: 0 },
      match: /latitude|number/i,
    },
    {
      tool: "get_current_weather",
      args: {},
      match: /latitude|required/i,
    },
  ];

  for (const { tool, args, match } of cases) {
    it(`${tool}: ${JSON.stringify(args)}`, async () => {
      const fetcher = fakeFetch(() => jsonResponse(200, {}));
      const client = await makePair(fetcher);
      const msg = await callToolErr(client, tool, args);
      expect(msg).toMatch(match);
      // Rejected at the schema — the upstream was never contacted.
      expect(fetcher.calls.length, "no network call should happen").toBe(0);
    });
  }
});

describe("upstream failures become LLM-readable isError results", () => {
  it("surfaces the upstream reason verbatim", async () => {
    const fetcher = fakeFetch(() =>
      jsonResponse(400, { error: true, reason: "Failed to resolve geocoding for name" }),
    );
    const client = await makePair(fetcher);
    const msg = await callToolErr(client, "geocode_location", { name: "Nowhereburg" });
    expect(msg).toMatch(/geocode_location failed: Open-Meteo returned HTTP 400/);
    expect(msg).toContain("Failed to resolve geocoding for name");
  });

  it("network failure explains what happened", async () => {
    const fetcher = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = await makePair(fetcher);
    const msg = await callToolErr(client, "get_current_weather", {
      latitude: LAT,
      longitude: LON,
    });
    expect(msg).toMatch(/Could not reach Open-Meteo/);
  });
});
