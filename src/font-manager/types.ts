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
 * @module font-manager/types
 *
 * Central type declarations for the FontManager subsystem.
 *
 * Design rules honoured throughout this module:
 *  - **No `any`.** Every value has a concrete type. Where an external boundary
 *    is genuinely dynamic we use `unknown` and narrow it explicitly.
 *  - **Concrete mappings.** Every "kind"/"event name" enum is paired with an
 *    explicit interface that maps each key to its precise payload/return type
 *    (see {@link BinaryDataKindMap} and {@link FontEventMap}). This lets the
 *    TypeScript compiler verify — at every call site — that the right shape is
 *    produced/consumed for a given key.
 */

// -----------------------------------------------------------------------------
// Binary data fetching (CMap / standard font / wasm)
// -----------------------------------------------------------------------------

/**
 * The kinds of binary resources the subsystem can fetch. These string literals
 * intentionally match the option names consumed by the existing
 * `BaseBinaryDataFactory` (`src/display/binary_data_factory.js`) so the manager
 * is a drop-in collaborator for the current pipeline.
 */
export type BinaryDataKind = "cMapUrl" | "standardFontDataUrl" | "wasmUrl";

/**
 * Concrete mapping from each {@link BinaryDataKind} to the human readable label
 * used in error messages. Mirrors the private `#errorStr` map in
 * `binary_data_factory.js`, but expressed as a *typed* mapping so a missing key
 * is a compile error rather than an `undefined` at runtime.
 */
export interface BinaryDataKindLabelMap {
  cMapUrl: "CMap";
  standardFontDataUrl: "font";
  wasmUrl: "wasm";
}

/** A single binary-fetch request, matching `factory.fetch({ kind, filename })`. */
export interface BinaryDataRequest {
  /** Which configured base URL to resolve `filename` against. */
  readonly kind: BinaryDataKind;
  /** The resource file name, e.g. `"Adobe-Japan1-UCS2.bcmap"`. */
  readonly filename: string;
}

/**
 * The minimal contract the FontManager needs from *any* binary data source.
 * The existing `DOMBinaryDataFactory` / `NodeBinaryDataFactory` already satisfy
 * this shape, which is how API compatibility is preserved.
 */
export interface BinaryDataFactoryLike {
  fetch(request: BinaryDataRequest): Promise<Uint8Array>;
}

// -----------------------------------------------------------------------------
// CMap loading
// -----------------------------------------------------------------------------

/**
 * When CMaps are fetched relative to their state in the render lifecycle.
 *  - `eager`  : preload the configured CMaps immediately on manager init.
 *  - `lazy`   : fetch each CMap only the first time it is requested (default).
 *  - `manual` : never auto-preload; the caller drives {@link preloadCMaps}.
 */
export type CMapPreloadStrategy = "eager" | "lazy" | "manual";

/** Configuration for the async CMap loader. */
export interface CMapLoaderConfig {
  /** Base URL for built-in CMaps. `null` disables built-in CMap loading. */
  readonly cMapUrl: string | null;
  /** Whether CMaps are the binary `.bcmap` variant (affects file extension). */
  readonly cMapPacked: boolean;
  /** Preload strategy; defaults to `"lazy"`. */
  readonly preloadStrategy: CMapPreloadStrategy;
  /**
   * CMap names to preload when `preloadStrategy === "eager"` (or when passed to
   * {@link preloadCMaps} explicitly). Names are *without* extension.
   */
  readonly preloadNames: readonly string[];
}

/** The compiled, in-memory representation of a loaded CMap. */
export interface LoadedCMap {
  /** The CMap name (without extension). */
  readonly name: string;
  /** Raw bytes as returned by the binary data factory. */
  readonly data: Uint8Array;
  /** `true` when the payload is the packed `.bcmap` binary format. */
  readonly packed: boolean;
}

// -----------------------------------------------------------------------------
// Font descriptors & fallback
// -----------------------------------------------------------------------------

/**
 * The PDF font program flavours the fallback resolver understands. Mirrors the
 * `type`/subtype strings produced by the core parser.
 */
export type FontProgramType =
  | "Type0"
  | "Type1"
  | "TrueType"
  | "CIDFontType0"
  | "CIDFontType2"
  | "MMType1"
  | "OpenType"
  | "Unknown";

/** Generic CSS font families used as the last resort in a fallback chain. */
export type GenericFontFamily =
  | "serif"
  | "sans-serif"
  | "monospace"
  | "cursive"
  | "fantasy";

/**
 * A normalized description of a font referenced by a PDF, sufficient for the
 * fallback resolver to make decisions without pulling in the whole core parser.
 */
export interface FontDescriptor {
  /** The raw BaseFont name, possibly including a `ABCDEF+` subset prefix. */
  readonly baseFontName: string;
  /** The font program type. */
  readonly type: FontProgramType;
  /** Whether the PDF embedded the font program (`missingFile === false`). */
  readonly embedded: boolean;
  /** Whether the descriptor's flags mark the font as serif. */
  readonly isSerif: boolean;
  /** Whether the descriptor's flags mark the font as fixed-pitch/monospace. */
  readonly isMonospace: boolean;
  /** Whether the descriptor's flags mark the font as italic. */
  readonly isItalic: boolean;
  /** Whether the descriptor's flags mark the font as bold. */
  readonly isBold: boolean;
}

