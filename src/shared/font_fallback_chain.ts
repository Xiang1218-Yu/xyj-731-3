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
 * Intelligent multi-level font fallback chain.
 *
 * Design principles:
 *  - Single responsibility: resolving an ordered list of fallback fonts.
 *  - Multi-level: embedded, direct, standard, system, generic, renderer.
 *  - Character-aware: uses Unicode range info to pick CJK vs Latin fallbacks.
 *  - Adaptive: tracks load failures and deprioritizes failing fonts.
 *  - Compatible: wraps getFontSubstitution from font_substitutions.js.
 *  - Stateless resolution: builder is stateless; failure tracking
 *    is kept in a separate registry.
 *
 * The fallback chain is intentionally separate from FontManager so it can be
 * unit-tested in isolation and reused by the core (worker) layer.
 */

import {
  type FallbackChainEntry,
  type FallbackChainResult,
  FallbackLevel,
  type FontStyleDescriptor,
  type GenericFontFamily,
} from "./font_types.js";

// ---------------------------------------------------------------------------
// Font failure tracking
// ---------------------------------------------------------------------------

/**
 * Record of a font that failed to load, used to deprioritize it.
 */
interface FontFailureRecord {
  /** Number of consecutive failures. */
  readonly failCount: number;
  /** Timestamp of the last failure. */
  readonly lastFailure: number;
}

/**
 * Tracks font load failures to adapt the fallback chain over time.
 * This is a separate concern from chain resolution.
 */
class FontFailureTracker {
  readonly #failures: Map<string, FontFailureRecord> = new Map();

  /** After this many failures, a font is deprioritized. */
  static readonly FAILURE_THRESHOLD = 3;

  /** Failure entries expire after this many milliseconds. */
  static readonly FAILURE_TTL_MS = 5 * 60 * 1000;

  /**
   * Record a successful font load, clearing any failure history.
   */
  recordSuccess(fontName: string): void {
    this.#failures.delete(fontName);
  }

  /**
   * Record a failed font load attempt.
   */
  recordFailure(fontName: string): void {
    const existing = this.#failures.get(fontName);
    const now = Date.now();
    this.#failures.set(fontName, {
      failCount: (existing?.failCount ?? 0) + 1,
      lastFailure: now,
    });
  }

  /**
   * Check whether a font has exceeded the failure threshold.
   */
  isFailing(fontName: string): boolean {
    const record = this.#failures.get(fontName);
    if (!record) {
      return false;
    }
    // Expire old failures.
    if (Date.now() - record.lastFailure > FontFailureTracker.FAILURE_TTL_MS) {
      this.#failures.delete(fontName);
      return false;
    }
    return record.failCount >= FontFailureTracker.FAILURE_THRESHOLD;
  }

  /**
   * Get the failure count for a font.
   */
  getFailCount(fontName: string): number {
    const record = this.#failures.get(fontName);
    if (!record) {
      return 0;
    }
    if (Date.now() - record.lastFailure > FontFailureTracker.FAILURE_TTL_MS) {
      this.#failures.delete(fontName);
      return 0;
    }
    return record.failCount;
  }

  /**
   * Clear all failure records.
   */
  clear(): void {
    this.#failures.clear();
  }
}

// ---------------------------------------------------------------------------
// Standard font metadata
// ---------------------------------------------------------------------------

/**
 * Maps standard PDF base font names to their generic family and style.
 * Used when the PDF references a standard font without embedding it.
 */
interface StandardFontInfo {
  readonly genericFamily: GenericFontFamily;
  readonly style: FontStyleDescriptor;
}

