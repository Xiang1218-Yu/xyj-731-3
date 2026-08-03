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
 * Centralised type definitions for the FontManager sub-system.
 *
 * Every type in this module is deliberately concrete: the refactoring forbids
 * the use of `any`, and every entity crossing a module boundary is mapped to
 * an explicit interface / union / branded type.  The types are consumed by the
 * TypeScript implementation as well as by the generated `.d.ts` files that are
 * shipped to JavaScript callers, giving them first-class typing support even
 * when they do not use TypeScript themselves.
 */

/* -------------------------------------------------------------------------- */
/*  Branded primitive types                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A font-family / font-face name as it is known to PDF.js (e.g. "g_d0_f1").
 * Branded so that callers cannot accidentally pass an arbitrary string where a
 * font name is expected.
 */
export type FontName = string & { readonly __fontNameBrand: unique symbol };

/**
 * A built-in CMap name (e.g. "GBK-EUC-H").
 */
export type CMapName = string & { readonly __cMapNameBrand: unique symbol };

/**
 * The absolute or relative URL under which CMap files are served.
 */
export type CMapUrl = string & { readonly __cMapUrlBrand: unique symbol };

/**
 * The absolute or relative URL under which the standard 14 fonts are served.
 */
export type StandardFontDataUrl = string & {
  readonly __standardFontDataUrlBrand: unique symbol;
};

/**
 * A cache key.  Keys are deterministic strings derived from the resource kind
 * and its name (see {@link cacheKey}).
 */
export type CacheKey = string & { readonly __cacheKeyBrand: unique symbol };

/* -------------------------------------------------------------------------- */
/*  Resource kind                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The kinds of binary resources the FontManager knows how to fetch.
 *
 * - `cmap`         : a built-in Adobe CMap (text or `.bcmap`).
 * - `standardFont` : one of the PDF base-14 standard fonts.
 * - `systemFont`   : a font resolved from the host operating system.
 */
export type ResourceKind = "cmap" | "standardFont" | "systemFont";

/**
 * Discriminated union describing a single binary resource that can be loaded
 * through the FontManager.
 */
export type ResourceRequest =
  | { kind: "cmap"; name: CMapName; compressed: boolean }
  | { kind: "standardFont"; name: FontName; filename: string }
  | { kind: "systemFont"; name: FontName };

/* -------------------------------------------------------------------------- */
/*  CMap data                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Raw bytes plus the information required to decide whether the content must
 * be parsed by {@link BinaryCMapReader} or by the text {@link Lexer}.
 */
