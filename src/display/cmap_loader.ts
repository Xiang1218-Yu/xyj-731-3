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
 * Asynchronous, on-demand CMap loader with configurable preload strategies.
 *
 * Design principles:
 *  - Single responsibility: fetching and caching raw CMap binary data.
 *  - Asynchronous: never blocks the main/worker thread on network I/O.
 *  - On-demand: CMaps are fetched only when needed.
 *  - Preload strategies: common CMaps can be prefetched to reduce latency.
 *  - Concurrency control: limits simultaneous fetch requests.
 *  - Request de-duplication: concurrent requests for the same CMap share one fetch.
 *  - Observable: emits lifecycle events through the FontEventBus.
 *  - No direct dependency on the existing cmap.js parser; it only handles data I/O.
 */

import type {
  CMapLoadOptions,
  CMapPreloadStrategy,
  CMapRawData,
  BinaryDataFetcher,
} from "./font_types.js";
import { FontEventType } from "./font_types.js";
import { FontEventBus } from "./font_event_bus.js";
import { LRUCache } from "./font_cache.js";

// ---------------------------------------------------------------------------
// Preload strategy CMap lists
// ---------------------------------------------------------------------------

/**
 * The four Unicode UCS2 CMaps that are very commonly referenced.
 */
const UNICODE_CMAPS: readonly string[] = [
  "Adobe-GB1-UCS2",
  "Adobe-CNS1-UCS2",
  "Adobe-Japan1-UCS2",
  "Adobe-Korea1-UCS2",
];

/**
 * Common Japanese CMaps (Adobe-Japan1 character collection).
 */
const JAPANESE_CMAPS: readonly string[] = [
  "Adobe-Japan1-UCS2",
  "UniJIS-UCS2-H",
  "UniJIS-UCS2-V",
  "UniJIS-UTF16-H",
  "UniJIS-UTF16-V",
  "UniJIS-UTF8-H",
  "UniJIS-UTF8-V",
  "78-RKSJ-H",
  "78-RKSJ-V",
  "90ms-RKSJ-H",
  "90ms-RKSJ-V",
  "EUC-H",
  "EUC-V",
];

/**
 * Common Simplified Chinese CMaps (Adobe-GB1 character collection).
 */
const CHINESE_SIMPLIFIED_CMAPS: readonly string[] = [
  "Adobe-GB1-UCS2",
  "UniGB-UCS2-H",
  "UniGB-UCS2-V",
  "UniGB-UTF16-H",
  "UniGB-UTF16-V",
  "UniGB-UTF8-H",
  "UniGB-UTF8-V",
  "GBK-EUC-H",
  "GBK-EUC-V",
  "GB-EUC-H",
  "GB-EUC-V",
];

/**
 * Common Traditional Chinese CMaps (Adobe-CNS1 character collection).
 */
const CHINESE_TRADITIONAL_CMAPS: readonly string[] = [
  "Adobe-CNS1-UCS2",
  "UniCNS-UCS2-H",
  "UniCNS-UCS2-V",
  "UniCNS-UTF16-H",
  "UniCNS-UTF16-V",
  "UniCNS-UTF8-H",
  "UniCNS-UTF8-V",
  "B5-H",
  "B5-V",
  "ETen-B5-H",
  "ETen-B5-V",
];

/**
 * Common Korean CMaps (Adobe-Korea1 character collection).
 */
const KOREAN_CMAPS: readonly string[] = [
  "Adobe-Korea1-UCS2",
  "UniKS-UCS2-H",
  "UniKS-UCS2-V",
  "UniKS-UTF16-H",
  "UniKS-UTF16-V",
  "UniKS-UTF8-H",
  "UniKS-UTF8-V",
  "KSC-EUC-H",
  "KSC-EUC-V",
  "KSCms-UHC-H",
  "KSCms-UHC-V",
];

/**
 * Identity CMaps that don't need to be fetched (they're synthesized).
 */
const IDENTITY_CMAPS: ReadonlySet<string> = new Set([
  "Identity-H",
  "Identity-V",
]);

// ---------------------------------------------------------------------------
// CMapLoader
// ---------------------------------------------------------------------------

