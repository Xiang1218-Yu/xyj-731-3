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
 * Worker-side FontManager bridge for the core (worker) layer.
 *
 * This module provides a worker-compatible subset of FontManager functionality:
 *  - Async CMap loading with caching (replaces evaluator.fetchBuiltInCMap).
 *  - Standard font data loading with caching.
 *  - Font fallback chain tracking.
 *
 * Unlike the display-side FontManager (which handles DOM FontFace operations),
 * this worker-side module has no DOM dependencies and can run inside the
 * PDF.js worker thread. It uses the existing MessageHandler for main-thread
 * binary data fetching, or direct fetch() when useWorkerFetch is enabled.
 *
 * Design: singleton per worker, configured once per document.
 */

import { warn } from "../shared/util.js";

// ---------------------------------------------------------------------------
// WorkerCMapLoader — async CMap loading with in-memory cache
// ---------------------------------------------------------------------------

/**
 * Async CMap loader that caches raw CMap data with request de-duplication.
 * Replaces the ad-hoc caching in PartialEvaluator.fetchBuiltInCMap with a
 * unified, observable implementation.
 *
 * Note: This loader caches RAW data only. CMap parsing is handled by the
 * existing CMapFactory which calls the configured fetchBuiltInCMap function.
 */
class WorkerCMapLoader {
  constructor() {
    /**
     * @type {Map<string, Promise<{
     *   cMapData: Uint8Array,
     *   isCompressed: boolean
     * }>>}
     */
    this._cache = new Map();
    /** @type {Function|null} */
    this._fetchFn = null;
    this._cMapPacked = true;
  }

  /**
   * Configure the loader.
   * @param {object} options
   * @param {Function} options.fetchFn - Async fn (name) =>
   *   {cMapData, isCompressed}
   * @param {boolean} options.cMapPacked
   */
  configure({ fetchFn, cMapPacked = true }) {
    this._fetchFn = fetchFn;
    this._cMapPacked = cMapPacked;
  }

  /**
   * Load raw CMap data by name, with caching and de-duplication.
   * This is the bridge method compatible with CMapFactory.fetchBuiltInCMap.
   * @param {string} name
   * @returns {Promise<{cMapData: Uint8Array, isCompressed: boolean}>}
   */
  async fetchRawData(name) {
    if (this._cache.has(name)) {
      return this._cache.get(name);
    }
    if (!this._fetchFn) {
      throw new Error("WorkerCMapLoader not configured.");
    }
    const promise = this._fetchFn(name);
    this._cache.set(name, promise);
    try {
      return await promise;
    } catch (ex) {
      this._cache.delete(name);
      throw ex;
    }
  }

  /**
   * Check whether raw CMap data is already cached.
   */
  hasCached(name) {
    return this._cache.has(name);
  }

  /**
   * Clear all caches.
   */
  clear() {
    this._cache.clear();
  }

  /**
   * Get cache statistics.
   */
  getStats() {
    return {
      rawCacheSize: this._cache.size,
    };
  }
}

// ---------------------------------------------------------------------------
// WorkerFontFallbackTracker — tracks font load failures in the worker
// ---------------------------------------------------------------------------

class WorkerFontFallbackTracker {
  constructor() {
    /** @type {Map<string, {failCount: number, lastFailure: number}>} */
    this._failures = new Map();
  }

  recordSuccess(fontName) {
    this._failures.delete(fontName);
  }

  recordFailure(fontName) {
    const existing = this._failures.get(fontName);
    this._failures.set(fontName, {
      failCount: (existing?.failCount ?? 0) + 1,
      lastFailure: Date.now(),
    });
  }

  isFailing(fontName) {
    const record = this._failures.get(fontName);
    if (!record) {
      return false;
    }
    if (Date.now() - record.lastFailure > 5 * 60 * 1000) {
      this._failures.delete(fontName);
      return false;
    }
    return record.failCount >= 3;
  }

  clear() {
    this._failures.clear();
  }
}

// ---------------------------------------------------------------------------
// WorkerFontManager — singleton for the worker thread
// ---------------------------------------------------------------------------

let _instance = null;

