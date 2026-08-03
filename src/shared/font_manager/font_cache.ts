/**
 * @license
 * Copyright 2012 Mozilla Foundation
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
 *
 * Generic, size-aware cache used by the FontManager to store fetched CMap
 * bytes, standard-font bytes and decoded CMap objects.
 *
 * The cache has a single responsibility: hold references to values keyed by
 * {@link CacheKey}, record access statistics, and evict entries according to
 * the configured {@link EvictionPolicy}.  It does not know how to fetch data
 * and it does not emit events itself — the FontManager is responsible for
 * translating cache evictions into `cache:evict` events.
 */

import type {
  CacheEntryStats,
  CacheKey,
  CacheOptions,
  CacheStats,
  EvictionPolicy,
  ResourceKind,
} from "./types.ts";
import { cacheKey, DEFAULT_CACHE_OPTIONS } from "./types.ts";

interface CacheEntry<T> {
  readonly key: CacheKey;
  readonly kind: ResourceKind;
  value: T;
  readonly size: number;
  readonly createdAt: number;
  /** Monotonically increasing "tick" used for stable LRU ordering. */
  lastAccessTick: number;
  /** Wall-clock timestamp of the last access, exposed in stats. */
  lastAccessedAt: number;
  hits: number;
}

export interface EvictionNotification {
  readonly key: CacheKey;
  readonly reason: "size" | "entries" | "manual";
}

export type EvictionListener = (notification: EvictionNotification) => void;

export class FontCache {
  readonly #options: { -readonly [K in keyof CacheOptions]: CacheOptions[K] };

  readonly #entries: Map<CacheKey, CacheEntry<unknown>> = new Map();

  #totalHits = 0;

  #totalMisses = 0;

  #totalSize = 0;

  #evictionListener: EvictionListener | null = null;

  /**
   * Monotonic counter incremented on every insertion and access.  It provides
   * stable LRU ordering even when two operations happen within the same
   * millisecond (which would make `Date.now()` ties ambiguous).
   */
  #tick = 0;

  constructor(options: Partial<CacheOptions> = {}) {
    this.#options = { ...DEFAULT_CACHE_OPTIONS, ...options };
  }

  /**
   * Re-configure the cache.  When the new limits are smaller than the
   * current state, eviction runs immediately.
   */
  configure(options: Partial<CacheOptions>): void {
    Object.assign(this.#options, options);
    this.#enforceLimits();
  }

  /**
   * Register a listener that is invoked whenever an entry is evicted.  Only
   * one listener is supported — the FontManager itself attaches here and
   * re-dispatches the notification on the event bus.
   */
  setEvictionListener(listener: EvictionListener | null): void {
    this.#evictionListener = listener;
  }

  /**
   * Insert or replace a value in the cache.
   */
  set<T>(key: CacheKey, kind: ResourceKind, value: T, size: number): void {
    const existing = this.#entries.get(key);
    if (existing) {
      this.#totalSize -= existing.size;
    }

    const now = Date.now();
    const tick = ++this.#tick;
    const entry: CacheEntry<T> = {
      key,
      kind,
      value,
      size,
      createdAt: now,
      lastAccessedAt: now,
      lastAccessTick: tick,
      hits: 0,
    };
    this.#entries.set(key, entry as CacheEntry<unknown>);
    this.#totalSize += size;

    this.#enforceLimits();
  }

  /**
   * Look up a value.  Returns `undefined` on a miss and updates hit/miss
   * statistics.
   */
  get<T>(key: CacheKey): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      this.#totalMisses++;
      return undefined;
    }
    entry.hits++;
    entry.lastAccessedAt = Date.now();
    entry.lastAccessTick = ++this.#tick;
    this.#totalHits++;
    return entry.value as T;
  }

  /**
   * Return `true` when the cache contains an entry for `key` (without
   * affecting statistics).
   */
  has(key: CacheKey): boolean {
    return this.#entries.has(key);
  }

  /**
   * Remove a single entry.  Returns `true` when an entry was actually
   * removed.
   */
  delete(key: CacheKey): boolean {
    const entry = this.#entries.get(key);
    if (!entry) {
      return false;
    }
    this.#totalSize -= entry.size;
    this.#entries.delete(key);
    this.#notifyEvict(key, "manual");
    return true;
  }

  /**
   * Remove every entry (used during document cleanup / `FontManager.clear`).
   */
  clear(): void {
    // Snapshot the keys so the notification callback can safely inspect the
    // cache without observing a partially-cleared state.
    const keys = Array.from(this.#entries.keys());
    this.#entries.clear();
    this.#totalSize = 0;
    for (const key of keys) {
      this.#notifyEvict(key, "manual");
    }
  }

  /**
   * Return a point-in-time snapshot of cache statistics.  The returned object
   * is a plain JSON-friendly value that can be emitted on the event bus or
   * logged.
   */
  getStats(): CacheStats {
    const entries: CacheEntryStats[] = [];
    for (const entry of this.#entries.values()) {
      entries.push({
        key: entry.key,
        kind: entry.kind,
        hits: entry.hits,
        size: entry.size,
        createdAt: entry.createdAt,
        lastAccessedAt: entry.lastAccessedAt,
      });
    }
    return {
      entries,
      totalHits: this.#totalHits,
      totalMisses: this.#totalMisses,
      totalSize: this.#totalSize,
      entryCount: entries.length,
    };
  }

  /** Number of currently cached entries. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Compute the cache key used for a CMap resource.  Exposed as a static
   * helper so that callers do not need to import {@link cacheKey} directly.
   */
  static keyFor(kind: ResourceKind, name: string): CacheKey {
    return cacheKey(kind, name);
  }

  #enforceLimits(): void {
    if (this.#options.evictionPolicy === "none") {
      return;
    }

    while (
      this.#entries.size > this.#options.maxEntries ||
      this.#totalSize > this.#options.maxBytes
    ) {
      const victim = this.#selectVictim();
      if (!victim) {
        break;
      }
      const reason =
        this.#totalSize > this.#options.maxBytes ? "size" : "entries";
      this.#totalSize -= victim.size;
      this.#entries.delete(victim.key);
      this.#notifyEvict(victim.key, reason);
    }
  }

  /**
   * Pick the next entry to evict according to the configured policy.
   */
  #selectVictim(): CacheEntry<unknown> | undefined {
    if (this.#entries.size === 0) {
      return undefined;
    }

    const policy: EvictionPolicy = this.#options.evictionPolicy;
    let candidate: CacheEntry<unknown> | undefined;
    for (const entry of this.#entries.values()) {
      if (!candidate) {
        candidate = entry;
        continue;
      }
      if (policy === "lfu") {
        if (entry.hits < candidate.hits) {
          candidate = entry;
        }
      } else {
        // Default to LRU, using the monotonic tick so that ties in
        // `lastAccessedAt` (same millisecond) do not cause non-deterministic
        // eviction.
        if (entry.lastAccessTick < candidate.lastAccessTick) {
          candidate = entry;
        }
      }
    }
    return candidate;
  }

  #notifyEvict(key: CacheKey, reason: EvictionNotification["reason"]): void {
    this.#evictionListener?.({ key, reason });
  }
}