/**
 * Asynchronous CMap data loader with caching and preload support.
 *
 * This class is responsible only for fetching raw CMap bytes from a URL or
 * fetcher. It does not parse CMaps; that remains the responsibility of the
 * existing CMapFactory in the core layer.
 *
 * The loader integrates with LRUCache for data caching and FontEventBus for
 * lifecycle events.
 */
export class CMapLoader {
  /** Cache for raw CMap data. */
  readonly #cache: LRUCache<CMapRawData>;

  /** Event bus for lifecycle notifications. */
  readonly #eventBus: FontEventBus;

  /** Load options (URL, packed flag, strategy, concurrency). */
  readonly #options: Readonly<CMapLoadOptions>;

  /** The fetcher used to retrieve binary data. */
  readonly #fetcher: BinaryDataFetcher;

  /**
   * In-flight fetch promises, keyed by CMap name.
   * Used to de-duplicate concurrent requests for the same CMap.
   */
  readonly #inFlight: Map<string, Promise<CMapRawData>> = new Map();

  /** Semaphore counter for concurrency limiting. */
  #activeFetches = 0;

  /** Queue of pending fetch requests waiting for a concurrency slot. */
  readonly #fetchQueue: Array<() => void> = [];

  /** Count of preloaded CMaps for statistics. */
  #preloadCount = 0;

  /**
   * @param fetcher - The binary data fetcher implementation.
   * @param options - CMap loading options.
   * @param eventBus - The event bus for lifecycle events.
   * @param cache - Optional cache instance (creates a default one if omitted).
   */
  constructor(
    fetcher: BinaryDataFetcher,
    options: CMapLoadOptions,
    eventBus: FontEventBus,
    cache?: LRUCache<CMapRawData>
  ) {
    this.#fetcher = fetcher;
    this.#options = { ...options };
    this.#eventBus = eventBus;
    this.#cache =
      cache ??
      new LRUCache<CMapRawData>(
        {
          maxSize: 200,
          ttlMs: 60 * 60 * 1000,
          persistent: true,
        },
        "CMapCache"
      );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Load a CMap's raw data by name.
   *
   * If the data is cached, returns immediately. If a fetch is already in
   * flight for this name, the existing promise is returned. Otherwise a new
   * fetch is initiated, respecting the concurrency limit.
   *
   * @param name - The CMap name (e.g. "Adobe-Japan1-UCS2").
   * @returns A promise resolving to the raw CMap data.
   */
  async load(name: string): Promise<CMapRawData> {
    // Identity CMaps are synthesized by the parser, never fetched.
    if (IDENTITY_CMAPS.has(name)) {
      throw new Error(
        `CMap "${name}" is an identity CMap and should not be fetched.`
      );
    }

    // Check cache first.
    const cached = this.#cache.get(name);
    if (cached) {
      return cached;
    }

    // De-duplicate in-flight requests.
    const inFlight = this.#inFlight.get(name);
    if (inFlight) {
      return inFlight;
    }

    // Create the fetch promise.
    const promise = this.#fetchWithConcurrency(name);
    this.#inFlight.set(name, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      this.#inFlight.delete(name);
    }
  }

  /**
   * Check whether a CMap's data is already cached.
   * Does not trigger a fetch.
   *
   * @param name - The CMap name.
   * @returns True if cached data is available.
   */
  isCached(name: string): boolean {
    return this.#cache.has(name);
  }

