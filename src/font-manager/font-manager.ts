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
 * @module font-manager/font-manager
 *
 * The unified FontManager facade — the single entry point for the subsystem.
 *
 * Single responsibility (at this layer): *composition & lifecycle*. It wires
 * together the four single-purpose collaborators (event bus, cache, CMap
 * loader, fallback resolver) and exposes a small, stable API. It contains no
 * fetching/parsing/fallback *logic* itself — that lives in the collaborators.
 *
 * Singleton: `FontManager.getInstance()` returns the process-wide instance.
 * `configure()` is idempotent-friendly (re-configuring rebuilds the loader with
 * new options while preserving the cache when capacity is unchanged).
 *
 * API compatibility: `configure()` accepts the same option *names* the viewer
 * already passes to `getDocument` (`cMapUrl`, `cMapPacked`,
 * `standardFontDataUrl`, plus a `binaryDataFactory` implementing the existing
 * factory contract), so adopting the manager requires no changes to callers'
 * option plumbing.
 */

import type {
  BinaryDataFactoryLike,
  CacheStats,
  CMapLoaderConfig,
  FallbackChain,
  FontDescriptor,
  FontEventListener,
  FontEventListenerOptions,
  FontEventName,
  FontManagerOptions,
  LoadedCMap,
} from "./types.js";
import { CMapLoader } from "./cmap-loader.js";
import { FallbackResolver } from "./fallback-resolver.js";
import { FontCache } from "./font-cache.js";
import { FontEventBus } from "./event-bus.js";

/** Default cache capacity when the caller does not specify one. */
const DEFAULT_CACHE_CAPACITY = 256;

/**
 * Resolve caller options into a fully-populated, immutable loader config so the
 * rest of the subsystem never deals with `undefined`.
 */
function buildCMapConfig(options: FontManagerOptions): CMapLoaderConfig {
  return {
    cMapUrl: options.cMapUrl ?? null,
    // Matches the existing default: `cMapPacked !== false`.
    cMapPacked: options.cMapPacked !== false,
    preloadStrategy: options.cMapPreloadStrategy ?? "lazy",
    preloadNames: options.cMapPreloadNames ?? [],
  };
}

export class FontManager {
  /** The process-wide singleton instance. */
  static #instance: FontManager | null = null;

  #eventBus: FontEventBus;

  #cache: FontCache;

  #resolver: FallbackResolver;

  #cmapLoader: CMapLoader;

  #factory: BinaryDataFactoryLike | null;

  #standardFontDataUrl: string | null;

  #configured: boolean;

