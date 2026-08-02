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
 * JavaScript-compatible adapter for the TypeScript FontManager.
 *
 * This module provides a thin wrapper that:
 *  1. Adapts the existing BinaryDataFactory to the BinaryDataFetcher interface.
 *  2. Exports a configureFontManager() callable from existing JS code.
 *  3. Provides getFontManager() for accessing the singleton.
 *
 * Keeping this as a .ts file allows it to import the typed FontManager while
 * remaining importable by .js files via webpack/babel resolution.
 */

import { FontManager } from "./font_manager.js";
import type {
  BinaryDataFetcher,
  CMapPreloadStrategy,
  FontManagerConfig,
} from "./font_types.js";

/**
 * Adapter that wraps an existing BinaryDataFactory (from binary_data_factory.js)
 * into the BinaryDataFetcher interface expected by the FontManager.
 */
class BinaryDataFactoryAdapter implements BinaryDataFetcher {
  #factory: { fetch: (params: { kind: string; filename: string }) => Promise<Uint8Array> };

  constructor(factory: {
    fetch: (params: { kind: string; filename: string }) => Promise<Uint8Array>;
  }) {
    this.#factory = factory;
  }

  async fetch(kind: string, filename: string): Promise<Uint8Array> {
    return this.#factory.fetch({ kind, filename });
  }
}

/**
 * Configuration options accepted by configureFontManager.
 * These map to the existing getDocument parameters.
 */
export interface FontManagerSetupOptions {
  /** URL prefix for CMap files. */
  cMapUrl?: string;
  /** Whether CMaps are binary-packed. */
  cMapPacked?: boolean;
  /** URL prefix for standard font data files. */
  standardFontDataUrl?: string;
  /** Preload strategy name. */
  cMapPreloadStrategy?: CMapPreloadStrategy;
  /** Whether to enable the intelligent fallback chain. */
  enableFallbackChain?: boolean;
  /** Whether to enable font caching. */
  enableCache?: boolean;
  /** The binary data factory instance. */
  binaryDataFactory?: {
    fetch: (params: { kind: string; filename: string }) => Promise<Uint8Array>;
  };
  /** The owner document for DOM operations. */
  ownerDocument?: Document;
}

/**
 * Configure the FontManager singleton from existing getDocument parameters.
 *
 * This is the primary integration point called by the display API layer.
 * It is safe to call multiple times; each call reconfigures the manager.
 *
 * @param options - Setup options derived from getDocument params.
 * @returns The configured FontManager instance.
 */
function configureFontManager(
  options: FontManagerSetupOptions
): FontManager {
  const manager = FontManager.getInstance();

  const fetcher = options.binaryDataFactory
    ? new BinaryDataFactoryAdapter(options.binaryDataFactory)
    : undefined;

  const partialConfig: Partial<FontManagerConfig> = {
    cMap: {
      cMapUrl: options.cMapUrl,
      cMapPacked: options.cMapPacked !== false,
      preloadStrategy: options.cMapPreloadStrategy ?? "auto",
      concurrency: 4,
    },
    enableFallbackChain: options.enableFallbackChain !== false,
    enableCache: options.enableCache !== false,
    ownerDocument: options.ownerDocument,
  };

  manager.configure(partialConfig, fetcher);
  return manager;
}

/**
 * Get the FontManager singleton.
 * If not yet configured, returns it with default settings (not yet configured).
 */
function getFontManager(): FontManager {
  return FontManager.getInstance();
}

/**
 * Reset the FontManager singleton (for testing).
 */
function resetFontManager(): void {
  FontManager.resetInstance();
}

export {
  configureFontManager,
  getFontManager,
  resetFontManager,
  BinaryDataFactoryAdapter,
};
