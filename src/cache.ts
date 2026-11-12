/**
 * A tiny, dependency-free TTL cache with a bounded number of entries.
 *
 * Deliberately simple: this server is a single process with small JSON
 * payloads, so an in-process Map beats adding a caching dependency.
 * JavaScript is single-threaded per event loop, so no locks are needed.
 * Eviction is expire-first-then-FIFO (Map preserves insertion order).
 */

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
}

interface Entry {
  expiresAt: number;
  value: unknown;
}

export class TTLCache {
  readonly maxsize: number;
  private readonly clock: () => number;
  private readonly store = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(maxsize = 256, clock: () => number = () => performance.now()) {
    if (!Number.isInteger(maxsize) || maxsize < 1) {
      throw new Error("maxsize must be an integer >= 1");
    }
    this.maxsize = maxsize;
    this.clock = clock;
  }

  /** Return the cached value, or undefined on miss/expiry (counted in stats). */
  get(key: string): unknown {
    const entry = this.store.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.clock()) {
      this.store.delete(key); // lazy expiry
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.value;
  }

  /** Store a value that expires `ttlSeconds` from now. Non-positive TTLs are ignored. */
  set(key: string, value: unknown, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    if (!this.store.has(key)) this.evictIfFull();
    // Re-setting an existing key keeps its original insertion position.
    this.store.set(key, { expiresAt: this.clock() + ttlSeconds, value });
  }

  /** Drop everything and reset statistics. */
  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** Number of live (non-expired) entries. */
  size(): number {
    const now = this.clock();
    let live = 0;
    for (const entry of this.store.values()) {
      if (entry.expiresAt > now) live += 1;
    }
    return live;
  }

  get stats(): CacheStats {
    return { entries: this.size(), hits: this.hits, misses: this.misses };
  }

  /** Make room: drop expired entries first, then the oldest inserted (FIFO). */
  private evictIfFull(): void {
    if (this.store.size < this.maxsize) return;
    const now = this.clock();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
    while (this.store.size >= this.maxsize) {
      const oldest = this.store.keys().next();
      if (oldest.done === true) break;
      this.store.delete(oldest.value);
    }
  }
}