const STANDARD_FONT_MAP: ReadonlyMap<string, StandardFontInfo> = new Map([
  // Serif
  [
    "Times-Roman",
    { genericFamily: "serif", style: { style: "normal", weight: "normal" } },
  ],
  [
    "Times-Bold",
    { genericFamily: "serif", style: { style: "normal", weight: "bold" } },
  ],
  [
    "Times-Italic",
    { genericFamily: "serif", style: { style: "italic", weight: "normal" } },
  ],
  [
    "Times-BoldItalic",
    { genericFamily: "serif", style: { style: "italic", weight: "bold" } },
  ],
  // Sans-serif
  [
    "Helvetica",
    {
      genericFamily: "sans-serif",
      style: { style: "normal", weight: "normal" },
    },
  ],
  [
    "Helvetica-Bold",
    { genericFamily: "sans-serif", style: { style: "normal", weight: "bold" } },
  ],
  [
    "Helvetica-Oblique",
    {
      genericFamily: "sans-serif",
      style: { style: "oblique", weight: "normal" },
    },
  ],
  [
    "Helvetica-BoldOblique",
    {
      genericFamily: "sans-serif",
      style: { style: "oblique", weight: "bold" },
    },
  ],
  // Monospace
  [
    "Courier",
    {
      genericFamily: "monospace",
      style: { style: "normal", weight: "normal" },
    },
  ],
  [
    "Courier-Bold",
    { genericFamily: "monospace", style: { style: "normal", weight: "bold" } },
  ],
  [
    "Courier-Oblique",
    {
      genericFamily: "monospace",
      style: { style: "oblique", weight: "normal" },
    },
  ],
  [
    "Courier-BoldOblique",
    { genericFamily: "monospace", style: { style: "oblique", weight: "bold" } },
  ],
]);

/**
 * CJK font detection patterns.
 * These base font names indicate CJK content requiring CJK-capable fallbacks.
 */
const CJK_FONT_PATTERNS: readonly RegExp[] = [
  /^Heisei|^KozMin|^KozGo/i, // Japanese
  /^MSung|^MHei|^STSong|^STHeiti/i, // Chinese
  /^HYSMyeong|^HYGoThic/i, // Korean
  /^Adobe(GB|CNS|Japan|Korea)/i, // Adobe CJK collections
  /(Song|Hei|Mincho|Gothic|Myeongjo)/i, // CJK family names
];

/**
 * Unicode ranges for CJK characters.
 * Used for character-coverage-based fallback decisions.
 */
const CJK_UNICODE_RANGES: readonly (readonly [number, number])[] = [
  [0x3000, 0x303f], // CJK Symbols and Punctuation
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
];

// ---------------------------------------------------------------------------
// FallbackChainBuilder
// ---------------------------------------------------------------------------

/**
 * Input parameters for building a fallback chain.
 */
interface FallbackChainParams {
  /** The original base font name from the PDF. */
  readonly baseFontName: string;
  /** The standard font name, if known (e.g. "Helvetica"). */
  readonly standardFontName: string | undefined;
  /** The PDF font subtype (e.g. "TrueType", "Type1", "CIDFontType2"). */
  readonly subtype: string;
  /** Whether the font file is embedded. */
  readonly isEmbedded: boolean;
  /** The loaded name for this font. */
  readonly loadedName: string;
  /** Optional CSS font info. */
  readonly cssFontInfo:
    | {
        readonly fontFamily: string;
        readonly fontWeight: string;
        readonly italicAngle: number | undefined;
      }
    | undefined;
  /** Optional system font substitution info (from getFontSubstitution). */
  readonly systemFontInfo:
    | {
        readonly css: string;
        readonly src: string;
        readonly style: FontStyleDescriptor;
        readonly guessFallback: boolean;
      }
    | undefined;
  /** Sample Unicode codepoints used in the document, for coverage detection. */
  readonly sampleCodepoints: readonly number[] | undefined;
}

/**
 * Builds an ordered, multi-level font fallback chain.
 *
 * The chain is built from highest to lowest priority:
 *  1. Embedded font (if the PDF includes font data).
 *  2. Direct substitution (exact OS font match).
 *  3. Standard font (e.g. Helvetica -> Arial/Liberation Sans).
 *  4. System font (broad OS font search).
 *  5. Generic family (serif, sans-serif, monospace).
 *  6. Renderer fallback (canvas-based glyph rendering).
 *
 * The builder is stateless; adaptive behavior is provided via an optional
 * FontFailureTracker.
 */