  /**
   * Preload CMaps according to the configured strategy.
   *
   * This fires off fetches in the background and returns a promise that
   * resolves when all preload fetches have completed (success or failure).
   * Preload failures do not reject the promise; they are logged via events.
   *
   * @param strategy - Optional override for the preload strategy.
   * @returns A promise resolving to the number of CMaps successfully preloaded.
   */
  async preload(
    strategy: CMapPreloadStrategy = this.#options.preloadStrategy
  ): Promise<number> {
    if (strategy === "none") {
      return 0;
    }

    const names = this.#getCMapNamesForStrategy(strategy);
    if (names.length === 0) {
      return 0;
    }

    const startTime = Date.now();

    this.#eventBus.dispatch(FontEventType.CMapPreloadStart, {
      strategy,
      totalCount: names.length,
      successCount: 0,
      failureCount: 0,
      elapsedMs: 0,
    });

    let successCount = 0;
    let failureCount = 0;

    // Fire all preloads; they are concurrency-limited internally.
    const results = await Promise.allSettled(
      names.map((name) => this.load(name))
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        successCount++;
      } else {
        failureCount++;
      }
    }

    const elapsedMs = Date.now() - startTime;
    this.#preloadCount += successCount;

    this.#eventBus.dispatch(FontEventType.CMapPreloadComplete, {
      strategy,
      totalCount: names.length,
      successCount,
      failureCount,
      elapsedMs,
    });

    return successCount;
  }

  /**
   * Get the cache statistics.
   */
  getCacheStats() {
    return this.#cache.getStats();
  }

  /**
   * Get the number of CMaps that have been preloaded.
   */
  get preloadCount(): number {
    return this.#preloadCount;
  }

  /**
   * Clear the CMap cache.
   */
  clearCache(): void {
    this.#cache.clear();
  }

  /**
   * Prune expired entries from the cache.
   */
  pruneCache(): number {
    return this.#cache.pruneExpired();
  }

  /**
   * Create a FetchBuiltInCMap-compatible function for use with the existing
   * CMapFactory. This bridges the new async loader to the old interface.
   *
   * @returns A function that fetches CMap data by name.
   */
  createFetchFn(): (name: string) => Promise<CMapRawData> {
    return (name: string) => this.load(name);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch a CMap with concurrency control.
   */
  async #fetchWithConcurrency(name: string): Promise<CMapRawData> {
    // Wait for a concurrency slot if needed.
    if (this.#activeFetches >= this.#options.concurrency) {
      await new Promise<void>((resolve) => {
        this.#fetchQueue.push(resolve);
      });
    }

    this.#activeFetches++;
    const startTime = Date.now();

    this.#eventBus.dispatch(FontEventType.CMapLoadStart, {
      cMapName: name,
      timestamp: startTime,
    });

    try {
      const filename = `${name}${this.#options.cMapPacked ? ".bcmap" : ""}`;
      const cMapData = await this.#fetcher.fetch("cMapUrl", filename);

      const result: CMapRawData = {
        cMapData,
        isCompressed: this.#options.cMapPacked,
      };

      // Cache the result.
      this.#cache.set(name, result);

      const loadTimeMs = Date.now() - startTime;
      this.#eventBus.dispatch(FontEventType.CMapLoadSuccess, {
        cMapName: name,
        loadTimeMs,
        fromCache: false,
        isCompressed: this.#options.cMapPacked,
      });

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.#eventBus.dispatch(FontEventType.CMapLoadError, {
        cMapName: name,
        error,
      });
      throw error;
    } finally {
      this.#activeFetches--;
      // Release the next queued fetch, if any.
      const next = this.#fetchQueue.shift();
      if (next) {
        next();
      }
    }
  }

  /**
   * Get the list of CMap names for a given preload strategy.
   */
  #getCMapNamesForStrategy(
    strategy: CMapPreloadStrategy
  ): readonly string[] {
    switch (strategy) {
      case "eager":
        // Preload all known CMap groups.
        return [
          ...UNICODE_CMAPS,
          ...JAPANESE_CMAPS,
          ...CHINESE_SIMPLIFIED_CMAPS,
          ...CHINESE_TRADITIONAL_CMAPS,
          ...KOREAN_CMAPS,
        ];
      case "japanese":
        return JAPANESE_CMAPS;
      case "chineseSimplified":
        return CHINESE_SIMPLIFIED_CMAPS;
      case "chineseTraditional":
        return CHINESE_TRADITIONAL_CMAPS;
      case "korean":
        return KOREAN_CMAPS;
      case "cjk":
        return [
          ...JAPANESE_CMAPS,
          ...CHINESE_SIMPLIFIED_CMAPS,
          ...CHINESE_TRADITIONAL_CMAPS,
          ...KOREAN_CMAPS,
        ];
      case "unicode":
        return UNICODE_CMAPS;
      case "auto":
        // "auto" defaults to the unicode CMaps which are the most commonly
        // referenced across all CJK documents.
        return UNICODE_CMAPS;
      case "none":
      default:
        return [];
    }
  }
}