export interface CMapData {
  /** The raw CMap bytes (either text or binary-compressed). */
  readonly cMapData: Uint8Array;
  /** `true` when {@link cMapData} is a binary-compressed `.bcmap` file. */
  readonly isCompressed: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Font metadata                                                             */
/* -------------------------------------------------------------------------- */

/**
 * CSS-like font style information derived from a PDF font descriptor.
 */
export interface CSSFontInfo {
  readonly fontFamily: string;
  readonly fontWeight: number | string;
  readonly italicAngle: number;
}

/**
 * Describes a font that may be registered with / queried from the
 * FontManager.
 *
 * The interface is intentionally structural: the existing PDF.js font objects
 * (see `FontFaceObject` in `src/display/font_loader.js`) satisfy it without any
 * changes, which keeps the public API backwards compatible.
 */
export interface FontDescriptor {
  /** The internal PDF.js name (e.g. "g_d0_f1"). */
  readonly loadedName: FontName;
  /** The original PDF font name. */
  readonly name?: string;
  /** The CSS family name, when the font maps to a web font. */
  readonly cssFontInfo?: CSSFontInfo;
  /** Whether the font is bold. */
  readonly bold?: boolean;
  /** Whether the font is italic. */
  readonly italic?: boolean;
  /** Whether the font is vertical (writing mode). */
  readonly vertical?: boolean;
  /** True when the embedded font file is missing. */
  readonly missingFile?: boolean;
  /** Raw font bytes (used for `FontFace` construction). */
  readonly data?: { toBase64(): string } | Uint8Array;
  /** MIME type of {@link data}. */
  readonly mimetype?: string;
}

/* -------------------------------------------------------------------------- */
/*  Fallback chain                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A single entry in an intelligent font fallback chain.  Each entry is tried in
 * order until one can satisfy the glyph request.
 */
export interface FallbackEntry {
  /** The candidate font name (PDF name, system name or CSS generic family). */
  readonly candidate: string;
  /** Why this candidate was selected, useful for diagnostics / events. */
  readonly reason: FallbackReason;
  /**
   * Numeric priority.  Lower numbers are tried first.  The chain is always
   * sorted by priority before being evaluated so that callers can register
   * entries in any order.
   */
  readonly priority: number;
}

/**
 * Machine-readable reason describing why a fallback candidate was chosen.
 */
export type FallbackReason =
  | "alias"
  | "local-match"
  | "style-match"
  | "unicode-range"
  | "generic-family"
  | "ultimate";

/**
 * The strategy used by the {@link FontFallbackChain} to select a candidate.
 */
export type FallbackStrategyName =
  | "default"
  | "prefer-system"
  | "prefer-embedded"
  | "aggressive";

/* -------------------------------------------------------------------------- */
/*  Preload strategy                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Configuration describing which resources should be eagerly fetched before
 * first-paint, and which should remain lazily / on-demand.
 */
export interface PreloadStrategy {
  /**
   * When `true` the FontManager eagerly fetches the CMaps that are most
   * commonly required by CJK documents.  Defaults to `false`.
   */
  readonly commonCMaps: boolean;
  /**
   * An explicit list of CMap names to preload (for example when the
   * application knows the document language up-front).
   */
  readonly cMapNames: readonly CMapName[];
  /**
   * An explicit list of standard-font names to preload.
   */
  readonly standardFontNames: readonly FontName[];
  /**
   * Maximum number of concurrent in-flight fetches used by the preloader.
   * Prevents the preloader from contending with the first-page render.
   */
  readonly concurrency: number;
}

/**
 * The default preload strategy: nothing is preloaded, preserving the existing
 * lazy behaviour.
 */
export const DEFAULT_PRELOAD_STRATEGY: PreloadStrategy = Object.freeze({
  commonCMaps: false,
  cMapNames: Object.freeze([]),
  standardFontNames: Object.freeze([]),
  concurrency: 4,
});

/**
 * The CMap names that are "most common" for CJK documents.  They are only
 * fetched when {@link PreloadStrategy.commonCMaps} is enabled.
 */
export const COMMON_CMAP_NAMES: readonly CMapName[] = Object.freeze([
  "GBK-EUC-H",
  "GBK-EUC-V",
  "GB-EUC-H",
  "GB-EUC-V",
  "ETen-B5-H",
  "ETen-B5-V",
  "UniJIS-UCS2-H",
  "UniJIS-UCS2-V",
  "UniKS-UCS2-H",
  "UniKS-UCS2-V",
  "Identity-H",
  "Identity-V",
] as unknown as readonly CMapName[]);

/* -------------------------------------------------------------------------- */
/*  Caching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Per-entry statistics exposed for observability / tests.
 */
export interface CacheEntryStats {
  readonly key: CacheKey;
  readonly kind: ResourceKind;
  readonly hits: number;
  readonly size: number;
  readonly createdAt: number;
  readonly lastAccessedAt: number;
}

/**
 * Snapshot returned by {@link FontCache.getStats}, useful for logging and for
 * the `fontmanager:cache-stats` event.
 */
export interface CacheStats {
  readonly entries: readonly CacheEntryStats[];
  readonly totalHits: number;
  readonly totalMisses: number;
  readonly totalSize: number;
  readonly entryCount: number;
}

/**
 * Eviction policy for the font cache.
 *
 * - `lru`  : least-recently-used eviction when the size budget is exceeded.
 * - `lfu`  : least-frequently-used eviction.
 * - `none` : the cache grows unbounded (it is cleared on document cleanup).
 */
export type EvictionPolicy = "lru" | "lfu" | "none";

/**
 * Options controlling cache behaviour.
 */
export interface CacheOptions {
  /** Maximum number of cached entries. */
  readonly maxEntries: number;
  /** Estimated maximum total size, in bytes. */
  readonly maxBytes: number;
  readonly evictionPolicy: EvictionPolicy;
}

export const DEFAULT_CACHE_OPTIONS: CacheOptions = Object.freeze({
  maxEntries: 256,
  maxBytes: 64 * 1024 * 1024,
  evictionPolicy: "lru",
});

/* -------------------------------------------------------------------------- */
/*  Fetching                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A fetcher abstraction.  The FontManager does not call `fetch` itself; it
 * delegates to an injected implementation so that the same code works in the
 * worker, on the main thread and under Node.js.
 *
 * The existing `DOMBinaryDataFactory._fetch` and the worker-side
 * `fetchBinaryData` are adapted to this interface (see `adapters.ts`), which
 * keeps backwards compatibility with the current public API.
 */
export interface BinaryFetcher {
  /**
   * Fetch a binary resource.
   *
   * @param request - describes what to fetch.
   * @returns resolves to the raw bytes of the resource.
   */
  fetch(request: ResourceRequest): Promise<Uint8Array>;
}

/* -------------------------------------------------------------------------- */
/*  Events                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Strongly-typed map of every event emitted by the FontManager.  The event
 * bus uses this map to guarantee that listeners and payloads line up.
 */
export interface FontManagerEventMap {
  /** Emitted when a resource fetch begins. */
  "resource:load:start": {
    readonly kind: ResourceKind;
    readonly name: string;
  };
  /** Emitted when a resource fetch completes successfully. */
  "resource:load:done": {
    readonly kind: ResourceKind;
    readonly name: string;
    readonly durationMs: number;
    readonly size: number;
    readonly fromCache: boolean;
  };
  /** Emitted when a resource fetch fails. */
  "resource:load:error": {
    readonly kind: ResourceKind;
    readonly name: string;
    readonly error: Error;
  };
  /** Emitted whenever the fallback chain is evaluated for a font. */
  "font:fallback": {
    readonly requested: string;
    readonly resolved: string;
    readonly chain: readonly FallbackEntry[];
  };
  /** Emitted when a font is registered with the manager. */
  "font:registered": {
    readonly name: FontName;
  };
  /** Emitted when the cache evicts an entry. */
  "cache:evict": {
    readonly key: CacheKey;
    readonly reason: "size" | "entries" | "manual";
  };
  /** Emitted when the preloader starts / makes progress / finishes. */
  "preload:start": { readonly total: number };
  "preload:progress": {
    readonly completed: number;
    readonly total: number;
    readonly name: string;
  };
  "preload:done": { readonly completed: number; readonly failed: number };
}

/**
 * Union of every valid event name.
 */
export type FontManagerEventName = keyof FontManagerEventMap;

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Initialisation options for {@link FontManager}.
 */
export interface FontManagerOptions {
  readonly cMapUrl?: CMapUrl;
  readonly standardFontDataUrl?: StandardFontDataUrl;
  /** `true` when the CMaps are served in the binary `.bcmap` format. */
  readonly cMapPacked?: boolean;
  readonly cache?: Partial<CacheOptions>;
  readonly preload?: Partial<PreloadStrategy>;
  readonly fallbackStrategy?: FallbackStrategyName;
  /**
   * The fetcher used to load binary resources.  When omitted, the manager
   * operates in "degraded" mode and only serves resources that were
   * registered manually (this is useful for tests).
   */
  readonly fetcher?: BinaryFetcher;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build a deterministic cache key for a resource.
 */
export function cacheKey(kind: ResourceKind, name: string): CacheKey {
  return `${kind}:${name}` as CacheKey;
}

/**
 * Narrow a string to a {@link FontName}.
 */
export function asFontName(name: string): FontName {
  return name as FontName;
}

/**
 * Narrow a string to a {@link CMapName}.
 */
export function asCMapName(name: string): CMapName {
  return name as CMapName;
}
