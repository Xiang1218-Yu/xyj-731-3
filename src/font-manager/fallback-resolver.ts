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
 * @module font-manager/fallback-resolver
 *
 * Smart font fallback chain resolver.
 *
 * Single responsibility: given a {@link FontDescriptor}, produce an ordered
 * {@link FallbackChain} whose *last* entry is always a generic CSS family. The
 * "always terminates in a generic family" invariant is what prevents the
 * garbled/blank glyphs the refactor calls out: rendering can always fall
 * through to *something* legible.
 *
 * The resolution order (best → worst) is:
 *   1. embedded    — the PDF shipped a usable program; prefer it verbatim.
 *   2. substitution — a known alias (e.g. `Arial-Black` → `ArialBlack`).
 *   3. standard    — one of the standard-14 families by heuristic class.
 *   4. generic     — `serif` / `sans-serif` / `monospace` (guaranteed).
 *
 * The alias & standard maps mirror (a curated subset of) the semantics in
 * `src/core/font_substitutions.js` and `src/core/standard_fonts.js`, expressed
 * as typed, immutable tables so lookups are total and `any`-free.
 */

import type {
  FallbackChain,
  FallbackEntry,
  FallbackSource,
  FontDescriptor,
  GenericFontFamily,
} from "./types.js";

/**
 * Subset-prefix pattern from PDF spec §9.6.4: `ABCDEF+RealName`. Stripped for
 * TrueType/Type1 fonts before matching.
 */
const SUBSET_PREFIX_RE = /^[A-Z]{6}\+/;

/**
 * Alias table: raw base-font name (normalized) → canonical substitution name.
 * Mirrors the `fontAliases` intent in core; kept intentionally small & typed.
 */
const FONT_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  ["Arial-Black", "ArialBlack"],
  ["Arial-BoldItalicMT", "Arial-BoldItalic"],
  ["Arial-BoldMT", "Arial-Bold"],
  ["Arial-ItalicMT", "Arial-Italic"],
  ["ArialMT", "Arial"],
  ["CourierNew", "Courier"],
  ["CourierNewPSMT", "Courier"],
  ["TimesNewRoman", "Times"],
  ["TimesNewRomanPSMT", "Times"],
  ["TimesNewRomanPS-BoldMT", "Times-Bold"],
  ["TimesNewRomanPS-ItalicMT", "Times-Italic"],
]);

/**
 * Standard family table: canonical name → the standard-14 style family and the
 * data file to fetch. Keyed by lowercase for case-insensitive matching.
 */
interface StandardFontRecord {
  readonly family: string;
  readonly standardFontFile: string;
}
const STANDARD_FONTS: ReadonlyMap<string, StandardFontRecord> = new Map<
  string,
  StandardFontRecord
>([
  ["helvetica", { family: "Helvetica", standardFontFile: "FoxitSans.pfb" }],
  ["arial", { family: "Helvetica", standardFontFile: "FoxitSans.pfb" }],
  ["times", { family: "Times", standardFontFile: "FoxitSerif.pfb" }],
  ["times-roman", { family: "Times", standardFontFile: "FoxitSerif.pfb" }],
  ["courier", { family: "Courier", standardFontFile: "FoxitFixed.pfb" }],
  ["symbol", { family: "Symbol", standardFontFile: "FoxitSymbol.pfb" }],
  [
    "zapfdingbats",
    { family: "ZapfDingbats", standardFontFile: "FoxitDingbats.pfb" },
  ],
]);

/**
 * Normalize a font name the way core does: replace spaces/commas/dashes noise
 * is preserved for alias keys, but for classification we also compute a lower
 * cased, punctuation-stripped token.
 */
function normalizeName(name: string): string {
  return name.replaceAll(/[\s,]+/g, "-");
}

/** Strip the subset prefix for TrueType/Type1 fonts, per spec §9.6.4. */
function stripSubsetPrefix(name: string, descriptor: FontDescriptor): string {
  if (
    (descriptor.type === "TrueType" || descriptor.type === "Type1") &&
    SUBSET_PREFIX_RE.test(name)
  ) {
    return name.slice(7);
  }
  return name;
}

/** Choose the terminal generic family from descriptor flags/name heuristics. */
function genericFamilyFor(descriptor: FontDescriptor): GenericFontFamily {
  const lower = descriptor.baseFontName.toLowerCase();
  if (descriptor.isMonospace || lower.includes("courier") || lower.includes("mono")) {
    return "monospace";
  }
  if (
    descriptor.isSerif ||
    lower.includes("times") ||
    lower.includes("serif") ||
    lower.includes("georgia") ||
    lower.includes("roman")
  ) {
    return "serif";
  }
  return "sans-serif";
}

export class FallbackResolver {
  /**
   * Resolve the ordered fallback chain for `descriptor`.
   *
   * The returned chain is deterministic and always non-empty, terminating in a
   * {@link GenericFontFamily}.
   */
  resolve(descriptor: FontDescriptor): FallbackChain {
    const entries: FallbackEntry[] = [];
    const seen = new Set<string>();

    /** Push an entry unless an identical `family` is already present. */
    const push = (
      family: string,
      source: FallbackSource,
      standardFontFile: string | null
    ): void => {
      if (seen.has(family)) {
        return;
      }
      seen.add(family);
      entries.push({ family, source, standardFontFile });
    };

    // 1) Embedded program wins — reference it by its own name.
    const rawName = stripSubsetPrefix(descriptor.baseFontName, descriptor);
    const normalized = normalizeName(rawName);
    if (descriptor.embedded) {
      push(normalized, "embedded", null);
    }

    // 2) Alias substitution (e.g. `Arial-BoldMT` → `Arial-Bold`).
    const alias = FONT_ALIASES.get(normalized);
    const canonical = alias ?? normalized;
    if (alias) {
      push(alias, "substitution", null);
    }

    // 3) Standard-14 classification. Try the canonical name, then its stem
    //    (drop `-Bold`, `-Italic`, etc.) so `Times-Bold` still maps to Times.
    const stem = canonical.split("-", 1)[0];
    for (const candidate of [canonical, stem]) {
      const record = STANDARD_FONTS.get(candidate.toLowerCase());
      if (record) {
        push(record.family, "standard", record.standardFontFile);
        break;
      }
    }

    // 4) Guaranteed generic terminator — never leave the chain "empty".
    push(genericFamilyFor(descriptor), "generic", null);

    return { requested: normalized, entries };
  }
}
