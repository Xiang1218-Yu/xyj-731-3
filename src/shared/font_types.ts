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
 * Centralized type definitions for the FontManager subsystem.
 * Every type is concrete and explicitly mapped. No `any` types are used.
 */

// ---------------------------------------------------------------------------
// Font Style / Weight Types
// ---------------------------------------------------------------------------

/**
 * CSS font-style values supported by the font subsystem.
 */
type FontStyle = "normal" | "italic" | "oblique";

/**
 * CSS font-weight values. Numeric weights as strings, plus keyword aliases.
 */
type FontWeight =
  | "normal"
  | "bold"
  | "bolder"
  | "lighter"
  | "100"
  | "200"
  | "300"
  | "400"
  | "500"
  | "600"
  | "700"
  | "800"
  | "900";

/**
 * Describes a font's style and weight for fallback matching.
 */
interface FontStyleDescriptor {
  /** The CSS font-style (normal, italic, oblique). */
  readonly style: FontStyle;
  /** The CSS font-weight. */
  readonly weight: FontWeight;
}

/**
 * Generic font family categories used as ultimate fallbacks.
 */
type GenericFontFamily =
  "serif" | "sans-serif" | "monospace" | "cursive" | "fantasy" | "system-ui";

// ---------------------------------------------------------------------------
// Font Data & Descriptor Types
// ---------------------------------------------------------------------------

/**
 * MIME types recognized for embedded font data.
 */
type FontMimeType =
  | "font/opentype"
  | "font/ttf"
  | "font/woff"
  | "font/woff2"
  | "application/font-woff"
  | "application/x-font-type1"
  | "application/vnd.ms-fontobject";

/**
 * The raw binary data of a font along with its MIME type.
 */
interface FontBinaryData {
  /** The font file bytes. */
  readonly data: Uint8Array;
  /** The MIME type of the font data. */
  readonly mimetype: FontMimeType;
}

/**
 * Metadata describing a font that may be loaded or substituted.
 */
interface FontDescriptor {
  /** The internal name used to reference the font after loading. */
  readonly loadedName: string;
  /** The original base font name from the PDF. */
  readonly baseFontName: string;
  /** Optional standard font name (e.g. "Helvetica", "Times-Roman"). */
  readonly standardFontName: string | undefined;
  /** The PDF font subtype (e.g. "TrueType", "Type1", "CIDFontType2"). */
  readonly subtype: string;
  /** Whether the font is vertically oriented. */
  readonly vertical: boolean;
  /** Whether the font file is missing (relies on substitution). */
  readonly missingFile: boolean;
  /** Whether the FontFace API is disabled for this font. */
  readonly disableFontFace: boolean;
  /** CSS font info for constructing @font-face rules. */
  readonly cssFontInfo: CssFontInfo | undefined;
  /** System font substitution info, if available. */
  readonly systemFontInfo: SystemFontInfo | undefined;
}

/**
 * CSS font info used to construct @font-face declarations.
 */
interface CssFontInfo {
  /** The CSS font-family name. */
  readonly fontFamily: string;
  /** The CSS font-weight. */
  readonly fontWeight: FontWeight;
  /** Optional italic angle for oblique style. */
  readonly italicAngle: number | undefined;
}

/**
 * Information about a system font to be used as a substitute.
 */
interface SystemFontInfo {
  /** The name under which the font is loaded into the document. */
  readonly loadedName: string;
  /** The original base font name. */
  readonly baseFontName: string;
  /** The CSS src value (local(...) / url(...)). */
  readonly src: string;
  /** Style descriptor for the system font. */
  readonly style: FontStyleDescriptor;
  /** The CSS font-family declaration chain. */
  readonly css: string;
  /** Whether the fallback is a guess (no known substitution). */
  readonly guessFallback: boolean;
}

// ---------------------------------------------------------------------------
// CMap Types
// ---------------------------------------------------------------------------

/**
 * Raw CMap data along with compression flag.
 */
interface CMapRawData {
  /** The CMap file bytes (binary or text-encoded). */
  readonly cMapData: Uint8Array;
  /** Whether the data is a compressed binary CMap (.bcmap). */
  readonly isCompressed: boolean;
}

/**
 * Strategy enum for when to preload CMaps.
 *
 * - `none`:      Never preload; fetch only on demand.
 * - `eager`:     Preload all known built-in CMaps immediately.
 * - `japanese`:  Preload common Japanese CMaps (Adobe-Japan1).
 * - `chineseSimplified`:  Preload common Simplified Chinese CMaps.
 * - `chineseTraditional`: Preload common Traditional Chinese CMaps.
 * - `korean`:    Preload common Korean CMaps.
 * - `cjk`:       Preload all common CJK CMaps.
 * - `unicode`:   Preload the four UCS2 unicode CMaps.
 * - `auto`:      Heuristically preload based on document font info.
 */