/** The provenance of a resolved fallback entry, for diagnostics & caching. */
export type FallbackSource =
  | "embedded" // The PDF's own embedded program is usable.
  | "standard" // Mapped to one of the standard-14 fonts.
  | "substitution" // Mapped via the substitution alias table.
  | "generic"; // Fell all the way back to a generic CSS family.

/** One resolved link in a font fallback chain. */
export interface FallbackEntry {
  /** The concrete font family/name to try. */
  readonly family: string;
  /** Where this candidate came from. */
  readonly source: FallbackSource;
  /**
   * The standard font data file to fetch for this entry, when applicable
   * (e.g. `"FoxitSans.pfb"`). `null` when no data fetch is required.
   */
  readonly standardFontFile: string | null;
}

/**
 * The full, ordered fallback chain for a font. The first entry is the most
 * faithful match; the final entry is always a {@link GenericFontFamily} so the
 * chain can never resolve to "nothing" (this is what fixes garbled rendering).
 */
export interface FallbackChain {
  /** The (normalized) font this chain was resolved for. */
  readonly requested: string;
  /** Ordered candidates, best first, generic family last. */
  readonly entries: readonly FallbackEntry[];
}

// -----------------------------------------------------------------------------
// Cache
// -----------------------------------------------------------------------------

/**
 * The logical namespaces stored by {@link FontCache}. Each namespace has a
 * distinct value type, enforced by {@link CacheValueMap}.
 */
export type CacheNamespace = "cmap" | "fontData" | "fallback" | "binary";

/**
 * Concrete mapping from a cache namespace to the value type stored under it.
 * Adding a namespace without a value type here is a compile error.
 */
export interface CacheValueMap {
  cmap: LoadedCMap;
  fontData: Uint8Array;
  fallback: FallbackChain;
  /**
   * Raw bytes cached by the transport-level adapter (see
   * {@link FontManager.createBinaryDataFactoryAdapter}). Keyed by `kind` +
   * `filename`, this backs the drop-in `BinaryDataFactoryLike` used by the
   * PDF.js worker-fetch pipeline for CMap / standard-font / wasm resources.
   */
  binary: Uint8Array;
}

/** Runtime statistics exposed for observability & test assertions. */
export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly size: number;
}

// -----------------------------------------------------------------------------
// Event bus
// -----------------------------------------------------------------------------

/**
 * Concrete mapping from each font-lifecycle event name to its payload type.
 * The typed {@link FontEventBus} uses this so `dispatch("cmapLoaded", ...)` is
 * checked against exactly this payload — no `any`, no stringly-typed payloads.
 */
export interface FontEventMap {
  /** Fired after a CMap is fetched & cached. */
  cmapLoaded: { readonly name: string; readonly fromCache: boolean };
  /** Fired when a CMap fetch fails (after which a fallback may be used). */
  cmapError: { readonly name: string; readonly message: string };
  /** Fired after standard font data is fetched. */
  fontDataLoaded: { readonly filename: string; readonly fromCache: boolean };
  /** Fired once a fallback chain is resolved for a font. */
  fallbackResolved: { readonly requested: string; readonly chain: FallbackChain };
  /** Fired whenever the cache evicts an entry. */
  cacheEvicted: { readonly namespace: CacheNamespace; readonly key: string };
  /**
   * Fired after the transport adapter serves a binary resource (CMap / font /
   * wasm). This is the observability hook for the *live* PDF.js fetch path.
   */
  binaryFetched: {
    readonly kind: BinaryDataKind;
    readonly filename: string;
    readonly fromCache: boolean;
    readonly byteLength: number;
  };
}

/** Union of all valid event names. */
export type FontEventName = keyof FontEventMap;

/** A strongly-typed listener for a specific event. */
export type FontEventListener<K extends FontEventName> = (
  payload: FontEventMap[K]
) => void;

/** Options accepted by {@link FontEventBus.on}, mirroring `web/event_utils.js`. */
export interface FontEventListenerOptions {
  /** Auto-remove the listener when this signal aborts. */
  readonly signal?: AbortSignal;
  /** Remove the listener after the first dispatch. */
  readonly once?: boolean;
}

// -----------------------------------------------------------------------------
// FontManager configuration
// -----------------------------------------------------------------------------

/**
 * Public options for {@link FontManager.configure}. Every field is optional and
 * has a documented default so that existing callers (who pass a subset of these
 * as `getDocument` params today) keep working unchanged.
 */
export interface FontManagerOptions {
  /** Base URL for built-in CMaps (matches `getDocument({ cMapUrl })`). */
  readonly cMapUrl?: string | null;
  /** Whether CMaps are packed `.bcmap` (matches `getDocument({ cMapPacked })`). */
  readonly cMapPacked?: boolean;
  /** Base URL for standard font data (matches `standardFontDataUrl`). */
  readonly standardFontDataUrl?: string | null;
  /** CMap preload strategy; defaults to `"lazy"`. */
  readonly cMapPreloadStrategy?: CMapPreloadStrategy;
  /** CMap names to preload eagerly. */
  readonly cMapPreloadNames?: readonly string[];
  /** Max number of entries retained per cache namespace; defaults to 256. */
  readonly cacheCapacity?: number;
  /**
   * A binary data source. When omitted the manager stays "unbound" and will
   * throw a descriptive error if a fetch is attempted — this keeps the singleton
   * usable in pure-logic contexts (e.g. fallback resolution & unit tests).
   */
  readonly binaryDataFactory?: BinaryDataFactoryLike;
}
