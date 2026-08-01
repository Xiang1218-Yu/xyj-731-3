/* Copyright 2024 Mozilla Foundation
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
 * @module font-manager/font-cache
 *
 * A namespaced, capacity-bounded (LRU) cache.
 *
 * Single responsibility: remember previously computed/fetched artifacts so the
 * loader and fallback resolver never repeat work for the same key. This is the
 * "caching mechanism" required by the refactor.
 *
 * Type safety: the cache is keyed by {@link CacheNamespace}, and the value type
 * for each namespace is pinned by {@link CacheValueMap}. Thus `get("cmap", k)`
 * is typed to return `LoadedCMap | undefined`, while `get("fontData", k)`
 * returns `Uint8Array | undefined` — with no `any` anywhere.
 */

import type {
  CacheNamespace,
  CacheStats,
  CacheValueMap,
} from "./types.js";

/**
 * Compose the flat map key from a namespace + logical key. Namespaces never
 * contain `\u0000`, so this separator cannot collide.
 */
function composeKey(namespace: CacheNamespace, key: string): string {
  return `${namespace}\u0000${key}`;
}

/**
 * An LRU cache with a fixed capacity. We rely on the insertion-order guarantee
 * of `Map`: re-inserting a key moves it to the "most recently used" end, and
 * the least recently used entry is always the first key returned by the
 * iterator.
 *
 * Values are stored as the union of every namespace value type; the public,
 * generic methods narrow this back to the exact per-namespace type.
 */
export class FontCache {
  readonly #store = new Map<string, CacheValueMap[CacheNamespace]>();

  #capacity: number;

  #hits = 0;

  #misses = 0;

  #evictions = 0;

  /**
   * @param capacity Maximum number of entries retained across *all* namespaces.
   *   Must be a positive integer.
   */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`FontCache capacity must be a positive integer, got ${capacity}.`);
    }
    this.#capacity = capacity;
  }

  /**
   * Retrieve a value, refreshing its recency. Returns `undefined` on a miss.
   * The return type is narrowed to the value type of the requested namespace.
   */
  get<N extends CacheNamespace>(
    namespace: N,
    key: string
  ): CacheValueMap[N] | undefined {
    const composed = composeKey(namespace, key);
    const value = this.#store.get(composed);
    if (value === undefined) {
      this.#misses++;
      return undefined;
    }
    // Refresh recency: delete + re-set moves it to the MRU position.
    this.#store.delete(composed);
    this.#store.set(composed, value);
    this.#hits++;
    // Sound: values under `namespace` are always `CacheValueMap[N]` (see `set`).
    return value as CacheValueMap[N];
  }

  /** `true` when a live entry exists for `(namespace, key)`; no recency change. */
  has(namespace: CacheNamespace, key: string): boolean {
    return this.#store.has(composeKey(namespace, key));
  }

  /**
   * Insert/replace a value. Evicts the least-recently-used entry (invoking
   * `onEvict`, if provided, for observability) when capacity is exceeded.
   */
  set<N extends CacheNamespace>(
    namespace: N,
    key: string,
    value: CacheValueMap[N],
    onEvict?: (namespace: CacheNamespace, key: string) => void
  ): void {
    const composed = composeKey(namespace, key);
    // Replacing an existing key must not count against capacity twice.
    this.#store.delete(composed);
    this.#store.set(composed, value);

    while (this.#store.size > this.#capacity) {
      const oldest = this.#store.keys().next();
      if (oldest.done) {
        break;
      }
      this.#store.delete(oldest.value);
      this.#evictions++;
      if (onEvict) {
        const separator = oldest.value.indexOf("\u0000");
        const evictedNamespace = oldest.value.slice(0, separator) as CacheNamespace;
        const evictedKey = oldest.value.slice(separator + 1);
        onEvict(evictedNamespace, evictedKey);
      }
    }
  }

  /**
   * Return the cached value or compute-and-store it via `factory`. This is the
   * primary entry point used by the loader/resolver so caching is transparent.
   */
  async getOrCreate<N extends CacheNamespace>(
    namespace: N,
    key: string,
    factory: () => Promise<CacheValueMap[N]>,
    onEvict?: (namespace: CacheNamespace, key: string) => void
  ): Promise<{ value: CacheValueMap[N]; fromCache: boolean }> {
    const existing = this.get(namespace, key);
    if (existing !== undefined) {
      return { value: existing, fromCache: true };
    }
    const value = await factory();
    this.set(namespace, key, value, onEvict);
    return { value, fromCache: false };
  }

  /** Drop a single entry. Returns `true` when an entry was removed. */
  delete(namespace: CacheNamespace, key: string): boolean {
    return this.#store.delete(composeKey(namespace, key));
  }

  /** Remove every entry and reset statistics. */
  clear(): void {
    this.#store.clear();
    this.#hits = 0;
    this.#misses = 0;
    this.#evictions = 0;
  }

  /** A snapshot of runtime statistics (used by tests & diagnostics). */
  get stats(): CacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      size: this.#store.size,
    };
  }

  /** The configured maximum number of entries. */
  get capacity(): number {
    return this.#capacity;
  }
}
