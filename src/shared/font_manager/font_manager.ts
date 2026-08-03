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
 * `FontManager` is the single, unified entry point for every font-related
 * concern in the refactored PDF.js:
 *
 *  - CMap loading (asynchronous, on-demand, with optional preloading);
 *  - base-14 standard font data loading;
 *  - a size-aware cache shared across all resources;
 *  - an intelligent font fallback chain;
 *  - a strongly-typed event bus that the viewer and tests can subscribe to;
 *  - a registry of {@link FontDescriptor}s for fonts the document uses.
 *
 * The class follows the **singleton** pattern via {@link FontManager.getInstance}.
 * A singleton is appropriate here because the font sub-system is inherently
 * process-global in PDF.js: the cache, the in-flight de-duplication maps and
 * the event listeners must all be shared between documents to deliver the
 * performance gains promised by the refactoring.  The singleton can still be
 * {@link FontManager.reset | reset} in tests to guarantee isolation.
 *
 * Every collaborator (cache, loaders, fallback chain, event bus) follows the
 * single-responsibility principle: `FontManager` only wires them together and
 * translates their callbacks into bus events.
 */

import { CMapLoader } from "./cmap_loader.ts";
import { EventBus } from "./event_bus.ts";
import {
  FontFallbackChain,
  type FontAvailabilityChecker,
} from "./fallback_chain.ts";
import { FontCache } from "./font_cache.ts";
import { StandardFontLoader } from "./standard_font_loader.ts";
import {
  asCMapName,
  asFontName,
  type BinaryFetcher,
  type CMapData,
  type CMapName,
  type CacheOptions,
  type CacheStats,
  COMMON_CMAP_NAMES,
  DEFAULT_CACHE_OPTIONS,
  DEFAULT_PRELOAD_STRATEGY,
  type FallbackEntry,
  type FallbackStrategyName,
  type FontDescriptor,
  type FontManagerEventMap,
  type FontManagerOptions,
  type FontName,
  type PreloadStrategy,
} from "./types.ts";

export interface ResolveFontResult {
  readonly resolved: string;
  readonly chain: readonly FallbackEntry[];
}

export class FontManager {
  static #instance: FontManager | null = null;

  readonly #bus: EventBus;

  readonly #cache: FontCache;

  readonly #fallback: FontFallbackChain;

  #cmapLoader: CMapLoader | null = null;

  #standardFontLoader: StandardFontLoader | null = null;

  #options: FontManagerOptions;

  #preloadStrategy: PreloadStrategy;

  /** Registered font descriptors, keyed by their `loadedName`. */
  readonly #registry: Map<FontName, FontDescriptor> = new Map();

  /** `true` once {@link init} has been called at least once. */
  #initialized = false;

