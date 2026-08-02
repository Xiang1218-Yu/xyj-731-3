/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview
 * A generic LRU (Least Recently Used) cache with optional TTL expiration.
 *
 * Design principles:
 *  - Single responsibility: key-value storage with eviction, nothing more.
 *  - Generic: stores values of type T, no assumptions about payload shape.
 *  - O(1) get/set/delete using a Map (which maintains insertion order).
 *  - Optional TTL: entries expire after a configurable number of milliseconds.
 *  - Size bound: evicts least-recently-used entry when maxSize is exceeded.
 *  - Observable: emits eviction events via an optional callback.
 *  - No external dependencies.
 */

import type { CacheEntry, CacheOptions, CacheStats } from "./font_types.js";

/**
 * Callback invoked when an entry is evicted from the cache.
 *
 * @typeParam T - The cached value type.
 */
type EvictionCallback<T> = (
  key: string,
  value: T,
  reason: "size" | "ttl" | "manual"
) => void;

/**
 * A Least-Recently-Used cache with optional time-based expiration.
 *
 * @typeParam T - The type of values stored in the cache.
 *
 * @example
 * ```ts
 * const cache = new LRUCache<Uint8Array>({
 *   maxSize: 50,
 *   ttlMs: 60_000,
 *   persistent: false,
 * }, "myCache");
 * cache.set("key1", data);
 * const data = cache.get("key1");
 * ```
 */
class LRUCache<T> {
  /** Internal storage: Map maintains insertion order for LRU eviction. */
  readonly #store: Map<string, CacheEntry<T>> = new Map();

  /** Cache configuration. */
  readonly #options: Readonly<CacheOptions>;

  /** Human-readable name for diagnostics. */
  readonly #name: string;

  /** Optional eviction callback. */
  #onEviction: EvictionCallback<T> | undefined;

  // Running statistics counters.
  #hits = 0;

  #misses = 0;

  #evictions = 0;

  /**
   * @param options - Cache configuration (maxSize, ttlMs, persistent).
   * @param name - A name for this cache instance (used in diagnostics).
   */
  constructor(options: CacheOptions, name = "LRUCache") {
    this.#options = { ...options };
    this.#name = name;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Retrieve a value from the cache.
   * If the entry exists and has not expired, mark it most-recently-used.
   *
   * @param key - The cache key.
   * @returns The cached value, or undefined if not found/expired.
   */
  get(key: string): T | undefined {
    const entry = this.#store.get(key);

    if (!entry) {
      this.#misses++;
      return undefined;
    }

    // Check TTL expiration.
    if (this.#isExpired(entry)) {
      this.#store.delete(key);
      this.#evictions++;
      this.#onEviction?.(key, entry.value, "ttl");
      this.#misses++;
      return undefined;
    }

    // Mark as most-recently-used by deleting and re-inserting (Map reorders).
    this.#store.delete(key);
    this.#store.set(key, {
      ...entry,
      lastAccessedAt: Date.now(),
      accessCount: entry.accessCount + 1,
    });