class FontFallbackChainBuilder {
  /** Optional failure tracker for adaptive fallback. */
  readonly #failureTracker: FontFailureTracker | undefined;

  constructor(failureTracker?: FontFailureTracker) {
    this.#failureTracker = failureTracker;
  }

  /**
   * Build a fallback chain for the given font parameters.
   *
   * @param params - The font descriptor parameters.
   * @returns The ordered fallback chain result.
   */
  build(params: FallbackChainParams): FallbackChainResult {
    const chain: FallbackChainEntry[] = [];
    const {
      baseFontName,
      standardFontName,
      isEmbedded,
      loadedName,
      cssFontInfo,
      systemFontInfo,
    } = params;

    const style = this.#resolveStyle(params);
    const genericFamily = this.#detectGenericFamily(params);
    const isCJK = this.#isCJKFont(baseFontName, params.sampleCodepoints);

    // Level 0: Embedded font.
    if (isEmbedded) {
      chain.push({
        level: FallbackLevel.Embedded,
        fontFamily: cssFontInfo?.fontFamily ?? loadedName,
        style,
        src: undefined,
        isUltimate: false,
      });
    }

    // Level 1: Direct substitution (from system font info, non-guess).
    if (systemFontInfo && !systemFontInfo.guessFallback) {
      const fontFamily = this.#extractPrimaryFamily(systemFontInfo.css);
      if (fontFamily && !this.#isFailing(fontFamily)) {
        chain.push({
          level: FallbackLevel.DirectSubstitution,
          fontFamily,
          style: systemFontInfo.style,
          src: systemFontInfo.src,
          isUltimate: false,
        });
      }
    }

    // Level 2: Standard font substitution.
    if (standardFontName) {
      const stdInfo = STANDARD_FONT_MAP.get(standardFontName);
      if (stdInfo) {
        // Add well-known substitutes for the standard font.
        const substitutes = this.#getStandardFontSubstitutes(standardFontName);
        for (const fontFamily of substitutes) {
          if (!this.#isFailing(fontFamily)) {
            chain.push({
              level: FallbackLevel.StandardFont,
              fontFamily,
              style: stdInfo.style,
              src: undefined,
              isUltimate: false,
            });
          }
        }
      }
    }

    // Level 3: System font (guess fallback from base font name).
    if (systemFontInfo?.guessFallback) {
      const fontFamily = this.#extractPrimaryFamily(systemFontInfo.css);
      if (fontFamily && !this.#isFailing(fontFamily)) {
        chain.push({
          level: FallbackLevel.SystemFont,
          fontFamily,
          style: systemFontInfo.style,
          src: systemFontInfo.src,
          isUltimate: false,
        });
      }
    }

    // Add CJK-capable system fonts if the content appears to be CJK.
    if (isCJK) {
      const cjkFonts = this.#getCJKSystemFonts(baseFontName);
      for (const fontFamily of cjkFonts) {
        if (!this.#isFailing(fontFamily)) {
          chain.push({
            level: FallbackLevel.SystemFont,
            fontFamily,
            style,
            src: undefined,
            isUltimate: false,
          });
        }
      }
    }

    // Level 4: Generic family (CSS ultimate fallback).
    if (genericFamily) {
      chain.push({
        level: FallbackLevel.GenericFamily,
        fontFamily: genericFamily,
        style,
        src: undefined,
        isUltimate: true,
      });
    }

    // Level 5: Renderer fallback (always last, signals canvas rendering).
    chain.push({
      level: FallbackLevel.RendererFallback,
      fontFamily: "__pdfjs_renderer__",
      style,
      src: undefined,
      isUltimate: true,
    });

    return {
      requestedName: baseFontName,
      chain,
      genericFamily,
      hasEmbedded: isEmbedded,
    };
  }

