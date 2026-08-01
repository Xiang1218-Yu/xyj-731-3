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
 * @module font-manager/cmap-loader
 *
 * Asynchronous, on-demand CMap loader.
 *
 * Single responsibility: turn a CMap *name* into loaded {@link LoadedCMap}
 * bytes, asynchronously, with:
 *   - configurable preload strategy (`eager` / `lazy` / `manual`),
 *   - de-duplicated concurrent requests (single-flight),
 *   - transparent caching via {@link FontCache},
 *   - lifecycle events via {@link FontEventBus}.
 *
 * This replaces the previous "synchronous blocking" CMap behaviour: nothing
 * here blocks the caller, and preloading lets the viewer warm the cache before
 * first paint instead of paying the fetch cost during rendering.
 *
 * API compatibility: it consumes a {@link BinaryDataFactoryLike}, which the
 * existing `DOMBinaryDataFactory`/`NodeBinaryDataFactory` already implement, and
 * builds the same `${name}.bcmap` / `${name}` file names as the current code.
 */

import type {
  BinaryDataFactoryLike,
  CMapLoaderConfig,
  LoadedCMap,
} from "./types.js";
import type { FontCache } from "./font-cache.js";
import type { FontEventBus } from "./event-bus.js";

/** Collaborators injected into the loader (keeps it decoupled & testable). */
export interface CMapLoaderDeps {
  readonly cache: FontCache;
  readonly eventBus: FontEventBus;
  /** `null` until a document binds a data source; fetches then throw clearly. */
  readonly factory: BinaryDataFactoryLike | null;
}

export class CMapLoader {
  readonly #config: CMapLoaderConfig;

  readonly #deps: CMapLoaderDeps;

  /**
   * Single-flight map: while a CMap is being fetched, concurrent requests for
   * the same name share the in-flight promise instead of issuing duplicate
   * network fetches.
   */
  readonly #inFlight = new Map<string, Promise<LoadedCMap>>();

  constructor(config: CMapLoaderConfig, deps: CMapLoaderDeps) {
    this.#config = config;
    this.#deps = deps;
  }

  /** The file name (with extension) for a given CMap name. */
  #fileNameFor(name: string): string {
    return this.#config.cMapPacked ? `${name}.bcmap` : name;
  }

  /**
   * Load a single CMap by name, resolving from cache when possible. Concurrent
   * calls for the same name are coalesced.
   *
   * @throws Error when no `cMapUrl`/factory is configured, or the fetch fails.
   */
  async load(name: string): Promise<LoadedCMap> {
    // 1) Fast path: already cached.
    const cached = this.#deps.cache.get("cmap", name);
    if (cached) {
      this.#deps.eventBus.dispatch("cmapLoaded", { name, fromCache: true });
      return cached;
    }

    // 2) Coalesce concurrent misses onto one in-flight promise.
    const pending = this.#inFlight.get(name);
    if (pending) {
      return pending;
    }

    // Attach cleanup to the promise itself, guarded by an *identity* check:
    // only remove the entry if it still points at *this* promise. This closes a
    // race where a failed attempt is retried (installing a new in-flight
    // promise) before the older attempt's cleanup runs — without the guard the
    // stale cleanup would delete the newer promise, letting a concurrent
    // request re-issue a duplicate fetch. On failure the entry is removed so a
    // later call may legitimately retry; on success the value is already in the
    // cache, so subsequent calls hit the fast path above.
    const promise = this.#fetchAndCache(name).finally(() => {
      if (this.#inFlight.get(name) === promise) {
        this.#inFlight.delete(name);
      }
    });
    this.#inFlight.set(name, promise);
    return promise;
  }

  /** Perform the actual fetch, populate the cache, and emit events. */
  async #fetchAndCache(name: string): Promise<LoadedCMap> {
    if (!this.#config.cMapUrl) {
      const message = "Ensure that the `cMapUrl` option is provided.";
      this.#deps.eventBus.dispatch("cmapError", { name, message });
      throw new Error(message);
    }
    if (!this.#deps.factory) {
      const message =
        "FontManager has no binary data factory bound; cannot fetch CMaps.";
      this.#deps.eventBus.dispatch("cmapError", { name, message });
      throw new Error(message);
    }

    try {
      const data = await this.#deps.factory.fetch({
        kind: "cMapUrl",
        filename: this.#fileNameFor(name),
      });
      const loaded: LoadedCMap = {
        name,
        data,
        packed: this.#config.cMapPacked,
      };
      this.#deps.cache.set("cmap", name, loaded, (namespace, key) =>
        this.#deps.eventBus.dispatch("cacheEvicted", { namespace, key })
      );
      this.#deps.eventBus.dispatch("cmapLoaded", { name, fromCache: false });
      return loaded;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.#deps.eventBus.dispatch("cmapError", { name, message });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /**
   * Preload a batch of CMaps. Failures are swallowed *per name* (a missing
   * preload should never break document open); the actual on-demand `load`
   * later will surface any genuine error. Returns the names successfully
   * preloaded.
   */
  async preload(names: readonly string[]): Promise<string[]> {
    const results = await Promise.allSettled(
      names.map(name => this.load(name).then(() => name))
    );
    const loaded: string[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        loaded.push(result.value);
      }
    }
    return loaded;
  }

  /**
   * Run the configured preload strategy. Called once by the manager during
   * configuration. `manual` and `lazy` are no-ops here (lazy loads happen on
   * first `load`; manual is fully caller-driven).
   */
  async runPreloadStrategy(): Promise<string[]> {
    if (this.#config.preloadStrategy === "eager") {
      return this.preload(this.#config.preloadNames);
    }
    return [];
  }

  /** The strategy this loader was configured with (diagnostics). */
  get preloadStrategy(): CMapLoaderConfig["preloadStrategy"] {
    return this.#config.preloadStrategy;
  }
}