class WorkerFontManager {
  constructor() {
    this.cMapLoader = new WorkerCMapLoader();
    this.fallbackTracker = new WorkerFontFallbackTracker();
    /** @type {Map<string, object>} */
    this._fontRegistry = new Map();
    this._configured = false;
    this._standardFontCache = new Map();
    this._stats = {
      totalCMapsLoaded: 0,
      totalFontsRegistered: 0,
      totalFallbacks: 0,
    };
  }

  static getInstance() {
    _instance ??= new WorkerFontManager();
    return _instance;
  }

  static resetInstance() {
    if (_instance) {
      _instance.destroy();
    }
    _instance = null;
  }

  /**
   * Configure the worker FontManager.
   * @param {object} options
   * @param {Function} options.fetchBuiltInCMapFn - (name) =>
   *   Promise<{cMapData, isCompressed}>
   * @param {Function} options.fetchStandardFontDataFn - (name) =>
   *   Promise<Uint8Array|null>
   * @param {boolean} options.cMapPacked
   */
  configure({
    fetchBuiltInCMapFn,
    fetchStandardFontDataFn,
    cMapPacked = true,
  }) {
    this.cMapLoader.configure({
      fetchFn: fetchBuiltInCMapFn,
      cMapPacked,
    });
    this._fetchStandardFontDataFn = fetchStandardFontDataFn;
    this._configured = true;
  }

  get isConfigured() {
    return this._configured;
  }

  /**
   * Fetch built-in CMap data — bridge method compatible with the existing
   * CMapFactory.fetchBuiltInCMap interface.
   * @param {string} name
   * @returns {Promise<{cMapData: Uint8Array, isCompressed: boolean}>}
   */
  async fetchBuiltInCMap(name) {
    const result = await this.cMapLoader.fetchRawData(name);
    this._stats.totalCMapsLoaded++;
    return result;
  }

  /**
   * Fetch standard font data with caching.
   * @param {string} name
   * @returns {Promise<Uint8Array|null>}
   */
  async fetchStandardFontData(name) {
    if (this._standardFontCache.has(name)) {
      return this._standardFontCache.get(name);
    }
    if (!this._fetchStandardFontDataFn) {
      return null;
    }
    const data = await this._fetchStandardFontDataFn(name);
    if (data) {
      this._standardFontCache.set(name, data);
    }
    return data;
  }

  /**
   * Create a bound fetchBuiltInCMap function for CMapFactory.
   * @returns {(name: string) => Promise<{
   *   cMapData: Uint8Array,
   *   isCompressed: boolean
   * }>}
   */
  createCMapFetchFn() {
    return name => this.fetchBuiltInCMap(name);
  }

  /**
   * Register a font for fallback tracking.
   * @param {object} fontInfo
   */
  registerFont(fontInfo) {
    const key = fontInfo.loadedName || fontInfo.name;
    if (key && !this._fontRegistry.has(key)) {
      this._fontRegistry.set(key, {
        ...fontInfo,
        registeredAt: Date.now(),
        currentLevel: 0,
      });
      this._stats.totalFontsRegistered++;
    }
  }

  /**
   * Record a font load failure.
   */
  recordFontFailure(loadedName, level, error) {
    this.fallbackTracker.recordFailure(loadedName);
    this._stats.totalFallbacks++;
    warn(`Font load failure for "${loadedName}": ${error?.message || error}`);
  }

  /**
   * Record a font load success.
   */
  recordFontSuccess(loadedName) {
    this.fallbackTracker.recordSuccess(loadedName);
  }

  /**
   * Get aggregated statistics.
   */
  getStats() {
    return {
      ...this._stats,
      cMapCache: this.cMapLoader.getStats(),
      standardFontCacheSize: this._standardFontCache.size,
      registeredFontCount: this._fontRegistry.size,
    };
  }

  /**
   * Clean up document-specific state (called on document close).
   */
  cleanup() {
    this._fontRegistry.clear();
    this.cMapLoader.clear();
    this._standardFontCache.clear();
    this._stats.totalFontsRegistered = 0;
    this._stats.totalFallbacks = 0;
  }

  /**
   * Full destruction (called on worker termination).
   */
  destroy() {
    this.cleanup();
    this.fallbackTracker.clear();
    this._configured = false;
  }
}

export { WorkerCMapLoader, WorkerFontFallbackTracker, WorkerFontManager };