    this.#hits++;
    return entry.value;
  }

  /**
   * Store a value in the cache.
   * If the key already exists, the value is updated and moved to MRU position.
   * If adding the entry exceeds maxSize, the LRU entry is evicted.
   *
   * @param key - The cache key.
   * @param value - The value to store.
   */
  set(key: string, value: T): void {
    // If key exists, remove it first so it moves to the end (MRU).
    if (this.#store.has(key)) {
      this.#store.delete(key);
    }

    const now = Date.now();
    const entry: CacheEntry<T> = {
      value,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    };

    this.#store.set(key, entry);

    // Enforce max size by evicting LRU entries.
    if (this.#options.maxSize > 0 && this.#store.size > this.#options.maxSize) {
      this.#evictLRU();
    }
  }

  /**
   * Check whether a non-expired entry exists without affecting LRU order.
   *
   * @param key - The cache key.
   * @returns True if the key exists and has not expired.
   */
  has(key: string): boolean {
    const entry = this.#store.get(key);
    if (!entry) {
      return false;
    }
    if (this.#isExpired(entry)) {
      this.#store.delete(key);
      this.#evictions++;
      this.#onEviction?.(key, entry.value, "ttl");
      return false;
    }
    return true;
  }

  /**
   * Delete a specific entry from the cache.
   *
   * @param key - The cache key to delete.
   * @returns True if an entry was deleted.
   */
  delete(key: string): boolean {
    const entry = this.#store.get(key);
    if (!entry) {
      return false;
    }
    this.#store.delete(key);
    this.#onEviction?.(key, entry.value, "manual");
    return true;
  }

  /**
   * Get or set a value using a factory function.
   * If the key exists, returns the cached value.
   * Otherwise, calls the factory, caches the result, and returns it.
   *
   * @param key - The cache key.
   * @param factory - A function producing the value to cache.
   * @returns The cached or newly created value.
   */
  getOrSet(key: string, factory: () => T): T {
    const existing = this.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const value = factory();
    this.set(key, value);
    return value;
  }

  /**
   * Async version of getOrSet. If the key exists, returns the cached value.
   * Otherwise, awaits the factory, caches the result, and returns it.
   *
   * In-flight promises are de-duplicated: concurrent calls for the same key
   * share a single factory invocation.
   *
   * @param key - The cache key.
   * @param factory - An async function producing the value to cache.
   * @returns A promise resolving to the cached or newly created value.
   */
  async getOrSetAsync(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.get(key);
    if (existing !== undefined) {
      return existing;
    }

    // Check for an in-flight promise to de-duplicate concurrent requests.
    const inFlight = this.#inFlight.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = factory()
      .then(value => {
        this.set(key, value);
        this.#inFlight.delete(key);
        return value;
      })
      .catch((err: unknown) => {
        this.#inFlight.delete(key);
        throw err;
      });

    this.#inFlight.set(key, promise);
    return promise;
  }

  /** In-flight promises for getOrSetAsync de-duplication. */
  readonly #inFlight: Map<string, Promise<T>> = new Map();

  /**
   * Remove all entries from the cache.
   */
  clear(): void {
    for (const [key, entry] of this.#store) {
      this.#onEviction?.(key, entry.value, "manual");
    }
    this.#store.clear();
    this.#inFlight.clear();
  }

  /**
   * Remove all expired entries from the cache.
   * Can be called periodically to free memory.
   *
   * @returns The number of entries removed.
   */
  pruneExpired(): number {
    if (this.#options.ttlMs <= 0) {
      return 0;
    }
    let removed = 0;
    const now = Date.now();
    for (const [key, entry] of this.#store) {
      if (now - entry.createdAt > this.#options.ttlMs) {
        this.#store.delete(key);
        this.#evictions++;
        this.#onEviction?.(key, entry.value, "ttl");
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get current cache statistics.
   *
   * @returns A snapshot of cache stats.
   */
  getStats(): CacheStats {
    return {
      size: this.#store.size,
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      hitRate:
        this.#hits + this.#misses > 0
          ? this.#hits / (this.#hits + this.#misses)
          : 0,
    };
  }

  /**
   * Get the current number of entries (after pruning expired).
   */
  get size(): number {
    this.pruneExpired();
    return this.#store.size;
  }

  /**
   * The name of this cache instance.
   */
  get name(): string {
    return this.#name;
  }

  /**
   * Register a callback to be invoked when entries are evicted.
   *
   * @param callback - The eviction callback, or undefined to remove.
   */
  setEvictionCallback(callback: EvictionCallback<T> | undefined): void {
    this.#onEviction = callback;
  }

  /**
   * Reset all statistics counters.
   */
  resetStats(): void {
    this.#hits = 0;
    this.#misses = 0;
    this.#evictions = 0;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Check whether a cache entry has expired based on TTL.
   */
  #isExpired(entry: CacheEntry<T>): boolean {
    if (this.#options.ttlMs <= 0) {
      return false;
    }
    return Date.now() - entry.createdAt > this.#options.ttlMs;
  }

  /**
   * Evict the least-recently-used entry (the first key in insertion order).
   */
  #evictLRU(): void {
    const firstKey = this.#store.keys().next().value;
    if (firstKey === undefined) {
      return;
    }
    const entry = this.#store.get(firstKey);
    if (entry) {
      this.#store.delete(firstKey);
      this.#evictions++;
      this.#onEviction?.(firstKey, entry.value, "size");
    }
  }
}

export type { EvictionCallback };
export { LRUCache };