type CMapPreloadStrategy =
  | "none"
  | "eager"
  | "japanese"
  | "chineseSimplified"
  | "chineseTraditional"
  | "korean"
  | "cjk"
  | "unicode"
  | "auto";

/**
 * Options controlling CMap loading behavior.
 */
interface CMapLoadOptions {
  /** Base URL for fetching CMap files. */
  readonly cMapUrl: string | undefined;
  /** Whether CMaps are binary-packed (.bcmap). */
  readonly cMapPacked: boolean;
  /** The preload strategy to use. */
  readonly preloadStrategy: CMapPreloadStrategy;
  /** Max number of concurrent CMap fetches. */
  readonly concurrency: number;
}

/**
 * The status of a CMap load operation.
 */
type CMapLoadStatus = "pending" | "loading" | "loaded" | "error";

/**
 * A cached CMap entry with lifecycle metadata.
 */
interface CMapCacheEntry {
  /** The CMap name (e.g. "Adobe-Japan1-UCS2"). */
  readonly name: string;
  /** The current load status. */
  readonly status: CMapLoadStatus;
  /** The raw CMap data, once loaded. */
  readonly data: CMapRawData | undefined;
  /** Timestamp of when the CMap was loaded (ms since epoch). */
  readonly loadedAt: number | undefined;
  /** The promise for the in-flight load, if loading. */
  readonly promise: Promise<CMapRawData> | undefined;
  /** Number of times this CMap has been requested. */
  readonly hitCount: number;
}

// ---------------------------------------------------------------------------
// Font Fallback Chain Types
// ---------------------------------------------------------------------------

/**
 * Levels in the font fallback chain, from highest to lowest priority.
 *
 * Implemented as a const object (not TypeScript enum) so the code runs
 * directly in Node.js under --experimental-strip-types without a transform
 * step, while remaining fully type-safe.
 */
const FallbackLevel = {
  /** The exact embedded font from the PDF. */
  Embedded: 0,
  /** A direct substitution based on the base font name. */
  DirectSubstitution: 1,
  /** A standard PDF font (e.g. Helvetica, Times-Roman). */
  StandardFont: 2,
  /** An OS-local font matched by family name. */
  SystemFont: 3,
  /** A generic CSS font family (serif, sans-serif, monospace). */
  GenericFamily: 4,
  /** The renderer's built-in fallback (canvas rendering). */
  RendererFallback: 5,
} as const;

type FallbackLevel = (typeof FallbackLevel)[keyof typeof FallbackLevel];

/**
 * A single entry in the font fallback chain.
 */
interface FallbackChainEntry {
  /** The fallback level. */
  readonly level: FallbackLevel;
  /** The font family name to try. */
  readonly fontFamily: string;
  /** Style descriptor for this fallback. */
  readonly style: FontStyleDescriptor;
  /** Optional source (local() / url()) for @font-face. */
  readonly src: string | undefined;
  /** Whether this is the ultimate generic fallback. */
  readonly isUltimate: boolean;
}

/**
 * The result of resolving a fallback chain.
 */
interface FallbackChainResult {
  /** The original font name requested. */
  readonly requestedName: string;
  /** The ordered list of fallback entries. */
  readonly chain: readonly FallbackChainEntry[];
  /** The generic family used as the ultimate fallback. */
  readonly genericFamily: GenericFontFamily | undefined;
  /** Whether the chain includes an embedded font. */
  readonly hasEmbedded: boolean;
}

/**
 * Character coverage information for a font.
 */
interface CharCoverage {
  /** Array of Unicode codepoint ranges this font covers. */
  readonly unicodeRanges: readonly (readonly [number, number])[];
  /** Whether CJK characters are covered. */
  readonly coversCJK: boolean;
  /** Whether Latin characters are covered. */
  readonly coversLatin: boolean;
}

// ---------------------------------------------------------------------------
// Cache Types
// ---------------------------------------------------------------------------

/**
 * Options for a cache instance.
 */
interface CacheOptions {
  /** Maximum number of entries before eviction. 0 = unlimited. */
  readonly maxSize: number;
  /** Time-to-live in milliseconds. 0 = no expiration. */
  readonly ttlMs: number;
  /** Whether to persist cache across document loads. */
  readonly persistent: boolean;
}

/**
 * Statistics about cache usage.
 */
interface CacheStats {
  /** Total number of entries currently in the cache. */
  readonly size: number;
  /** Total number of cache hits. */
  readonly hits: number;
  /** Total number of cache misses. */
  readonly misses: number;
  /** Total number of evictions due to size/TTL. */
  readonly evictions: number;
  /** Hit rate as a fraction between 0 and 1. */
  readonly hitRate: number;
}

