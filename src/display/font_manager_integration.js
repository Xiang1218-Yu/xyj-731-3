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
 * @module display/font_manager_integration
 *
 * JavaScript bridge between the display layer and the TypeScript FontManager
 * subsystem.
 *
 * Why a bridge? The webpack/babel build only compiles `.js`, so it cannot pull
 * the `.ts` sources directly. FontManager is compiled ahead of time (via
 * `npm run test:font-manager:build`) to `../font-manager/dist/`, and this file
 * imports that emitted JS. It keeps the integration point small and explicit,
 * so `api.js` never has to know about the compiled-output path.
 *
 * What it does: given a *real* PDF.js binary data factory, it returns a drop-in
 * replacement that routes every `fetch({ kind, filename })` call through the
 * FontManager singleton — transparently adding an LRU cache, single-flight
 * request de-duplication, and lifecycle events, while preserving the exact
 * factory contract used by the transport's `FetchBinaryData` handler.
 */

import { FontManager } from "../font-manager/dist/index.js";

/**
 * Wrap `realFactory` with a FontManager-backed adapter.
 *
 * @param {Object} realFactory - An object exposing
 *   `fetch({ kind, filename }) => Promise<Uint8Array>` (i.e. an instance of
 *   `DOMBinaryDataFactory` / `NodeBinaryDataFactory`).
 * @param {Object} [options] - Optional FontManager configuration
 *   (`cMapUrl`, `cMapPacked`, `standardFontDataUrl`, `cacheCapacity`,
 *   `cMapPreloadStrategy`, `cMapPreloadNames`).
 * @returns {Object} A factory satisfying the same `fetch` contract, safe to use
 *   as `transportFactory.binaryDataFactory`.
 */
function createFontManagedBinaryDataFactory(realFactory, options = null) {
  const fontManager = FontManager.getInstance();
  if (options) {
    // `configure` is async (it may run an eager CMap preload); we intentionally
    // do not await here so document setup is never blocked. The adapter binds
    // the real factory synchronously below, so fetches work immediately even if
    // configuration is still settling.
    fontManager.configure({ ...options, binaryDataFactory: realFactory });
  }
  return fontManager.createBinaryDataFactoryAdapter(realFactory);
}

/**
 * Convenience accessor so callers (viewer, tests) can subscribe to font/CMap
 * lifecycle events or read cache stats without importing the compiled path.
 *
 * @returns {Object} The FontManager singleton.
 */
function getFontManager() {
  return FontManager.getInstance();
}

export { createFontManagedBinaryDataFactory, getFontManager };
