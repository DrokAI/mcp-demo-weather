import { describe, expect, it } from "vitest";
import { TTLCache } from "../src/cache.ts";

describe("TTLCache", () => {
  it("returns undefined for unknown keys and counts a miss", () => {
    const cache = new TTLCache(4);
    expect(cache.get("nope")).toBeUndefined();
    expect(cache.stats).toEqual({ entries: 0, hits: 0, misses: 1 });
  });

  it("round-trips a value and counts a hit", () => {
    const cache = new TTLCache(4);
    cache.set("k", { a: 1 }, 60);
    expect(cache.get("k")).toEqual({ a: 1 });
    expect(cache.stats).toEqual({ entries: 1, hits: 1, misses: 0 });
  });

  it("expires entries after the TTL (fake clock)", () => {
    let now = 1000;
    const cache = new TTLCache(4, () => now);
    cache.set("k", "v", 10);
    now += 9.999;
    expect(cache.get("k")).toBe("v");
    now += 0.002; // past the deadline
    expect(cache.get("k")).toBeUndefined();
  });

  it("lazily removes expired entries on get", () => {
    let now = 0;
    const cache = new TTLCache(4, () => now);
    cache.set("k", "v", 5);
    now = 10;
    cache.get("k");
    expect(cache.size()).toBe(0);
  });

  it("ignores non-positive TTLs", () => {
    const cache = new TTLCache(4);
    cache.set("k", "v", 0);
    cache.set("k2", "v", -5);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.get("k2")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("evicts the oldest entry (FIFO) when full", () => {
    const cache = new TTLCache(3);
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.set("c", 3, 1000);
    cache.set("d", 4, 1000); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("d")).toBe(4);
  });

  it("prefers evicting expired entries over live ones", () => {
    let now = 0;
    const cache = new TTLCache(3, () => now);
    cache.set("old1", 1, 5);
    cache.set("old2", 2, 5);
    cache.set("live", 3, 1000);
    now = 10; // old1/old2 expired, live has not
    cache.set("new", 4, 1000); // must drop expired, keep live
    expect(cache.get("live")).toBe(3);
    expect(cache.get("new")).toBe(4);
    expect(cache.get("old1")).toBeUndefined();
  });

  it("updating an existing key does not grow the store or evict", () => {
    const cache = new TTLCache(2);
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.set("a", 99, 1000); // refresh in place, still 2 entries
    expect(cache.get("a")).toBe(99);
    expect(cache.get("b")).toBe(2);
    expect(cache.size()).toBe(2);
  });

  it("size() counts only live entries", () => {
    let now = 0;
    const cache = new TTLCache(8, () => now);
    cache.set("dead", 1, 5);
    cache.set("alive", 2, 1000);
    now = 6;
    expect(cache.size()).toBe(1);
  });

  it("clear() empties the store and resets stats", () => {
    const cache = new TTLCache(4);
    cache.set("k", "v", 60);
    cache.get("k");
    cache.get("miss");
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.stats).toEqual({ entries: 0, hits: 0, misses: 0 });
    expect(cache.get("k")).toBeUndefined();
  });

  it("rejects invalid maxsize", () => {
    expect(() => new TTLCache(0)).toThrow(/maxsize/);
    expect(() => new TTLCache(-1)).toThrow(/maxsize/);
    expect(() => new TTLCache(1.5)).toThrow(/maxsize/);
  });

  it("bounded at maxsize under churn", () => {
    const cache = new TTLCache(5);
    for (let i = 0; i < 50; i += 1) cache.set(`k${String(i)}`, i, 1000);
    expect(cache.size()).toBe(5);
  });
});
