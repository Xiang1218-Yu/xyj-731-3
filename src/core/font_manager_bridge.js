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
 * Worker-side bridge between the existing JavaScript PDF.js core and the
 * TypeScript FontManager sub-system.
 *
 * This module is the single integration point for the business code:
 *  - `getFontManagerForEvaluator` lazily creates / returns the process-wide
 *    FontManager singleton, configures it from the evaluator options
 *    (`cMapUrl`, `standardFontDataUrl`, `cMapPacked`, `useWorkerFetch`) and
 *    wires up a `BinaryFetcher` that uses either the in-worker `fetch` or the
 *    main-thread `FetchBinaryData` message, exactly like the historical
 *    `PartialEvaluator.fetchBuiltInCMap` did.
 *  - The FontManager cache is now the single source of truth for CMap and
 *    standard-font bytes; the old per-evaluator caches are kept for
 *    backwards compatibility but are populated from / shadowed by the
 *    FontManager cache.
 *  - Lifecycle events emitted on the FontManager event bus are forwarded to
 *    the main thread via the worker `MessageHandler`, so viewer/business code
 *    can subscribe to font loading through the existing event channel.
 */

import { FontManager } from "../shared/font_manager/dist/index.js";

/**
 * Lazily-initialised singleton.  There is one FontManager per worker.
 */
let gFontManager = null;

/**
 * The handler currently attached for event forwarding.  Re-configuring the
 * FontManager (which happens once per document) re-attaches the listener to
 * the new document's handler.
 */
let gForwardUnsubscribe = null;

/**
 * Build a {@link BinaryFetcher} for the worker environment.
 *
 * When `useWorkerFetch` is enabled the fetcher calls the Fetch API directly in
 * the worker (only compressed `.bcmap` CMaps are supported in that mode,
 * matching the original implementation).  Otherwise it asks the main thread to
 * perform the fetch via the `FetchBinaryData` message.
 *
 * @param {object} options
 * @param {boolean} options.useWorkerFetch
 * @param {string|null} options.cMapUrl
 * @param {boolean} options.cMapPacked
 * @param {string|null} options.standardFontDataUrl
 * @param {object} [options.handler] - The worker-side `MessageHandler`.
 *   Required when `useWorkerFetch` is false.
 * @param {Function} [options.fetchBinaryData] - The worker-side fetch helper;
 *   injected by the caller so the bridge does not import core utilities
 *   directly.
 */
function createWorkerBinaryFetcher({
  useWorkerFetch,
  cMapUrl,
  cMapPacked,
  standardFontDataUrl,
  handler,
  fetchBinaryData,
}) {
  return {
    async fetch(request) {
      if (request.kind === "cmap") {
        const name = request.name;
        if (useWorkerFetch) {
          // Only compressed CMaps are supported on the worker-fetch path.
          return fetchBinaryData(`${cMapUrl}${name}.bcmap`);
        }
        return handler.sendWithPromise("FetchBinaryData", {
          kind: "cMapUrl",
          filename: `${name}${cMapPacked ? ".bcmap" : ""}`,
        });
      }

      if (request.kind === "standardFont") {
        const { filename } = request;
        if (useWorkerFetch) {
          return fetchBinaryData(`${standardFontDataUrl}${filename}`);
        }
        return handler.sendWithPromise("FetchBinaryData", {
          kind: "standardFontDataUrl",
          filename,
        });
      }

      throw new Error(`Unsupported resource kind: ${request.kind}`);
    },
  };
}

/**
 * Initialise (or re-configure) the shared FontManager from a set of evaluator
 * options.  Returns the singleton instance.
 *
 * @param {object} options - The `PartialEvaluator` options object.
 * @returns {FontManager}
 */
