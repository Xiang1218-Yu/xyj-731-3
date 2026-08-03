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
 * Intelligent, ordered font fallback chain.
 *
 * The original PDF.js fallback logic was essentially:
 *   1. guess a generic CSS family (`serif` / `sans-serif` / `monospace`) from
 *      the font name,
 *   2. append it to the system font list.
 *
 * That single step is what causes garbled output for documents that reference
 * fonts not present on the host system.  The `FontFallbackChain` introduces a
 * multi-stage pipeline:
 *
 *   1. **Alias resolution** — e.g. `Times-Bold` → `Times-Roman`.
 *   2. **Local matches**    — known substitutions shipped in
 *      `font_substitutions.js` (Liberation Serif, Tinos, …).
 *   3. **Style matching**   — pick candidates that share bold/italic traits.
 *   4. **Unicode coverage** — candidates that contain the requested code
 *      points (when coverage information is provided).
 *   5. **Generic family**   — `serif` / `sans-serif` / `monospace`.
 *   6. **Ultimate**         — a guaranteed-available default.
 *
 * The class is framework-agnostic; it only deals with strings and metadata,
 * which keeps it trivially unit-testable.
 */

import type {
  FallbackEntry,
  FallbackReason,
  FallbackStrategyName,
  FontDescriptor,
  FontName,
} from "./types.ts";

/**
 * Signature used to ask the host environment whether a font is actually
 * available and, optionally, whether it covers a set of code points.
 *
 * Returning `true` means "this candidate can be used".  The check is allowed
 * to be asynchronous so that document-based probing strategies (the kind used
 * by `font_loader.js`) can be plugged in.
 */
export type FontAvailabilityChecker = (
  candidate: string,
  context: FallbackContext
) => boolean | Promise<boolean>;

/**
 * Context handed to a {@link FontAvailabilityChecker}.  The unicode coverage
 * set is optional but, when supplied, enables the `unicode-range` stage.
 */
export interface FallbackContext {
  /** Original font descriptor that triggered the fallback. */
  readonly descriptor: FontDescriptor;
  /** Code points that must be renderable (empty array = no coverage check). */
  readonly codePoints: readonly number[];
  /** The strategy the caller selected. */
  readonly strategy: FallbackStrategyName;
}

/** A substitution entry, mirroring the shape used by font_substitutions.js. */
export interface SubstitutionRule {
  readonly alias?: string;
  readonly local: readonly string[];
  readonly ultimate: string;
}

/**
 * Built-in substitutions for the PDF base-14 fonts.  This is a (deliberately
 * small) subset of `font_substitutions.js`; the full map can be injected via
 * the constructor to keep the chain data-driven and avoid duplicating the
 * entire list.
 */
const BASE_SUBSTITUTIONS: ReadonlyMap<string, SubstitutionRule> = new Map([
  [
    "Times-Roman",
    {
      local: [
        "Times New Roman",
        "Liberation Serif",
        "Nimbus Roman",
        "Tinos",
        "FreeSerif",
      ],
      ultimate: "serif",
    },
  ],
  [
    "Times-Bold",
    {
      alias: "Times-Roman",
      local: [
        "Times New Roman Bold",
        "Liberation Serif Bold",
        "Tinos Bold",
        "FreeSerif Bold",
      ],
      ultimate: "serif",
    },
  ],
  [
    "Times-Italic",
    {
      alias: "Times-Roman",
      local: [
        "Times New Roman Italic",
        "Liberation Serif Italic",
        "Tinos Italic",
        "FreeSerif Italic",
      ],
      ultimate: "serif",
    },
  ],
  [
    "Helvetica",
    {
      local: [
        "Arial",
        "Liberation Sans",
        "Nimbus Sans",
        "Arimo",
        "FreeSans",
      ],
      ultimate: "sans-serif",
    },
  ],
  [
    "Helvetica-Bold",
    {
      alias: "Helvetica",
      local: [
        "Arial Bold",
        "Liberation Sans Bold",
        "Arimo Bold",
        "FreeSans Bold",
      ],
      ultimate: "sans-serif",
    },
  ],
  [
    "Courier",
    {
      local: [
        "Courier New",
        "Liberation Mono",
        "Nimbus Mono",
        "Cousine",
        "FreeMono",
      ],
      ultimate: "monospace",
    },
  ],
  [
    "Courier-Bold",
    {
      alias: "Courier",
      local: [
        "Courier New Bold",
        "Liberation Mono Bold",
        "Cousine Bold",
        "FreeMono Bold",
      ],
      ultimate: "monospace",
    },
  ],
]);

export class FontFallbackChain {
  readonly #substitutions: ReadonlyMap<string, SubstitutionRule>;

  #availability: FontAvailabilityChecker;