  /**
   * Build a CSS font-family declaration string from the chain.
   *
   * @param result - The fallback chain result.
   * @returns A CSS font-family value.
   */
  toCssFontFamily(result: FallbackChainResult): string {
    return result.chain
      .filter(e => e.level !== FallbackLevel.RendererFallback)
      .map(e => {
        // Generic families don't need quotes.
        if (e.level === FallbackLevel.GenericFamily) {
          return e.fontFamily;
        }
        return `"${e.fontFamily}"`;
      })
      .join(", ");
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the style descriptor for a font.
   */
  #resolveStyle(params: FallbackChainParams): FontStyleDescriptor {
    if (params.systemFontInfo?.style) {
      return params.systemFontInfo.style;
    }
    if (params.cssFontInfo) {
      return {
        style:
          params.cssFontInfo.italicAngle && params.cssFontInfo.italicAngle !== 0
            ? "oblique"
            : "normal",
        weight: params.cssFontInfo.fontWeight as FontStyleDescriptor["weight"],
      };
    }
    // Heuristic: detect bold/italic from the font name.
    const name = params.baseFontName.toLowerCase();
    const bold = /bold|black|heavy/.test(name);
    const italic = /italic|oblique/.test(name);
    return {
      style: italic ? "italic" : "normal",
      weight: bold ? "bold" : "normal",
    };
  }