/**
 * A generic cache entry with lifecycle metadata.
 *
 * @typeParam T - The type of the cached value.
 */
interface CacheEntry<T> {
  /** The cached value. */
  readonly value: T;
  /** Timestamp when the entry was created (ms since epoch). */
  readonly createdAt: number;
  /** Timestamp of last access (ms since epoch). */
  readonly lastAccessedAt: number;
  /** Number of times the entry has been accessed. */
  readonly accessCount: number;
}

// ---------------------------------------------------------------------------
// Event Bus Types
// ---------------------------------------------------------------------------

/**
 * All font lifecycle event types.
 *
 * Implemented as a const object (not TypeScript enum) so the code runs
 * directly in Node.js under --experimental-strip-types without a transform
 * step, while remaining fully type-safe.
 */
const FontEventType = {
  /** Fired when a font begins loading. */
  FontLoadStart: "fontloadstart",
  /** Fired when a font finishes loading successfully. */
  FontLoadSuccess: "fontloadsuccess",
  /** Fired when a font fails to load. */
  FontLoadError: "fontloaderror",
  /** Fired when a font fallback is triggered. */
  FontFallback: "fontfallback",
  /** Fired when a CMap begins loading. */
  CMapLoadStart: "cmaploadstart",
  /** Fired when a CMap finishes loading. */
  CMapLoadSuccess: "cmaploadsuccess",
  /** Fired when a CMap fails to load. */
  CMapLoadError: "cmaploaderror",
  /** Fired when CMap preloading starts. */
  CMapPreloadStart: "cmappreloadstart",
  /** Fired when CMap preloading completes. */
  CMapPreloadComplete: "cmappreloadcomplete",
  /** Fired when a cache entry is evicted. */
  CacheEviction: "cacheeviction",
  /** Fired when the manager is destroyed. */
  ManagerDestroy: "managerdestroy",
} as const;

type FontEventType = (typeof FontEventType)[keyof typeof FontEventType];

/**
 * Payload for font load start event.
 */
interface FontLoadStartEvent {
  readonly fontName: string;
  readonly loadedName: string;
  readonly timestamp: number;
}

/**
 * Payload for font load success event.
 */
interface FontLoadSuccessEvent {
  readonly fontName: string;
  readonly loadedName: string;
  readonly loadTimeMs: number;
  readonly fromCache: boolean;
}

/**
 * Payload for font load error event.
 */
interface FontLoadErrorEvent {
  readonly fontName: string;
  readonly loadedName: string;
  readonly error: Error;
  readonly fallbackLevel: FallbackLevel;
}

/**
 * Payload for font fallback event.
 */
interface FontFallbackEvent {
  readonly fontName: string;
  readonly fromLevel: FallbackLevel;
  readonly toLevel: FallbackLevel;
  readonly reason: string;
}

/**
 * Payload for CMap load start event.
 */
interface CMapLoadStartEvent {
  readonly cMapName: string;
  readonly timestamp: number;
}

/**
 * Payload for CMap load success event.
 */
interface CMapLoadSuccessEvent {
  readonly cMapName: string;
  readonly loadTimeMs: number;
  readonly fromCache: boolean;
  readonly isCompressed: boolean;
}

/**
 * Payload for CMap load error event.
 */
interface CMapLoadErrorEvent {
  readonly cMapName: string;
  readonly error: Error;
}

/**
 * Payload for CMap preload events.
 */
interface CMapPreloadEvent {
  readonly strategy: CMapPreloadStrategy;
  readonly totalCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly elapsedMs: number;
}

/**
 * Payload for cache eviction event.
 */
interface CacheEvictionEvent {
  readonly cacheName: string;
  readonly key: string;
  readonly reason: "size" | "ttl" | "manual";
}

/**
 * Payload for manager destroy event.
 */
interface ManagerDestroyEvent {
  readonly timestamp: number;
  readonly stats: FontManagerStats;
}

/**
 * Maps event types to their corresponding payload types.
 * This provides type-safe event dispatching.
 */
interface FontEventMap {
  readonly [FontEventType.FontLoadStart]: FontLoadStartEvent;
  readonly [FontEventType.FontLoadSuccess]: FontLoadSuccessEvent;
  readonly [FontEventType.FontLoadError]: FontLoadErrorEvent;
  readonly [FontEventType.FontFallback]: FontFallbackEvent;
  readonly [FontEventType.CMapLoadStart]: CMapLoadStartEvent;
  readonly [FontEventType.CMapLoadSuccess]: CMapLoadSuccessEvent;
  readonly [FontEventType.CMapLoadError]: CMapLoadErrorEvent;
  readonly [FontEventType.CMapPreloadStart]: CMapPreloadEvent;
  readonly [FontEventType.CMapPreloadComplete]: CMapPreloadEvent;
  readonly [FontEventType.CacheEviction]: CacheEvictionEvent;
  readonly [FontEventType.ManagerDestroy]: ManagerDestroyEvent;
}