function initFontManager(options) {
  gFontManager ??= FontManager.getInstance();

  const fetcher = createWorkerBinaryFetcher({
    useWorkerFetch: !!options.useWorkerFetch,
    cMapUrl: options.cMapUrl || null,
    cMapPacked: options.cMapPacked !== false,
    standardFontDataUrl: options.standardFontDataUrl || null,
    handler: options.handler || null,
    fetchBinaryData: options.fetchBinaryData,
  });

  gFontManager.init({
    cMapUrl: options.cMapUrl || undefined,
    cMapPacked: options.cMapPacked !== false,
    standardFontDataUrl: options.standardFontDataUrl || undefined,
    fetcher,
  });

  return gFontManager;
}

/**
 * Forward FontManager lifecycle events to the main thread through the worker
 * message handler.  The main thread re-dispatches them on its own FontManager
 * event bus so that viewer / business code can subscribe without holding a
 * direct reference to the worker.
 *
 * @param {FontManager} manager
 * @param {object} handler - A `MessageHandler`-compatible object exposing
 *   `send(name, data)`.
 */
function attachEventForwarding(manager, handler) {
  if (gForwardUnsubscribe) {
    gForwardUnsubscribe();
    gForwardUnsubscribe = null;
  }
  if (!handler || typeof handler.send !== "function") {
    return;
  }

  const events = /** @type {const} */ ([
    "resource:load:start",
    "resource:load:done",
    "resource:load:error",
    "font:fallback",
    "font:registered",
    "cache:evict",
    "preload:start",
    "preload:progress",
    "preload:done",
  ]);

  const unsubscribers = [];
  for (const eventName of events) {
    const unsubscribe = manager.on(eventName, payload => {
      // `FontManagerEvent` is consumed by the display layer; see
      // `src/display/api.js`.
      handler.send("FontManagerEvent", { eventName, payload });
    });
    unsubscribers.push(unsubscribe);
  }
  gForwardUnsubscribe = () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}

/**
 * Entry point used by `PartialEvaluator`.  It initialises the FontManager on
 * first use, wires event forwarding and returns the manager.
 *
 * @param {object} options - The evaluator options.
 * @returns {FontManager}
 */
function getFontManagerForEvaluator(options) {
  const manager = initFontManager(options);
  if (options.handler) {
    attachEventForwarding(manager, options.handler);
  }
  return manager;
}

/**
 * Compatibility helper: populate the legacy `builtInCMapCache` /
 * `standardFontDataCache` maps from the FontManager cache snapshot so existing
 * code that still consults those maps keeps working while the FontManager is
 * the authoritative cache.
 *
 * @param {FontManager} manager
 * @param {Map} builtInCMapCache
 * @param {Map} standardFontDataCache
 */
function syncLegacyCaches(manager, builtInCMapCache, standardFontDataCache) {
  // The FontManager cache is authoritative; we only mirror its contents for
  // callers that have not yet migrated.  New code should always go through the
  // manager directly.
  if (!builtInCMapCache || !standardFontDataCache) {
    return;
  }
  const stats = manager.getCacheStats();
  for (const entry of stats.entries) {
    const key = entry.key;
    if (key.startsWith("cmap:") && !builtInCMapCache.has(key.slice(5))) {
      const value = manager.peekCachedCMap?.(key.slice(5));
      if (value) {
        builtInCMapCache.set(key.slice(5), value);
      }
    } else if (
      key.startsWith("standardFont:") &&
      !standardFontDataCache.has(key.slice(13))
    ) {
      const value = manager.peekCachedStandardFont?.(key.slice(13));
      if (value) {
        standardFontDataCache.set(key.slice(13), value);
      }
    }
  }
}

/**
 * Tear down the FontManager (primarily for tests / worker termination).
 */
function resetFontManager() {
  if (gForwardUnsubscribe) {
    gForwardUnsubscribe();
    gForwardUnsubscribe = null;
  }
  if (gFontManager) {
    gFontManager.destroy();
    gFontManager = null;
  }
}

export {
  getFontManagerForEvaluator,
  initFontManager,
  resetFontManager,
  syncLegacyCaches,
};
