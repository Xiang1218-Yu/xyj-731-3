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
 * Adapters that bridge the new TypeScript FontManager and the pre-existing
 * JavaScript font/CMap loading code.
 *
 * The refactoring is intentionally non-invasive: rather than rewriting the
 * whole of `PartialEvaluator` / `DOMBinaryDataFactory`, we expose small
 * adapter functions that translate between the two worlds.  This keeps the
 * public API backwards compatible (every call site continues to work), while
 * routing all resource access through the unified, cache-aware FontManager.
 */

import { FontManager } from "./font_manager.ts";
import {
  asCMapName,
  asFontName,
  type BinaryFetcher,
  type CMapData,
  type FontDescriptor,
  type FontName,
  type ResourceRequest,
} from "./types.ts";

/**
 * Build a {@link BinaryFetcher} from the DOM-side `DOMBinaryDataFactory`
 * (or any object exposing the same `fetch({ kind, filename })` method).
 *
 * The returned fetcher translates the generic {@link ResourceRequest} shape
 * into the legacy `{ kind, filename }` request the factory understands.
 */
export function createBinaryFetcherFromFactory(
  factory: {
    fetch(args: { kind: string; filename: string }): Promise<Uint8Array>;
  }
): BinaryFetcher {
  return {
    async fetch(request: ResourceRequest): Promise<Uint8Array> {
      let kind: "cMapUrl" | "standardFontDataUrl" | "wasmUrl";
      let filename: string;
      switch (request.kind) {
        case "cmap":
          kind = "cMapUrl";
          filename = `${request.name}${request.compressed ? ".bcmap" : ""}`;
          break;
        case "standardFont":
          kind = "standardFontDataUrl";
          filename = request.filename;
          break;
        case "systemFont":
          kind = "standardFontDataUrl";
          filename = request.name;
          break;
      }
      return factory.fetch({ kind, filename });
    },
  };
}

/**
 * Return a `fetchBuiltInCMap(name)` function with the exact same signature as
 * the one historically produced by `PartialEvaluator`.  This lets the
 * existing CMap parser keep working unchanged while every CMap request is
 * routed through the FontManager (cache, preload, events).
 */
export function createLegacyCMapFetcher(
  manager: FontManager
): (name: string) => Promise<CMapData> {
  return async function fetchBuiltInCMap(name: string): Promise<CMapData> {
    return manager.loadCMap(asCMapName(name));
  };
}

/**
 * Return a `fetchStandardFontData(name)` function compatible with
 * `PartialEvaluator.fetchStandardFontData`.  The manager returns raw bytes;
 * the caller is still responsible for wrapping them in a `Stream` (which
 * keeps the adapter independent from the core `Stream` class).
 */
export function createLegacyStandardFontFetcher(
  manager: FontManager
): (name: string) => Promise<Uint8Array | null> {
  return async function fetchStandardFontData(
    name: string
  ): Promise<Uint8Array | null> {
    return manager.loadStandardFont(asFontName(name));
  };
}

/**
 * Convert a legacy PDF.js font object into a {@link FontDescriptor}.
 *
 * The function uses structural typing so it accepts `FontFaceObject`
 * instances from `src/display/font_loader.js` as well as the internal font
 * representations produced by the evaluator.  Unknown / extra properties are
 * ignored.
 */
export function toFontDescriptor(
  font: {
    loadedName?: string;
    name?: string;
    bold?: boolean;
    italic?: boolean;
    vertical?: boolean;
    missingFile?: boolean;
    fallbackName?: string;
    cssFontInfo?: {
      fontFamily?: string;
      fontWeight?: number | string;
      italicAngle?: number;
    };
  }
): FontDescriptor {
  if (!font.loadedName) {
    throw new Error("toFontDescriptor: font.loadedName is required.");
  }
  const cssFontInfo =
    font.cssFontInfo &&
    typeof font.cssFontInfo.fontFamily === "string" &&
    (typeof font.cssFontInfo.fontWeight === "number" ||
      typeof font.cssFontInfo.fontWeight === "string") &&
    typeof font.cssFontInfo.italicAngle === "number"
      ? {
          fontFamily: font.cssFontInfo.fontFamily,
          fontWeight: font.cssFontInfo.fontWeight,
          italicAngle: font.cssFontInfo.italicAngle,
        }
      : undefined;

  return {
    loadedName: asFontName(font.loadedName),
    name: font.name,
    bold: font.bold,
    italic: font.italic,
    vertical: font.vertical,
    missingFile: font.missingFile,
    cssFontInfo,
  };
}

/**
 * Register a legacy font object with the manager.  Convenience wrapper that
 * combines {@link toFontDescriptor} and {@link FontManager.registerFont}.
 */
export function registerLegacyFont(
  manager: FontManager,
  font: Parameters<typeof toFontDescriptor>[0]
): FontName {
  const descriptor = toFontDescriptor(font);
  manager.registerFont(descriptor);
  return descriptor.loadedName;
}