  /**
   * Detect the generic font family based on the standard font or name.
   */
  #detectGenericFamily(
    params: FallbackChainParams
  ): GenericFontFamily | undefined {
    // Check standard font map first.
    if (params.standardFontName) {
      const stdInfo = STANDARD_FONT_MAP.get(params.standardFontName);
      if (stdInfo) {
        return stdInfo.genericFamily;
      }
    }

    // Heuristics from the font name.
    const name = params.baseFontName.toLowerCase();
    if (/mono|courier|console|code/.test(name)) {
      return "monospace";
    }
    if (/serif|times|roman|song|mincho|myeongjo|ming|sung/.test(name)) {
      return "serif";
    }
    if (/sans|helvetica|arial|hei|gothic|goth|kaku/.test(name)) {
      return "sans-serif";
    }
    if (/cursive|script|kai/.test(name)) {
      return "cursive";
    }
    if (/fantasy|decor/.test(name)) {
      return "fantasy";
    }
    // CJK fonts default to serif for Mincho/Song, sans for Gothic/Hei.
    if (/song|mincho|ming|sung|myeongjo/.test(name)) {
      return "serif";
    }
    if (/hei|gothic|kaku/.test(name)) {
      return "sans-serif";
    }
    return "sans-serif";
  }

  /**
   * Determine if the font is likely a CJK font.
   */
  #isCJKFont(
    baseFontName: string,
    sampleCodepoints: readonly number[] | undefined
  ): boolean {
    // Check font name patterns.
    for (const pattern of CJK_FONT_PATTERNS) {
      if (pattern.test(baseFontName)) {
        return true;
      }
    }
    // Check sample codepoints if provided.
    if (sampleCodepoints && sampleCodepoints.length > 0) {
      let cjkCount = 0;
      for (const cp of sampleCodepoints) {
        if (this.#isCJKCodepoint(cp)) {
          cjkCount++;
        }
      }
      // If more than 30% of sampled characters are CJK, treat as CJK font.
      return cjkCount / sampleCodepoints.length > 0.3;
    }
    return false;
  }

  /**
   * Check if a codepoint falls within CJK Unicode ranges.
   */
  #isCJKCodepoint(cp: number): boolean {
    for (const [low, high] of CJK_UNICODE_RANGES) {
      if (cp >= low && cp <= high) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a font family should be deprioritized due to failures.
   */
  #isFailing(fontFamily: string): boolean {
    return this.#failureTracker?.isFailing(fontFamily) ?? false;
  }

  /**
   * Extract the primary font family from a CSS declaration.
   * E.g. '"Helvetica",g_d0_s1,sans-serif' -> 'Helvetica'
   */
  #extractPrimaryFamily(css: string): string | undefined {
    const first = css.split(",")[0]?.trim();
    if (!first) {
      return undefined;
    }
    // Remove quotes.
    return first.replaceAll(/^["']|["']$/g, "");
  }

  /**
   * Get well-known substitute font families for a standard PDF font.
   */
  #getStandardFontSubstitutes(standardFontName: string): readonly string[] {
    const map: Readonly<Record<string, readonly string[]>> = {
      "Times-Roman": [
        "Times New Roman",
        "Liberation Serif",
        "Nimbus Roman",
        "Tinos",
        "TeX Gyre Termes",
        "FreeSerif",
      ],
      "Times-Bold": ["Times New Roman", "Liberation Serif", "FreeSerif"],
      "Times-Italic": ["Times New Roman", "Liberation Serif", "FreeSerif"],
      "Times-BoldItalic": ["Times New Roman", "Liberation Serif", "FreeSerif"],
      Helvetica: [
        "Arial",
        "Helvetica Neue",
        "Liberation Sans",
        "Arimo",
        "Nimbus Sans",
        "TeX Gyre Heros",
        "FreeSans",
      ],
      "Helvetica-Bold": [
        "Arial",
        "Helvetica Neue",
        "Liberation Sans",
        "FreeSans",
      ],
      "Helvetica-Oblique": [
        "Arial",
        "Helvetica Neue",
        "Liberation Sans",
        "FreeSans",
      ],
      "Helvetica-BoldOblique": [
        "Arial",
        "Helvetica Neue",
        "Liberation Sans",
        "FreeSans",
      ],
      Courier: [
        "Courier New",
        "Liberation Mono",
        "Nimbus Mono",
        "Cousine",
        "TeX Gyre Cursor",
        "FreeMono",
      ],
      "Courier-Bold": ["Courier New", "Liberation Mono", "FreeMono"],
      "Courier-Oblique": ["Courier New", "Liberation Mono", "FreeMono"],
      "Courier-BoldOblique": ["Courier New", "Liberation Mono", "FreeMono"],
    };
    return map[standardFontName] ?? [];
  }

  /**
   * Get CJK-capable system fonts based on the base font name.
   */
  #getCJKSystemFonts(baseFontName: string): readonly string[] {
    const name = baseFontName.toLowerCase();

    // Japanese
    if (/heisei|kozmin|kozgo|japan|mincho|gothic/i.test(name)) {
      return [
        "Hiragino Mincho ProN",
        "Hiragino Kaku Gothic ProN",
        "Yu Mincho",
        "Yu Gothic",
        "Noto Serif JP",
        "Noto Sans JP",
        "Source Han Serif JP",
        "Source Han Sans JP",
        "MS Mincho",
        "MS Gothic",
        "IPAMincho",
        "IPAGothic",
      ];
    }

    // Simplified Chinese
    if (/stsong|stheiti|adobegb|song|hei/i.test(name)) {
      return [
        "Songti SC",
        "Heiti SC",
        "PingFang SC",
        "Noto Serif SC",
        "Noto Sans SC",
        "Source Han Serif SC",
        "Source Han Sans SC",
        "SimSun",
        "SimHei",
        "Microsoft YaHei",
      ];
    }

    // Traditional Chinese
    if (/msung|mhei|adobecns|ming|sung/i.test(name)) {
      return [
        "Songti TC",
        "Heiti TC",
        "PingFang TC",
        "Noto Serif TC",
        "Noto Sans TC",
        "Source Han Serif TC",
        "Source Han Sans TC",
        "PMingLiU",
        "MingLiU",
        "Microsoft JhengHei",
      ];
    }

    // Korean
    if (/hysmyeong|hygothic|adobekorea|myeongjo/i.test(name)) {
      return [
        "AppleMyungjo",
        "Apple SD Gothic Neo",
        "Noto Serif KR",
        "Noto Sans KR",
        "Source Han Serif KR",
        "Source Han Sans KR",
        "Nanum Myeongjo",
        "Nanum Gothic",
        "Malgun Gothic",
        "Batang",
      ];
    }

    // Generic CJK
    return [
      "Noto Serif CJK SC",
      "Noto Sans CJK SC",
      "Noto Serif CJK JP",
      "Noto Sans CJK JP",
      "Noto Sans CJK KR",
      "Arial Unicode MS",
    ];
  }
}

export type { FallbackChainParams };
export { FontFailureTracker, FontFallbackChainBuilder };
