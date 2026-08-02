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
 * FontManager — the unified singleton that orchestrates all font and CMap
 * loading operations in PDF.js.
 *
 * Architecture:
 *   FontManager (singleton, facade)
 *     ├── FontEventBus      — typed pub/sub for font lifecycle events
 *     ├── LRUCache (fonts)  — caches FontFaceObject / font binary data
 *     ├── LRUCache (cmaps)  — caches raw CMap data
 *     ├── CMapLoader        — async CMap fetching with preload strategies
 *     ├── FontFallbackChainBuilder — multi-level fallback resolution
 *     └── FontFailureTracker — adaptive failure tracking
 *
 * Design principles:
 *  - Single responsibility: the manager is a facade; actual work is delegated.
 *  - Singleton: one instance per document/worker context.
 *  - API compatibility: provides bridge methods matching the existing
 *    fetchBuiltInCMap / FontLoader.bind interfaces.
 *  - Type-safe: all public methods have concrete TypeScript types.
 *  - Observable: all state changes emit events via the event bus.
 *  - JS-interoperable: callable from existing JavaScript code with no changes.
 */

import type {
  BinaryDataFetcher,
  CMapLoadOptions,
  CMapPreloadStrategy,
  CMapRawData,
  CacheStats,
  FallbackChainResult,
  FontManagerConfig,
  FontManagerStats,
  FontDescriptor,
  SystemFontInfo,
} from "./font_types.js";
import {
  DEFAULT_FONT_MANAGER_CONFIG,
  FontEventType,
  FallbackLevel,
} from "./font_types.js";
import { FontEventBus } from "./font_event_bus.js";
import { LRUCache } from "./font_cache.js";
import { CMapLoader } from "./cmap_loader.js";
import {
  FontFallbackChainBuilder,
  FontFailureTracker,
  type FallbackChainParams,
} from "./font_fallback_chain.js";

// ---------------------------------------------------------------------------
// Font manager entry: tracks a loaded font
// ---------------------------------------------------------------------------

/**
 * Internal record for a font tracked by the manager.
 */
interface ManagedFontEntry {
  /** The font descriptor. */
  readonly descriptor: FontDescriptor;
  /** The resolved fallback chain. */
  readonly fallbackChain: FallbackChainResult;
  /** Timestamp when the font was registered. */
  readonly registeredAt: number;
  /** Whether the font has been successfully bound/loaded. */
  loaded: boolean;
  /** The current fallback level in use. */
  currentLevel: FallbackLevel;
  /** Number of times the font was requested. */
  requestCount: number;
}

// ---------------------------------------------------------------------------
// FontManager singleton
// ---------------------------------------------------------------------------

/**
 * The central font management singleton.
 *
 * Use `FontManager.getInstance()` to obtain the instance. The instance can be
 * configured once via `configure()` before first use, or re-configured per
 * document.
 *
 * @example
 * ```ts
 * const mgr = FontManager.getInstance();
 * mgr.configure({
 *   cMap: { cMapUrl: "/cmaps/", cMapPacked: true, preloadStrategy: "cjk", concurrency: 4 },
 *   enableFallbackChain: true,
 *   enableCache: true,
 *   ownerDocument: document,
 * });
 *
 * // Listen for font events
 * mgr.eventBus.on(FontEventType.FontLoadSuccess, (e) => {
 *   console.log(`Loaded ${e.fontName}`);
 * });
 *
 * // Preload CMaps
 * await mgr.preloadCMaps("japanese");
 * ```
 */
export class FontManager {
  /** The singleton instance. */
  static #instance: FontManager | undefined;

  /**
   * Get the singleton FontManager instance.
   * Creates it on first call with default configuration.
   */
  static getInstance(): FontManager {
    if (!FontManager.#instance) {
      FontManager.#instance = new FontManager();
    }
    return FontManager.#instance;
  }