  /** Private: use {@link FontManager.getInstance}. */
  private constructor() {
    this.#eventBus = new FontEventBus();
    this.#cache = new FontCache(DEFAULT_CACHE_CAPACITY);
    this.#resolver = new FallbackResolver();
    this.#factory = null;
    this.#standardFontDataUrl = null;
    this.#configured = false;
    this.#cmapLoader = new CMapLoader(buildCMapConfig({}), {
      cache: this.#cache,
      eventBus: this.#eventBus,
      factory: null,
    });
  }

  /** Return (creating on first use) the singleton instance. */
  static getInstance(): FontManager {
    return (FontManager.#instance ??= new FontManager());
  }

  /**
   * Configure the manager with document/build options. Safe to call multiple
   * times; the CMap loader is rebuilt with the new config. If `cacheCapacity`
   * differs from the current cache, a fresh cache is created (old entries are
   * dropped); otherwise the existing cache — and its warm entries — is kept.
   *
   * Runs the preload strategy (awaitable via the returned promise) so callers
   * can warm the cache before first paint.
   */
  async configure(options: FontManagerOptions): Promise<void> {
    this.#factory = options.binaryDataFactory ?? null;
    this.#standardFontDataUrl = options.standardFontDataUrl ?? null;

    const capacity = options.cacheCapacity ?? this.#cache.capacity;
    if (capacity !== this.#cache.capacity) {
      this.#cache = new FontCache(capacity);
    }

    this.#cmapLoader = new CMapLoader(buildCMapConfig(options), {
      cache: this.#cache,
      eventBus: this.#eventBus,
      factory: this.#factory,
    });
    this.#configured = true;

    await this.#cmapLoader.runPreloadStrategy();
  }

  // ---------------------------------------------------------------------------
  // CMap API (async, on-demand)
  // ---------------------------------------------------------------------------

  /** Load a CMap by name (async, cached, deduplicated). */
  loadCMap(name: string): Promise<LoadedCMap> {
    return this.#cmapLoader.load(name);
  }

  /** Explicitly preload CMaps (used with the `"manual"` strategy). */
  preloadCMaps(names: readonly string[]): Promise<string[]> {
    return this.#cmapLoader.preload(names);
  }

  // ---------------------------------------------------------------------------
  // Standard font data API (async, cached)
  // ---------------------------------------------------------------------------

  /**
   * Fetch standard font program data by file name, cached & deduplicated. Emits
   * `fontDataLoaded`. Throws with a clear message when unbound/unconfigured.
   */
  async loadFontData(filename: string): Promise<Uint8Array> {
    if (!this.#standardFontDataUrl) {
      throw new Error("Ensure that the `standardFontDataUrl` option is provided.");
    }
    if (!this.#factory) {
      throw new Error(
        "FontManager has no binary data factory bound; cannot fetch font data."
      );
    }
    const factory = this.#factory;
    const { value, fromCache } = await this.#cache.getOrCreate(
      "fontData",
      filename,
      () => factory.fetch({ kind: "standardFontDataUrl", filename }),
      (namespace, key) =>
        this.#eventBus.dispatch("cacheEvicted", { namespace, key })
    );
    this.#eventBus.dispatch("fontDataLoaded", { filename, fromCache });
    return value;
  }

  // ---------------------------------------------------------------------------
  // Fallback API (smart chain, cached)
  // ---------------------------------------------------------------------------

  /**
   * Resolve — and cache — the fallback chain for `descriptor`. Emits
   * `fallbackResolved`. The chain is guaranteed non-empty and to end in a
   * generic family.
   */
  resolveFallback(descriptor: FontDescriptor): FallbackChain {
    // The cache key must capture *every* input that changes the resolved chain.
    // Style flags (serif/monospace/italic/bold) alter both the standard-font
    // classification and the generic terminator, so bold/italic variants of the
    // same base font must NOT share a cache entry.
    const key = [
      descriptor.baseFontName,
      descriptor.type,
      descriptor.embedded ? 1 : 0,
      descriptor.isSerif ? 1 : 0,
      descriptor.isMonospace ? 1 : 0,
      descriptor.isItalic ? 1 : 0,
      descriptor.isBold ? 1 : 0,
    ].join("|");
    const cached = this.#cache.get("fallback", key);
    if (cached) {
      this.#eventBus.dispatch("fallbackResolved", {
        requested: cached.requested,
        chain: cached,
      });
      return cached;
    }
    const chain = this.#resolver.resolve(descriptor);
    this.#cache.set("fallback", key, chain, (namespace, evictedKey) =>
      this.#eventBus.dispatch("cacheEvicted", { namespace, key: evictedKey })
    );
    this.#eventBus.dispatch("fallbackResolved", {
      requested: chain.requested,
      chain,
    });
    return chain;
  }

  // ---------------------------------------------------------------------------
  // Event bus passthrough (typed)
  // ---------------------------------------------------------------------------

  /** Subscribe to a font-lifecycle event (typed payload). */
  on<K extends FontEventName>(
    eventName: K,
    listener: FontEventListener<K>,
    options?: FontEventListenerOptions
  ): void {
    this.#eventBus.on(eventName, listener, options);
  }

  /** Unsubscribe a previously-registered listener. */
  off<K extends FontEventName>(
    eventName: K,
    listener: FontEventListener<K>
  ): void {
    this.#eventBus.off(eventName, listener);
  }

  // ---------------------------------------------------------------------------
  // Introspection & lifecycle
  // ---------------------------------------------------------------------------

  /** Cache statistics snapshot (diagnostics / tests). */
  get cacheStats(): CacheStats {
    return this.#cache.stats;
  }

  /** Whether {@link configure} has been called. */
  get isConfigured(): boolean {
    return this.#configured;
  }

  /** The direct event bus reference, for advanced integration. */
  get eventBus(): FontEventBus {
    return this.#eventBus;
  }

  /**
   * Reset internal state (cache + listeners + config). Primarily for test
   * isolation and for tearing down between documents. Does *not* discard the
   * singleton itself.
   */
  reset(): void {
    this.#cache.clear();
    this.#eventBus.clear();
    this.#factory = null;
    this.#standardFontDataUrl = null;
    this.#configured = false;
    this.#cmapLoader = new CMapLoader(buildCMapConfig({}), {
      cache: this.#cache,
      eventBus: this.#eventBus,
      factory: null,
    });
  }

  /**
   * Test-only: drop the singleton so the next {@link getInstance} builds fresh.
   * Guarded so it is obvious this is not part of the production surface.
   */
  static resetInstanceForTesting(): void {
    FontManager.#instance = null;
  }
}
