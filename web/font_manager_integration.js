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
 * Viewer-level integration for the FontManager sub-system.
 *
 * This module is the *business code* integration point demonstrated by the
 * refactoring.  It subscribes to the font lifecycle events exposed on the
 * FontManager event bus (populated by worker→main-thread forwarding) and
 * bridges them into the viewer's own `EventBus`:
 *
 *  - `resource:load:start` / `:done` / `:error` are surfaced as
 *    `fontlifecyclestart` / `fontlifecycledone` / `fontlifecycleerror`
 *    viewer events that UI components can listen to.
 *  - Aggregated cache statistics are logged whenever a resource finishes
 *    loading, demonstrating that the FontManager cache is actively used
 *    (hit/miss counts).
 *
 * The integration is intentionally optional and side-effect free until
 * {@link bindFontLifecycle} is called by the application bootstrap.
 */

import { getMainThreadFontManager } from "pdfjs/display/font_manager_client.js";

/**
 * @typedef {Object} FontLifecycleBindings
 * @property {() => void} destroy - Unsubscribe from every FontManager event.
 */

/**
 * Subscribe to the FontManager lifecycle events and re-dispatch the relevant
 * ones on the viewer event bus.
 *
 * @param {EventBus} viewerEventBus - The application event bus used by the
 *   viewer (see `web/app.js`).
 * @param {object} [logger] - Optional logger (defaults to `console`).
 * @returns {FontLifecycleBindings}
 */
function bindFontLifecycle(viewerEventBus, logger = console) {
  const fontManager = getMainThreadFontManager();

  const emit = (name, details) => {
    if (viewerEventBus?.dispatch) {
      viewerEventBus.dispatch(name, { source: "font-manager", ...details });
    }
  };

  const onStart = ({ kind, name }) => {
    emit("fontlifecyclestart", { kind, name });
  };

  const onDone = ({ kind, name, durationMs, size, fromCache }) => {
    // Read the cache statistics so the cache utilisation is observable.  This
    // is how the business layer verifies that the FontManager cache is
    // actually doing its job.
    const stats = fontManager.getCacheStats();
    emit("fontlifecycledone", {
      kind,
      name,
      durationMs,
      size,
      fromCache,
      cacheHits: stats.totalHits,
      cacheMisses: stats.totalMisses,
      cachedEntries: stats.entryCount,
    });
    if (logger?.debug) {
      logger.debug(
        `[FontManager] loaded ${kind}:${name} in ${durationMs}ms ` +
          `(${size} bytes, cache=${fromCache ? "HIT" : "MISS"}, ` +
          `hits=${stats.totalHits}, misses=${stats.totalMisses})`
      );
    }
  };

  const onError = ({ kind, name, error }) => {
    emit("fontlifecycleerror", { kind, name, message: error?.message });
    if (logger?.warn) {
      logger.warn(
        `[FontManager] failed to load ${kind}:${name}: ${error?.message}`
      );
    }
  };

  const onFallback = ({ requested, resolved, chain }) => {
    emit("fontfallback", { requested, resolved, chain });
  };

  const onPreloadDone = ({ completed, failed }) => {
    emit("fontpreloaddone", { completed, failed });
  };

  const unsubscribers = [
    fontManager.on("resource:load:start", onStart),
    fontManager.on("resource:load:done", onDone),
    fontManager.on("resource:load:error", onError),
    fontManager.on("font:fallback", onFallback),
    fontManager.on("preload:done", onPreloadDone),
  ];

  return {
    destroy() {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      unsubscribers.length = 0;
    },
  };
}

export { bindFontLifecycle };