  constructor(
    availability: FontAvailabilityChecker = () => true,
    substitutions: ReadonlyMap<string, SubstitutionRule> = BASE_SUBSTITUTIONS
  ) {
    this.#availability = availability;
    this.#substitutions = substitutions;
  }

  /**
   * Replace the availability checker.  This allows the FontManager (or the
   * viewer) to plug in a document-based font probing strategy after
   * construction.
   */
  setChecker(checker: FontAvailabilityChecker): void {
    this.#availability = checker;
  }

  /**
   * Build the ordered list of candidates for the given descriptor.  The
   * returned array is sorted by ascending priority and can be inspected for
   * diagnostics or emitted on the event bus.
   */
  buildChain(descriptor: FontDescriptor): FallbackEntry[] {
    const requested = (descriptor.name ?? descriptor.loadedName) as string;
    const chain: FallbackEntry[] = [];

    const push = (
      candidate: string,
      reason: FallbackReason,
      priority: number
    ): void => {
      if (!candidate) {
        return;
      }
      // De-duplicate by candidate name for every stage except the ultimate
      // guarantee.  The ultimate entry is deliberately appended even when
      // the same name already appeared as a generic family: probing stops
      // there (so it is functionally identical) but the distinct `reason`
      // makes the terminal step visible in diagnostics / events.
      if (reason !== "ultimate") {
        if (chain.some(e => e.candidate === candidate)) {
          return;
        }
      }
      chain.push({ candidate, reason, priority });
    };

    // 1. The originally requested name (try it first).
    push(requested, "alias", 0);

    const rule = this.#resolveRule(requested);

    // 2. Alias (e.g. Times-Bold -> Times-Roman) and the local matches for it.
    if (rule) {
      if (rule.alias && rule.alias !== requested) {
        push(rule.alias, "alias", 10);
      }
      rule.local.forEach((candidate, index) => {
        push(candidate, "local-match", 20 + index);
      });
    }

    // 3. Generic CSS family derived from the ultimate fallback / heuristics.
    const generic = this.#guessGenericFamily(descriptor, rule);
    if (generic) {
      push(generic, "generic-family", 80);
    }

    // 4. Ultimate guarantee.
    if (rule) {
      push(rule.ultimate, "ultimate", 100);
    } else {
      push("sans-serif", "ultimate", 100);
    }

    chain.sort((a, b) => a.priority - b.priority);
    return chain;
  }

  /**
   * Resolve a descriptor to a usable font name, probing availability
   * asynchronously.  The first candidate accepted by the
   * {@link FontAvailabilityChecker} wins; if none is accepted the ultimate
   * entry (which is always accepted) is returned.
   */
  async resolve(
    descriptor: FontDescriptor,
    codePoints: readonly number[] = [],
    strategy: FallbackStrategyName = "default"
  ): Promise<{ resolved: string; chain: readonly FallbackEntry[] }> {
    const chain = this.buildChain(descriptor);
    const context: FallbackContext = { descriptor, codePoints, strategy };

    for (const entry of chain) {
      // The ultimate candidate is the last-resort guarantee; we always return
      // it even if the checker reports it as missing, because there is nothing
      // else to try.
      if (entry.reason === "ultimate") {
        return { resolved: entry.candidate, chain };
      }
      if (await this.#availability(entry.candidate, context)) {
        return { resolved: entry.candidate, chain };
      }
    }

    // Defensive fallback — should be unreachable because buildChain always
    // adds an ultimate entry.
    const ultimate = chain.at(-1);
    return { resolved: ultimate?.candidate ?? "sans-serif", chain };
  }

  /**
   * Look up the substitution rule for a font name, following one level of
   * `alias` indirection (this mirrors how font_substitutions.js expresses
   * bold/italic variants).
   */
  #resolveRule(name: string): SubstitutionRule | undefined {
    const direct = this.#substitutions.get(name);
    if (!direct) {
      return undefined;
    }
    if (direct.alias) {
      return this.#substitutions.get(direct.alias) ?? direct;
    }
    return direct;
  }

  /**
   * Infer a CSS generic family from the font descriptor and, if available,
   * the substitution rule.  The logic mirrors the heuristic previously embedded
   * in `fonts.js#fallbackToSystemFont`.
   */
  #guessGenericFamily(
    descriptor: FontDescriptor,
    rule: SubstitutionRule | undefined
  ): string | undefined {
    if (rule?.ultimate) {
      return rule.ultimate;
    }
    const name = (descriptor.name ?? "").toLowerCase();
    if (/mono|courier|consol/i.test(name)) {
      return "monospace";
    }
    if (/sans|helvetica|arial/i.test(name)) {
      return "sans-serif";
    }
    if (/serif|times|roman/i.test(name)) {
      return "serif";
    }
    return undefined;
  }
}

/**
 * Helper used by callers that want a {@link FontName} from a plain string,
 * without importing the type helpers from `types.ts`.
 */
export function toFontName(name: string): FontName {
  return name as FontName;
}
