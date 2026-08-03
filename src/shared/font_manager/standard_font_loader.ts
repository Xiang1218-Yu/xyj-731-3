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
 * Asynchronous loader for the PDF base-14 standard fonts.
 *
 * This is the standard-font counterpart of {@link CMapLoader}.  It:
 *  - caches raw font bytes;
 *  - de-duplicates concurrent requests for the same font;
 *  - emits lifecycle events through the FontManager event bus;
 *  - supports preloading of fonts known to be required up-front.
 *
 * The existing `PartialEvaluator.fetchStandardFontData` wrapped the returned
 * bytes in a `Stream`.  To keep the public API stable the loader returns raw
 * `Uint8Array` and the FontManager adapter is responsible for wrapping the
 * result.
 */

import type {
  BinaryFetcher,
  FontName,
  ResourceRequest,
} from "./types.ts";
import { cacheKey } from "./types.ts";

/**
 * Mapping between PDF standard-font names and the file names shipped under
 * `standardFontDataUrl`.  The list mirrors `getFontNameToFileMap()` in
 * `src/core/standard_fonts.js` but is kept here so that the FontManager
 * sub-system has no hard dependency on the core layer.
 */
const FONT_NAME_TO_FILENAME: Readonly<Record<string, string>> = Object.freeze({
  "Times-Roman": "Times-Roman.afm",
  "Times-Bold": "Times-Bold.afm",
  "Times-Italic": "Times-Italic.afm",
  "Times-BoldItalic": "Times-BoldItalic.afm",
  Helvetica: "Helvetica.afm",
  "Helvetica-Bold": "Helvetica-Bold.afm",
  "Helvetica-Oblique": "Helvetica-Oblique.afm",
  "Helvetica-BoldOblique": "Helvetica-BoldOblique.afm",
  Courier: "Courier.afm",
  "Courier-Bold": "Courier-Bold.afm",
  "Courier-Oblique": "Courier-Oblique.afm",
  "Courier-BoldOblique": "Courier-BoldOblique.afm",
  Symbol: "Symbol.afm",
  ZapfDingbats: "ZapfDingbats.afm",
});

export interface StandardFontLoaderDependencies {
  readonly fetcher: BinaryFetcher;
  readonly cache: {
    get<T>(key: ReturnType<typeof cacheKey>): T | undefined;
    set<T>(
      key: ReturnType<typeof cacheKey>,
      kind: "standardFont",
      value: T,
      size: number
    ): void;
    has(key: ReturnType<typeof cacheKey>): boolean;
  };
  readonly hooks?: {
    onLoadStart?: (name: FontName) => void;
    onLoadDone?: (
      name: FontName,
      bytes: Uint8Array,
      fromCache: boolean,
      durationMs: number
    ) => void;
    onLoadError?: (name: FontName, error: Error) => void;
  };
}

export class StandardFontLoader {
  readonly #deps: StandardFontLoaderDependencies;

  #hooks: StandardFontLoaderDependencies["hooks"];

  readonly #inFlight: Map<FontName, Promise<Uint8Array>> = new Map();

  constructor(deps: StandardFontLoaderDependencies) {
    this.#deps = deps;
    this.#hooks = deps.hooks;
  }

  /**
   * Replace the lifecycle hooks and return the previous ones.  Used by the
   * FontManager to temporarily install preload progress hooks.
   */
  setHooks(
    hooks: StandardFontLoaderDependencies["hooks"]
  ): StandardFontLoaderDependencies["hooks"] {
    const previous = this.#hooks;
    this.#hooks = hooks;
    return previous;
  }

  /**
   * Return the file name that corresponds to a standard-font PDF name.
   * Exposed so that the existing evaluator can reuse the mapping without
   * importing the core `standard_fonts.js` module.
   */
  static filenameFor(name: string): string | undefined {
    return FONT_NAME_TO_FILENAME[name];
  }

  /**
   * Load the raw bytes of a standard font.  Returns `null` when the font name
   * is not one of the base-14 fonts, mirroring the existing contract.
   */
  async load(name: FontName): Promise<Uint8Array | null> {
    const filename = FONT_NAME_TO_FILENAME[name];
    if (!filename) {
      return null;
    }

    const key = cacheKey("standardFont", name);
    const cached = this.#deps.cache.get<Uint8Array>(key);
    if (cached) {
      this.#hooks?.onLoadDone?.(name, cached, /* fromCache = */ true, 0);
      return cached;
    }

    const inFlight = this.#inFlight.get(name);
    if (inFlight) {
      return inFlight;
    }

    const request = this.#fetchAndCache(name, filename, key);
    this.#inFlight.set(name, request);
    try {
      return await request;
    } finally {
      // Guard against tearing down a newer in-flight retry registered after
      // this request settled; see CMapLoader.load for details.
      if (this.#inFlight.get(name) === request) {
        this.#inFlight.delete(name);
      }
    }
  }

  async preload(
    names: readonly FontName[],
    concurrency: number = 4
  ): Promise<{ completed: number; failed: number }> {
    let completed = 0;
    let failed = 0;
    const queue = names.slice();
    const workers: Array<Promise<void>> = [];

    // Avoid spawning a no-op worker for an empty queue.
    if (queue.length === 0) {
      return { completed: 0, failed: 0 };
    }

    const workerCount = Math.min(concurrency, queue.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push(
        (async (): Promise<void> => {
          while (queue.length > 0) {
            const name = queue.shift();
            if (!name) {
              return;
            }
            try {
              const result = await this.load(name);
              if (result) {
                completed++;
              }
            } catch {
              failed++;
            }
          }
        })()
      );
    }
    await Promise.all(workers);
    return { completed, failed };
  }

  isLoading(name: FontName): boolean {
    return this.#inFlight.has(name);
  }

  async #fetchAndCache(
    name: FontName,
    filename: string,
    key: ReturnType<typeof cacheKey>
  ): Promise<Uint8Array> {
    const start = Date.now();
    this.#hooks?.onLoadStart?.(name);

    const request: ResourceRequest = {
      kind: "standardFont",
      name,
      filename,
    };

    try {
      const bytes = await this.#deps.fetcher.fetch(request);
      this.#deps.cache.set(key, "standardFont", bytes, bytes.byteLength);
      this.#hooks?.onLoadDone?.(
        name,
        bytes,
        /* fromCache = */ false,
        Date.now() - start
      );
      return bytes;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.#hooks?.onLoadError?.(name, normalized);
      throw normalized;
    }
  }
}