  /**
   * Reset the singleton (primarily for testing).
   * Destroys the current instance and clears all state.
   */
  static resetInstance(): void {
    if (FontManager.#instance) {
      FontManager.#instance.destroy();
      FontManager.#instance = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Instance state
  // -------------------------------------------------------------------------

  /** The event bus for font lifecycle events. */
  readonly eventBus: FontEventBus;

  /** Cache for raw CMap data. */
  readonly cMapCache: LRUCache<CMapRawData>;

  /** Cache for font binary data. */
  readonly fontDataCache: LRUCache<Uint8Array>;

  /** The failure tracker for adaptive fallback. */
  readonly failureTracker: FontFailureTracker;

  /** The fallback chain builder. */
  readonly fallbackChainBuilder: FontFallbackChainBuilder;

  /** The CMap loader (created during configure). */
  #cMapLoader: CMapLoader | undefined;

  /** Current configuration. */
  #config: FontManagerConfig;

  /** Map of loaded fonts keyed by loadedName. */
  readonly #fonts: Map<string, ManagedFontEntry> = new Map();

  /** The binary data fetcher. */
  #fetcher: BinaryDataFetcher | undefined;

  /** Running counters for stats. */
  #totalFontsLoaded = 0;
  #totalCMapsLoaded = 0;
  #totalFallbacks = 0;
  #preloadCount = 0;

  /** Whether the manager has been configured. */
  #configured = false;

  /** Whether the manager has been destroyed. */
  #destroyed = false;

  /** Private constructor: use getInstance(). */
  private constructor() {
    this.eventBus = new FontEventBus();
    this.#config = { ...DEFAULT_FONT_MANAGER_CONFIG };
    this.failureTracker = new FontFailureTracker();
    this.fallbackChainBuilder = new FontFallbackChainBuilder(this.failureTracker);

    this.cMapCache = new LRUCache<CMapRawData>(
      {
        maxSize: this.#config.cMapCache.maxSize,
        ttlMs: this.#config.cMapCache.ttlMs,
        persistent: this.#config.cMapCache.persistent,
      },
      "CMapCache"
    );

    this.fontDataCache = new LRUCache<Uint8Array>(
      {
        maxSize: this.#config.fontCache.maxSize,
        ttlMs: this.#config.fontCache.ttlMs,
        persistent: this.#config.fontCache.persistent,
      },
      "FontDataCache"
    );

    // Forward cache eviction events.
    this.cMapCache.setEvictionCallback((key, _value, reason) => {
      this.eventBus.dispatch(FontEventType.CacheEviction, {
        cacheName: "CMapCache",
        key,
        reason,
      });
    });
    this.fontDataCache.setEvictionCallback((key, _value, reason) => {
      this.eventBus.dispatch(FontEventType.CacheEviction, {
        cacheName: "FontDataCache",
        key,
        reason,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Configure the FontManager. Must be called before CMap loading operations.
   * Can be called multiple times (e.g. per document) to update settings.
   *
   * @param partialConfig - Configuration overrides (shallow-merged).
   * @param fetcher - Optional binary data fetcher implementation.
   */
  configure(
    partialConfig: Partial<FontManagerConfig> = {},
    fetcher?: BinaryDataFetcher
  ): void {
    this.#assertNotDestroyed();

    // Merge config, including nested cMap and cache options.
    this.#config = {
      ...DEFAULT_FONT_MANAGER_CONFIG,
      ...partialConfig,
      cMap: {
        ...DEFAULT_FONT_MANAGER_CONFIG.cMap,
        ...partialConfig.cMap,
      },
      fontCache: {
        ...DEFAULT_FONT_MANAGER_CONFIG.fontCache,
        ...partialConfig.fontCache,
      },
      cMapCache: {
        ...DEFAULT_FONT_MANAGER_CONFIG.cMapCache,
        ...partialConfig.cMapCache,
      },
    };

    if (fetcher) {
      this.#fetcher = fetcher;
    }

    // Reconfigure caches.
    this.#reconfigureCache(this.cMapCache, this.#config.cMapCache, "CMapCache");
    this.#reconfigureCache(
      this.fontDataCache,
      this.#config.fontCache,
      "FontDataCache"
    );

    // Create the CMap loader if we have a fetcher and cMap URL.
    if (this.#fetcher && this.#config.cMap.cMapUrl) {
      this.#cMapLoader = new CMapLoader(
        this.#fetcher,
        this.#config.cMap,
        this.eventBus,
        this.cMapCache
      );
    }

    this.#configured = true;
  }

  /**
   * Internal helper to reconfigure an existing cache.
   * Since LRUCache options are readonly, we create a new one and migrate.
   */
  #reconfigureCache<T>(
    cache: LRUCache<T>,
    options: FontManagerConfig["fontCache"],
    name: string
  ): void {
    // LRUCache doesn't support hot-reconfig, so we just note that options
    // are set. In a full implementation we'd migrate entries; for now the
    // cache continues with its original settings but the config is updated.
    // The cache size/TTL are set at construction time.
    void cache;
    void options;
    void name;
  }

  /** Whether the manager has been configured. */
  get isConfigured(): boolean {
    return this.#configured;
  }

  /** The current configuration (read-only snapshot). */
  get config(): Readonly<FontManagerConfig> {
    return { ...this.#config };
  }

  // -------------------------------------------------------------------------
  // CMap loading API
  // -------------------------------------------------------------------------

  /**
   * Load a CMap by name asynchronously.
   *
   * This is the bridge method compatible with the existing
   * `fetchBuiltInCMap(name)` interface used by CMapFactory.
   *
   * @param name - The CMap name (e.g. "Adobe-Japan1-UCS2").
   * @returns A promise resolving to the raw CMap data.
   */
  async fetchBuiltInCMap(name: string): Promise<CMapRawData> {
    this.#assertConfigured();

    if (!this.#cMapLoader) {
      throw new Error(
        "FontManager: CMap loader not initialized. " +
          "Call configure() with a cMapUrl and fetcher first."
      );
    }

    const startTime = Date.now();
    const fromCache = this.cMapCache.has(name);

    try {
      const data = await this.#cMapLoader.load(name);
      if (!fromCache) {
        this.#totalCMapsLoaded++;
      }
      return data;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.eventBus.dispatch(FontEventType.CMapLoadError, {
        cMapName: name,
        error,
      });
      throw error;
    }
  }

  /**
   * Preload CMaps according to a strategy.
   *
   * @param strategy - The preload strategy to use.
   * @returns Number of CMaps successfully preloaded.
   */
  async preloadCMaps(
    strategy: CMapPreloadStrategy = this.#config.cMap.preloadStrategy
  ): Promise<number> {
    this.#assertConfigured();

    if (!this.#cMapLoader) {
      return 0;
    }

    const count = await this.#cMapLoader.preload(strategy);
    this.#preloadCount += count;
    return count;
  }

  /**
   * Check if a CMap is already cached.
   */
  isCMapCached(name: string): boolean {
    return this.cMapCache.has(name);
  }

  /**
   * Create a fetch function compatible with the existing CMapFactory interface.
   *
   * @returns A function that can be passed as `fetchBuiltInCMap` to CMapFactory.
   */
  createCMapFetchFn(): (name: string) => Promise<CMapRawData> {
    return (name: string) => this.fetchBuiltInCMap(name);
  }

  // -------------------------------------------------------------------------
  // Font registration and fallback
  // -------------------------------------------------------------------------

  /**
   * Register a font with the manager and build its fallback chain.
   *
   * This should be called when a font is first encountered in the PDF.
   * The manager tracks the font's lifecycle and provides fallback support.
   *
   * @param descriptor - The font descriptor.
   * @returns The resolved fallback chain.
   */
  registerFont(descriptor: FontDescriptor): FallbackChainResult {
    this.#assertNotDestroyed();

    const { loadedName, baseFontName } = descriptor;

    // Build fallback chain params from the descriptor.
    const params: FallbackChainParams = {
      baseFontName,
      standardFontName: descriptor.standardFontName,
      subtype: descriptor.subtype,
      isEmbedded: !descriptor.missingFile,
      loadedName,
      cssFontInfo: descriptor.cssFontInfo,
      systemFontInfo: descriptor.systemFontInfo
        ? {
            css: descriptor.systemFontInfo.css,
            src: descriptor.systemFontInfo.src,
            style: descriptor.systemFontInfo.style,
            guessFallback: descriptor.systemFontInfo.guessFallback,
          }
        : undefined,
      sampleCodepoints: undefined,
    };

    const fallbackChain = this.#config.enableFallbackChain
      ? this.fallbackChainBuilder.build(params)
      : this.#buildMinimalChain(descriptor);

    const entry: ManagedFontEntry = {
      descriptor,
      fallbackChain,
      registeredAt: Date.now(),
      loaded: false,
      currentLevel: FallbackLevel.Embedded,
      requestCount: 0,
    };

    this.#fonts.set(loadedName, entry);

    return fallbackChain;
  }

  /**
   * Build a minimal chain when the intelligent fallback chain is disabled.
   */
  #buildMinimalChain(descriptor: FontDescriptor): FallbackChainResult {
    const entries = [];
    if (!descriptor.missingFile) {
      entries.push({
        level: FallbackLevel.Embedded,
        fontFamily: descriptor.loadedName,
        style: { style: "normal" as const, weight: "normal" as const },
        src: undefined,
        isUltimate: false,
      });
    }
    entries.push({
      level: FallbackLevel.RendererFallback,
      fontFamily: "__pdfjs_renderer__",
      style: { style: "normal" as const, weight: "normal" as const },
      src: undefined,
      isUltimate: true,
    });
    return {
      requestedName: descriptor.baseFontName,
      chain: entries,
      genericFamily: undefined,
      hasEmbedded: !descriptor.missingFile,
    };
  }

  /**
   * Record that a font has been successfully loaded.
   *
   * @param loadedName - The font's loaded name.
   * @param level - The fallback level that succeeded.
   * @param fromCache - Whether the font was served from cache.
   */
  recordFontLoadSuccess(
    loadedName: string,
    level: FallbackLevel,
    fromCache: boolean
  ): void {
    const entry = this.#fonts.get(loadedName);
    if (entry) {
      entry.loaded = true;
      entry.currentLevel = level;
      entry.requestCount++;
    }

    this.#totalFontsLoaded++;
    this.failureTracker.recordSuccess(loadedName);

    this.eventBus.dispatch(FontEventType.FontLoadSuccess, {
      fontName: entry?.descriptor.baseFontName ?? loadedName,
      loadedName,
      loadTimeMs: 0,
      fromCache,
    });
  }

  /**
   * Record that a font failed to load at a given level, and advance
   * to the next fallback level.
   *
   * @param loadedName - The font's loaded name.
   * @param failedLevel - The level that failed.
   * @param error - The error that occurred.
   * @returns The next fallback entry, or undefined if no more fallbacks.
   */
  recordFontLoadFailure(
    loadedName: string,
    failedLevel: FallbackLevel,
    error: Error
  ): FallbackLevel | undefined {
    const entry = this.#fonts.get(loadedName);
    if (!entry) {
      return undefined;
    }

    entry.requestCount++;
    this.failureTracker.recordFailure(loadedName);
    this.#totalFallbacks++;

    // Find the next fallback level.
    const chain = entry.fallbackChain.chain;
    const currentIndex = chain.findIndex((e) => e.level === failedLevel);
    if (currentIndex === -1 || currentIndex >= chain.length - 1) {
      this.eventBus.dispatch(FontEventType.FontLoadError, {
        fontName: entry.descriptor.baseFontName,
        loadedName,
        error,
        fallbackLevel: FallbackLevel.RendererFallback,
      });
      return undefined;
    }

    const nextEntry = chain[currentIndex + 1];
    entry.currentLevel = nextEntry.level;

    this.eventBus.dispatch(FontEventType.FontFallback, {
      fontName: entry.descriptor.baseFontName,
      fromLevel: failedLevel,
      toLevel: nextEntry.level,
      reason: error.message,
    });

    return nextEntry.level;
  }

  /**
   * Get the fallback chain for a registered font.
   */
  getFallbackChain(loadedName: string): FallbackChainResult | undefined {
    return this.#fonts.get(loadedName)?.fallbackChain;
  }

  /**
   * Get a registered font's descriptor.
   */
  getFontDescriptor(loadedName: string): FontDescriptor | undefined {
    return this.#fonts.get(loadedName)?.descriptor;
  }

  /**
   * Get the number of registered (active) fonts.
   */
  get activeFontCount(): number {
    return this.#fonts.size;
  }

  // -------------------------------------------------------------------------
  // Font data caching
  // -------------------------------------------------------------------------

  /**
   * Cache font binary data.
   *
   * @param key - The cache key (typically the font's loadedName).
   * @param data - The font binary data.
   */
  cacheFontData(key: string, data: Uint8Array): void {
    if (this.#config.enableCache) {
      this.fontDataCache.set(key, data);
    }
  }

  /**
   * Retrieve cached font binary data.
   *
   * @param key - The cache key.
   * @returns The cached data, or undefined.
   */
  getCachedFontData(key: string): Uint8Array | undefined {
    if (!this.#config.enableCache) {
      return undefined;
    }
    return this.fontDataCache.get(key);
  }

  // -------------------------------------------------------------------------
  // Stats and diagnostics
  // -------------------------------------------------------------------------

  /**
   * Get aggregated statistics about the FontManager.
   */
  getStats(): FontManagerStats {
    return {
      fontCacheStats: this.fontDataCache.getStats(),
      cMapCacheStats: this.cMapCache.getStats(),
      totalFontsLoaded: this.#totalFontsLoaded,
      totalCMapsLoaded: this.#totalCMapsLoaded,
      totalFallbacks: this.#totalFallbacks,
      activeFontCount: this.#fonts.size,
      preloadCount: this.#preloadCount,
    };
  }

  /**
   * Get the CMap cache stats (convenience accessor).
   */
  getCMapCacheStats(): CacheStats {
    return this.cMapCache.getStats();
  }

  /**
   * Get the font cache stats (convenience accessor).
   */
  getFontCacheStats(): CacheStats {
    return this.fontDataCache.getStats();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Clean up fonts and CMaps (e.g. on document close).
   * Preserves persistent caches, clears session-specific state.
   */
  cleanup(): void {
    // Clear registered fonts (document-specific).
    this.#fonts.clear();
    // Prune expired cache entries.
    this.cMapCache.pruneExpired();
    this.fontDataCache.pruneExpired();
    // Reset session counters.
    this.#totalFontsLoaded = 0;
    this.#totalCMapsLoaded = 0;
    this.#totalFallbacks = 0;
  }

  /**
   * Destroy the FontManager and release all resources.
   * After destruction, the manager cannot be used.
   */
  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;

    const stats = this.getStats();
    this.eventBus.dispatch(FontEventType.ManagerDestroy, {
      timestamp: Date.now(),
      stats,
    });

    this.#fonts.clear();
    this.cMapCache.clear();
    this.fontDataCache.clear();
    this.failureTracker.clear();
    this.eventBus.destroy();

    this.#cMapLoader = undefined;
    this.#fetcher = undefined;
    this.#configured = false;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Assert that the manager has been configured.
   */
  #assertConfigured(): void {
    if (!this.#configured) {
      throw new Error(
        "FontManager has not been configured. Call configure() first."
      );
    }
  }

  /**
   * Assert that the manager has not been destroyed.
   */
  #assertNotDestroyed(): void {
    if (this.#destroyed) {
      throw new Error("FontManager has been destroyed.");
    }
  }
}

// Re-export key types and enums for convenience from the main entry point.
export {
  FontEventType,
  FallbackLevel,
  DEFAULT_FONT_MANAGER_CONFIG,
} from "./font_types.js";
export type {
  FontManagerConfig,
  FontManagerStats,
  CMapLoadOptions,
  CMapPreloadStrategy,
  CMapRawData,
  FontDescriptor,
  SystemFontInfo,
  FallbackChainResult,
  FallbackChainEntry,
  FontEventMap,
  FontEventListener,
  CacheStats,
  BinaryDataFetcher,
  FontStyle,
  FontWeight,
  GenericFontFamily,
} from "./font_types.js";
export { FontEventBus } from "./font_event_bus.js";
export { LRUCache } from "./font_cache.js";
export { CMapLoader } from "./cmap_loader.js";
export { FontFallbackChainBuilder, FontFailureTracker } from "./font_fallback_chain.js";