/**
 * A type-safe event listener function.
 *
 * @typeParam K - The event type key.
 */
type FontEventListener<K extends FontEventType> = (
  payload: FontEventMap[K]
) => void;

// ---------------------------------------------------------------------------
// Font Manager Configuration & Stats
// ---------------------------------------------------------------------------

/**
 * Configuration for the FontManager singleton.
 */
interface FontManagerConfig {
  /** CMap loading options. */
  readonly cMap: CMapLoadOptions;
  /** Cache options for font data. */
  readonly fontCache: CacheOptions;
  /** Cache options for CMap data. */
  readonly cMapCache: CacheOptions;
  /** Whether to enable the intelligent fallback chain. */
  readonly enableFallbackChain: boolean;
  /** Whether to enable font load caching. */
  readonly enableCache: boolean;
  /** Whether to preload system fonts. */
  readonly preloadSystemFonts: boolean;
  /** The document reference for DOM font operations. */
  readonly ownerDocument: Document | undefined;
}

/**
 * Aggregated statistics about the FontManager.
 */
interface FontManagerStats {
  /** Cache statistics for fonts. */
  readonly fontCacheStats: CacheStats;
  /** Cache statistics for CMaps. */
  readonly cMapCacheStats: CacheStats;
  /** Total number of fonts loaded. */
  readonly totalFontsLoaded: number;
  /** Total number of CMaps loaded. */
  readonly totalCMapsLoaded: number;
  /** Total number of fallbacks triggered. */
  readonly totalFallbacks: number;
  /** Number of fonts currently active. */
  readonly activeFontCount: number;
  /** Number of CMap preloads performed. */
  readonly preloadCount: number;
}

/**
 * Default configuration values for the FontManager.
 */
const DEFAULT_FONT_MANAGER_CONFIG: Readonly<FontManagerConfig> = {
  cMap: {
    cMapUrl: undefined,
    cMapPacked: true,
    preloadStrategy: "auto",
    concurrency: 4,
  },
  fontCache: {
    maxSize: 100,
    ttlMs: 30 * 60 * 1000,
    persistent: false,
  },
  cMapCache: {
    maxSize: 200,
    ttlMs: 60 * 60 * 1000,
    persistent: true,
  },
  enableFallbackChain: true,
  enableCache: true,
  preloadSystemFonts: false,
  ownerDocument: undefined,
};

// ---------------------------------------------------------------------------
// Binary Data Fetcher Interface
// ---------------------------------------------------------------------------

/**
 * Interface for fetching binary resources (CMaps, fonts).
 * This abstracts the fetch mechanism (DOM fetch, Node.js fs, etc.).
 */
interface BinaryDataFetcher {
  /**
   * Fetch a binary resource.
   * @param kind - The kind of resource ("cMapUrl" | "standardFontDataUrl").
   * @param filename - The filename to fetch.
   * @returns A promise resolving to the raw bytes.
   */
  fetch(kind: string, filename: string): Promise<Uint8Array>;
}

/**
 * Function type for fetching built-in CMap data.
 */
type FetchBuiltInCMapFn = (name: string) => Promise<CMapRawData>;

/**
 * Function type for fetching standard font data.
 */
type FetchStandardFontDataFn = (
  name: string
) => Promise<Uint8Array | undefined>;

export type {
  BinaryDataFetcher,
  CacheEntry,
  CacheEvictionEvent,
  CacheOptions,
  CacheStats,
  CharCoverage,
  CMapCacheEntry,
  CMapLoadErrorEvent,
  CMapLoadOptions,
  CMapLoadStartEvent,
  CMapLoadStatus,
  CMapLoadSuccessEvent,
  CMapPreloadEvent,
  CMapPreloadStrategy,
  CMapRawData,
  CssFontInfo,
  FallbackChainEntry,
  FallbackChainResult,
  FetchBuiltInCMapFn,
  FetchStandardFontDataFn,
  FontBinaryData,
  FontDescriptor,
  FontEventListener,
  FontEventMap,
  FontFallbackEvent,
  FontLoadErrorEvent,
  FontLoadStartEvent,
  FontLoadSuccessEvent,
  FontManagerConfig,
  FontManagerStats,
  FontMimeType,
  FontStyle,
  FontStyleDescriptor,
  FontWeight,
  GenericFontFamily,
  ManagerDestroyEvent,
  SystemFontInfo,
};

export { DEFAULT_FONT_MANAGER_CONFIG, FallbackLevel, FontEventType };