  private constructor() {
    this.#bus = new EventBus();
    this.#cache = new FontCache();
    this.#fallback = new FontFallbackChain();
    this.#options = {};
    this.#preloadStrategy = DEFAULT_PRELOAD_STRATEGY;

    // Re-emit cache evictions on the event bus so external observers do not
    // need a direct reference to the cache.
    this.#cache.setEvictionListener(({ key, reason }) => {
      this.#bus.emit("cache:evict", { key, reason });
    });
  }

  /**
   * Return the process-wide `FontManager` instance.
   */
  static getInstance(): FontManager {
    if (!FontManager.#instance) {
      FontManager.#instance = new FontManager();
    }
    return FontManager.#instance;
  }

  /**
   * Tear down the singleton.  Intended for tests; in production the cache is
   * cleared document-by-document through {@link clear}.
   */
  static reset(): void {
    if (FontManager.#instance) {
      FontManager.#instance.destroy();
      FontManager.#instance = null;
    }
  }

  /**
   * Configure the manager.  May be called multiple times; later calls merge
   * with the previous configuration.  The first call wires up the CMap and
   * standard-font loaders and, if a preload strategy is active, kicks it off
   * asynchronously.
   */
  init(options: FontManagerOptions = {}): this {
    this.#options = { ...this.#options, ...options };

    const cacheOptions: CacheOptions = {
      ...DEFAULT_CACHE_OPTIONS,
      ...this.#options.cache,
    };
    this.#cache.configure?.(cacheOptions);

    this.#preloadStrategy = {
      ...DEFAULT_PRELOAD_STRATEGY,
      ...this.#options.preload,
    };

    if (this.#options.fetcher) {
      this.#buildLoaders(this.#options.fetcher);
    }

    this.#initialized = true;

    // Kick off preloading asynchronously; never block `init`.
    if (this.#cmapLoader || this.#standardFontLoader) {
      void this.#runPreload();
    }
    return this;
  }

  /**
   * Register a {@link FontAvailabilityChecker} used by the fallback chain.
   */
  setFontAvailabilityChecker(checker: FontAvailabilityChecker): void {
    this.#fallback.setChecker?.(checker);
  }

  /**
   * Register a font descriptor.  Registered fonts can later be queried via
   * {@link getFont} and are considered by the fallback chain.
   */
  registerFont(descriptor: FontDescriptor): void {
    this.#registry.set(descriptor.loadedName, descriptor);
    this.#bus.emit("font:registered", { name: descriptor.loadedName });
  }

  /**
   * Look up a previously registered font descriptor.
   */
  getFont(name: FontName): FontDescriptor | undefined {
    return this.#registry.get(name);
  }

  /**
   * Return a snapshot of every registered font.  The returned array is a
   * copy; mutating it does not affect the registry.
   */
  listFonts(): readonly FontDescriptor[] {
    return Array.from(this.#registry.values());
  }

  /* ---------------------------------------------------------------------- */
  /* CMap loading                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Load a built-in CMap asynchronously.  The result is cached and
   * concurrently-identical requests are de-duplicated.
   */
  async loadCMap(name: string | CMapName): Promise<CMapData> {
    const cmapName = typeof name === "string" ? asCMapName(name) : name;
    const loader = this.#requireLoader("CMap");

    this.#bus.emit("resource:load:start", {
      kind: "cmap",
      name: cmapName,
    });
    const start = Date.now();
    const fromCache = this.#cache.has(FontCache.keyFor("cmap", cmapName));
    try {
      const data = await loader.load(cmapName);
      this.#bus.emit("resource:load:done", {
        kind: "cmap",
        name: cmapName,
        durationMs: Date.now() - start,
        size: data.cMapData.byteLength,
        fromCache,
      });
      return data;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.#bus.emit("resource:load:error", {
        kind: "cmap",
        name: cmapName,
        error: normalized,
      });
      throw normalized;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Standard font loading                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Load raw standard-font bytes.  Returns `null` when the requested name is
   * not one of the PDF base-14 fonts, matching the historical contract.
   */
  async loadStandardFont(
    name: string | FontName
  ): Promise<Uint8Array | null> {
    const fontName = typeof name === "string" ? asFontName(name) : name;
    const loader = this.#requireStandardFontLoader();

    this.#bus.emit("resource:load:start", {
      kind: "standardFont",
      name: fontName,
    });
    const start = Date.now();
    const fromCache = this.#cache.has(
      FontCache.keyFor("standardFont", fontName)
    );
    try {
      const bytes = await loader.load(fontName);
      if (bytes) {
        this.#bus.emit("resource:load:done", {
          kind: "standardFont",
          name: fontName,
          durationMs: Date.now() - start,
          size: bytes.byteLength,
          fromCache,
        });
      }
      return bytes;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.#bus.emit("resource:load:error", {
        kind: "standardFont",
        name: fontName,
        error: normalized,
      });
      throw normalized;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Fallback                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolve a font descriptor to the best available fallback.
   */
  async resolveFallback(
    descriptor: FontDescriptor,
    codePoints: readonly number[] = [],
    strategy: FallbackStrategyName = this.#options.fallbackStrategy ?? "default"
  ): Promise<ResolveFontResult> {
    const result = await this.#fallback.resolve(descriptor, codePoints, strategy);
    this.#bus.emit("font:fallback", {
      requested: (descriptor.name ?? descriptor.loadedName) as string,
      resolved: result.resolved,
      chain: result.chain,
    });
    return result;
  }

  /**
   * Build the fallback chain without probing availability.  Useful for
   * diagnostics / UI affordances.
   */
  buildFallbackChain(descriptor: FontDescriptor): readonly FallbackEntry[] {
    return this.#fallback.buildChain(descriptor);
  }

  /* ---------------------------------------------------------------------- */
  /* Cache                                                                  */
  /* ---------------------------------------------------------------------- */

  getCacheStats(): CacheStats {
    return this.#cache.getStats();
  }

  /**
   * Return a cached CMap payload without triggering a fetch, or `undefined`
   * when nothing is cached for `name`.  This is a read-only peek used by the
   * legacy cache bridge; normal callers should use {@link loadCMap}.
   */
  peekCachedCMap(name: string | CMapName): CMapData | undefined {
    return this.#cache.get<CMapData>(FontCache.keyFor("cmap", name));
  }

  /**
   * Return cached standard-font bytes without triggering a fetch, or
   * `undefined` when nothing is cached for `name`.
   */
  peekCachedStandardFont(name: string | FontName): Uint8Array | undefined {
    return this.#cache.get<Uint8Array>(
      FontCache.keyFor("standardFont", name)
    );
  }

  clearCache(): void {
    this.#cache.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Event bus                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Subscribe to a FontManager event.  Returns an unsubscribe function.
   */
  on<K extends keyof FontManagerEventMap>(
    event: K,
    listener: (payload: FontManagerEventMap[K]) => void
  ): () => void {
    return this.#bus.on(event, listener);
  }

  once<K extends keyof FontManagerEventMap>(
    event: K,
    listener: (payload: FontManagerEventMap[K]) => void
  ): () => void {
    return this.#bus.once(event, listener);
  }

  off<K extends keyof FontManagerEventMap>(
    event: K,
    listener: (payload: FontManagerEventMap[K]) => void
  ): void {
    this.#bus.off(event, listener);
  }

  /**
   * Re-emit an event that originated in another thread/context (typically a
   * font lifecycle event forwarded from the worker over the message channel).
   *
   * This is intentionally a distinct method rather than exposing the raw
   * {@link EventBus}: callers cannot forge arbitrary events, and the event
   * name is validated against {@link FontManagerEventMap}.
   */
  dispatchWorkerEvent<K extends keyof FontManagerEventMap>(
    event: K,
    payload: FontManagerEventMap[K]
  ): void {
    this.#bus.emit(event, payload);
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Clear all document-scoped state: the registry, the cache and any pending
   * preload state.  Configuration is preserved so the next document can reuse
   * the manager without calling {@link init} again.
   */
  clear(): void {
    this.#registry.clear();
    this.#cache.clear();
  }

  destroy(): void {
    this.clear();
    this.#bus.clear();
    this.#cmapLoader = null;
    this.#standardFontLoader = null;
    this.#initialized = false;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  /* ---------------------------------------------------------------------- */
  /* Internal                                                               */
  /* ---------------------------------------------------------------------- */

  #buildLoaders(fetcher: BinaryFetcher): void {
    this.#cmapLoader = new CMapLoader({
      fetcher,
      cMapPacked: this.#options.cMapPacked ?? true,
      cache: this.#cache,
    });
    this.#standardFontLoader = new StandardFontLoader({
      fetcher,
      cache: this.#cache,
    });
  }

  async #runPreload(): Promise<void> {
    const strategy = this.#preloadStrategy;
    const cmapNames: CMapName[] = [];
    if (strategy.commonCMaps) {
      cmapNames.push(...COMMON_CMAP_NAMES);
    }
    cmapNames.push(...strategy.cMapNames);

    const allNames: string[] = [
      ...cmapNames,
      ...strategy.standardFontNames,
    ];
    const total = allNames.length;
    if (total === 0) {
      return;
    }

    this.#bus.emit("preload:start", { total });
    let completed = 0;
    let failed = 0;

    // Progress is driven by the onLoad* hooks so the counter is incremented
    // exactly once per resource, regardless of whether it was fetched or
    // served from cache.
    const onItemDone = (name: string, ok: boolean): void => {
      if (ok) {
        completed++;
      } else {
        failed++;
      }
      this.#bus.emit("preload:progress", { completed, total, name });
    };

    const cmapHooks = {
      onLoadDone: (name: CMapName): void => onItemDone(name, true),
      onLoadError: (name: CMapName): void => onItemDone(name, false),
    };
    const previousCMapHooks = this.#cmapLoader?.setHooks?.(cmapHooks);

    const fontHooks = {
      onLoadDone: (name: FontName): void => onItemDone(name, true),
      onLoadError: (name: FontName): void => onItemDone(name, false),
    };
    const previousFontHooks =
      this.#standardFontLoader?.setHooks?.(fontHooks);

    try {
      const [cmapResult, fontResult] = await Promise.all([
        this.#cmapLoader?.preload(cmapNames, strategy.concurrency),
        this.#standardFontLoader?.preload(
          strategy.standardFontNames,
          strategy.concurrency
        ),
      ]);
      completed = cmapResult?.completed ?? 0;
      failed = cmapResult?.failed ?? 0;
      completed += fontResult?.completed ?? 0;
      failed += fontResult?.failed ?? 0;
    } finally {
      this.#cmapLoader?.setHooks?.(previousCMapHooks);
      this.#standardFontLoader?.setHooks?.(previousFontHooks);
    }

    this.#bus.emit("preload:done", { completed, failed });
  }

  #requireLoader(what: string): CMapLoader {
    if (!this.#cmapLoader) {
      throw new Error(
        `FontManager: cannot load ${what} before init() is called with a fetcher.`
      );
    }
    return this.#cmapLoader;
  }

  #requireStandardFontLoader(): StandardFontLoader {
    if (!this.#standardFontLoader) {
      throw new Error(
        "FontManager: cannot load standard fonts before init() is called with a fetcher."
      );
    }
    return this.#standardFontLoader;
  }
}
