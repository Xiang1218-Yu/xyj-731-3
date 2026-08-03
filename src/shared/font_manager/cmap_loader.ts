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
 * Asynchronous, on-demand CMap loader.
 *
 * The original implementation lived in `PartialEvaluator.fetchBuiltInCMap` and
 * used a plain `Map` for caching.  While the fetch itself was already async,
 * the parsing path called it from multiple call sites without:
 *   - de-duplicating concurrent requests for the same CMap (two pages
 *     requesting `GBK-EUC-H` at the same time would trigger two network
 *     fetches);
 *   - offering a preloading strategy;
 *   - emitting lifecycle events that the viewer could hook into.
 *
 * `CMapLoader` fixes those three gaps while keeping full backwards
 * compatibility: its {@link load} method returns the same `{ cMapData,
 * isCompressed }` shape that `createBuiltInCMap` expects, so it can be
 * plugged in without touching the parser.
 */

import type {
  BinaryFetcher,
  CMapData,
  CMapName,
  ResourceRequest,
} from "./types.ts";
import { cacheKey } from "./types.ts";

export interface CMapLoaderDependencies {
  readonly fetcher: BinaryFetcher;
  /** `true` when the server provides binary `.bcmap` files. */
  readonly cMapPacked: boolean;
  /**
   * Cache for raw CMap bytes.  The loader never inspects the cache
   * implementation, it only uses `get`, `set` and `has`.
   */
  readonly cache: {
    get<T>(key: ReturnType<typeof cacheKey>): T | undefined;
    set<T>(
      key: ReturnType<typeof cacheKey>,
      kind: "cmap",
      value: T,
      size: number
    ): void;
    has(key: ReturnType<typeof cacheKey>): boolean;
  };
  /** Optional lifecycle hooks (the FontManager wires these to the bus). */
  readonly hooks?: {
    onLoadStart?: (name: CMapName) => void;
    onLoadDone?: (
      name: CMapName,
      data: CMapData,
      fromCache: boolean,
      durationMs: number
    ) => void;
    onLoadError?: (name: CMapName, error: Error) => void;
  };
}

export class CMapLoader {
  readonly #deps: CMapLoaderDependencies;

  /**
   * In-flight requests, keyed by CMap name.  Concurrent calls to
   * {@link load} for the same name share the same promise, which both
   * reduces network traffic and prevents cache races.
   */
  readonly #inFlight: Map<CMapName, Promise<CMapData>> = new Map();

  /** Optional lifecycle hooks (the FontManager wires these to the bus). */
  #hooks: CMapLoaderDependencies["hooks"];

  constructor(deps: CMapLoaderDependencies) {
    this.#deps = deps;
    this.#hooks = deps.hooks;
  }

  /**
   * Replace the lifecycle hooks.  Returns the previous hooks so that a
   * temporary installation (e.g. during preload) can be restored afterwards.
   */
  setHooks(
    hooks: CMapLoaderDependencies["hooks"]
  ): CMapLoaderDependencies["hooks"] {
    const previous = this.#hooks;
    this.#hooks = hooks;
    return previous;
  }

  /**
   * Load a built-in CMap.  Results are cached for the lifetime of the
   * document.  The returned promise resolves to the same `{ cMapData,
   * isCompressed }` object that PDF.js' CMap parser consumes.
   */
  async load(name: CMapName): Promise<CMapData> {
    const key = cacheKey("cmap", name);

    // 1. Fast cache path.
    const cached = this.#deps.cache.get<CMapData>(key);
    if (cached) {
      // Emit onLoadDone so progress hooks (e.g. the preloader) account for
      // cache hits as well.
      this.#hooks?.onLoadDone?.(name, cached, /* fromCache = */ true, 0);
      return cached;
    }

    // 2. De-dup concurrent loads.
    const inFlight = this.#inFlight.get(name);
    if (inFlight) {
      return inFlight;
    }

    const request = this.#fetchAndCache(name, key);
    this.#inFlight.set(name, request);
    try {
      return await request;
    } finally {
      // Only delete the in-flight entry when it is still the *same* promise
      // we registered.  On a fetch failure a different concurrent caller may
      // have already started a retry (or another `load()` call may have
      // replaced the entry) by the time this `finally` runs; blindly deleting
      // by name would then tear down that newer in-flight request and break
      // de-duplication for its concurrent waiters.
      if (this.#inFlight.get(name) === request) {
        this.#inFlight.delete(name);
      }
    }
  }

  /**
   * Preload a list of CMaps.  The loader processes names in parallel up to
   * `concurrency`, and failures for individual names do not abort the rest.
   *
   * @returns a tuple `[completed, failed]`.
   */
  async preload(
    names: readonly CMapName[],
    concurrency: number = 4
  ): Promise<{ completed: number; failed: number }> {
    let completed = 0;
    let failed = 0;

    const queue = names.slice();
    const workers: Array<Promise<void>> = [];

    // Do not spawn any workers when there is nothing to do; otherwise an
    // empty input list would still create a no-op worker below.
    if (queue.length === 0) {
      return { completed: 0, failed: 0 };
    }

    const workerCount = Math.min(concurrency, queue.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push(
        (async (): Promise<void> => {
          while (queue.length > 0) {
            const name = queue.shift();
            if (!name) {
              return;
            }
            try {
              await this.load(name);
              completed++;
            } catch {
              failed++;
            }
          }
        })()
      );
    }
    await Promise.all(workers);

    return { completed, failed };
  }

  /**
   * Test for whether a CMap is currently being fetched.  Exposed for
   * diagnostics and tests.
   */
  isLoading(name: CMapName): boolean {
    return this.#inFlight.has(name);
  }

  async #fetchAndCache(
    name: CMapName,
    key: ReturnType<typeof cacheKey>
  ): Promise<CMapData> {
    const start = Date.now();
    this.#hooks?.onLoadStart?.(name);

    const request: ResourceRequest = {
      kind: "cmap",
      name,
      compressed: this.#deps.cMapPacked,
    };

    try {
      const bytes = await this.#deps.fetcher.fetch(request);
      const data: CMapData = {
        cMapData: bytes,
        isCompressed: this.#deps.cMapPacked,
      };
      this.#deps.cache.set(key, "cmap", data, bytes.byteLength);
      this.#hooks?.onLoadDone?.(
        name,
        data,
        /* fromCache = */ false,
        Date.now() - start
      );
      return data;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.#hooks?.onLoadError?.(name, normalized);
      throw normalized;
    }
  }
}
