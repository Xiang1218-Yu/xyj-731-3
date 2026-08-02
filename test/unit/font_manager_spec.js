/* eslint-disable sort-imports */
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

import {
  configureFontManager,
  getFontManager,
  resetFontManager,
} from "../../src/display/font_manager_adapter.js";
import {
  FontFailureTracker,
  FontFallbackChainBuilder,
} from "../../src/display/font_fallback_chain.js";
import { CMapLoader } from "../../src/display/cmap_loader.js";
import { FallbackLevel, FontEventType } from "../../src/display/font_types.js";
import { FontEventBus } from "../../src/display/font_event_bus.js";
import { FontManager } from "../../src/display/font_manager.js";
import { LRUCache } from "../../src/display/font_cache.js";

function createMockFetcher() {
  const calls = [];
  const dataMap = new Map();
  return {
    calls,
    setData(kind, filename, bytes) {
      dataMap.set(`${kind}:${filename}`, bytes);
    },
    async fetch(kind, filename) {
      calls.push({ kind, filename });
      const key = `${kind}:${filename}`;
      if (dataMap.has(key)) {
        return dataMap.get(key);
      }
      if (kind === "cMapUrl") {
        return new Uint8Array([0x25, 0x21, 0x70, 0x73]);
      }
      throw new Error(`Unexpected fetch: ${kind} / ${filename}`);
    },
  };
}

describe("FontEventBus", function () {
  let bus;
  beforeEach(function () {
    bus = new FontEventBus();
  });
  afterEach(function () {
    bus.destroy();
  });

  it("should dispatch events to registered listeners", function () {
    const received = [];
    bus.on(FontEventType.FontLoadStart, evt => {
      received.push(evt);
    });
    bus.dispatch(FontEventType.FontLoadStart, {
      fontName: "TestFont",
      loadedName: "g_d0_s0",
      timestamp: 1000,
    });
    expect(received.length).toBe(1);
    expect(received[0].fontName).toBe("TestFont");
  });

  it("should support multiple listeners", function () {
    let count = 0;
    bus.on(FontEventType.CMapLoadSuccess, () => count++);
    bus.on(FontEventType.CMapLoadSuccess, () => count++);
    bus.dispatch(FontEventType.CMapLoadSuccess, {
      cMapName: "Test",
      loadTimeMs: 10,
      fromCache: false,
      isCompressed: true,
    });
    expect(count).toBe(2);
  });

  it("should remove listeners with off()", function () {
    let count = 0;
    const listener = () => count++;
    bus.on(FontEventType.FontLoadSuccess, listener);
    bus.dispatch(FontEventType.FontLoadSuccess, {
      fontName: "A",
      loadedName: "a",
      loadTimeMs: 1,
      fromCache: false,
    });
    expect(count).toBe(1);
    bus.off(FontEventType.FontLoadSuccess, listener);
    bus.dispatch(FontEventType.FontLoadSuccess, {
      fontName: "B",
      loadedName: "b",
      loadTimeMs: 1,
      fromCache: false,
    });
    expect(count).toBe(1);
  });

  it("should support once option", function () {
    let count = 0;
    bus.on(FontEventType.CMapLoadError, () => count++, { once: true });
    bus.dispatch(FontEventType.CMapLoadError, {
      cMapName: "X",
      error: new Error("fail"),
    });
    bus.dispatch(FontEventType.CMapLoadError, {
      cMapName: "X",
      error: new Error("fail"),
    });
    expect(count).toBe(1);
  });

  it("should support AbortSignal", function () {
    const controller = new AbortController();
    let count = 0;
    bus.on(FontEventType.FontFallback, () => count++, {
      signal: controller.signal,
    });
    bus.dispatch(FontEventType.FontFallback, {
      fontName: "F",
      fromLevel: FallbackLevel.Embedded,
      toLevel: FallbackLevel.SystemFont,
      reason: "test",
    });
    expect(count).toBe(1);
    controller.abort();
    bus.dispatch(FontEventType.FontFallback, {
      fontName: "F",
      fromLevel: FallbackLevel.Embedded,
      toLevel: FallbackLevel.SystemFont,
      reason: "test",
    });
    expect(count).toBe(1);
  });

  it("should not dispatch after destroy", function () {
    let count = 0;
    bus.on(FontEventType.FontLoadStart, () => count++);
    bus.destroy();
    bus.dispatch(FontEventType.FontLoadStart, {
      fontName: "X",
      loadedName: "x",
      timestamp: 0,
    });
    expect(count).toBe(0);
  });

  it("should track dispatch count", function () {
    expect(bus.dispatchCount).toBe(0);
    bus.dispatch(FontEventType.CMapLoadStart, {
      cMapName: "A",
      timestamp: 0,
    });
    bus.dispatch(FontEventType.CMapLoadStart, {
      cMapName: "B",
      timestamp: 0,
    });
    expect(bus.dispatchCount).toBe(2);
  });
});

describe("LRUCache", function () {
  it("should store and retrieve values", function () {
    const cache = new LRUCache({ maxSize: 10, ttlMs: 0, persistent: false });
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("should return undefined for missing keys", function () {
    const cache = new LRUCache({ maxSize: 10, ttlMs: 0, persistent: false });
    expect(cache.get("missing")).toBeUndefined();
  });

  it("should evict LRU entry when maxSize exceeded", function () {
    const cache = new LRUCache({ maxSize: 2, ttlMs: 0, persistent: false });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("should update LRU order on access", function () {
    const cache = new LRUCache({ maxSize: 2, ttlMs: 0, persistent: false });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
  });

  it("should track hit/miss stats", function () {
    const cache = new LRUCache({ maxSize: 10, ttlMs: 0, persistent: false });
    cache.set("hit", "yes");
    cache.get("hit");
    cache.get("miss");
    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });

  it("should support getOrSet", function () {
    const cache = new LRUCache({ maxSize: 10, ttlMs: 0, persistent: false });
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls++;
      return "computed";
    };
    expect(cache.getOrSet("key", factory)).toBe("computed");
    expect(cache.getOrSet("key", factory)).toBe("computed");
    expect(factoryCalls).toBe(1);
  });

  it("should support getOrSetAsync with de-dup", async function () {
    const cache = new LRUCache({ maxSize: 10, ttlMs: 0, persistent: false });
    let factoryCalls = 0;
    const factory = async () => {
      factoryCalls++;
      return new Promise(resolve => {
        setTimeout(() => resolve("async"), 10);
      });
    };
    const [r1, r2] = await Promise.all([
      cache.getOrSetAsync("key", factory),
      cache.getOrSetAsync("key", factory),
    ]);
    expect(r1).toBe("async");
    expect(r2).toBe("async");
    expect(factoryCalls).toBe(1);
  });

  it("should delete entries", function () {
    const cache = new LRUCache({ maxSize: 10, ttlMs: 0, persistent: false });
    cache.set("key", "val");
    expect(cache.delete("key")).toBeTrue();
    expect(cache.get("key")).toBeUndefined();
  });

  it("should clear all entries", function () {
    const cache = new LRUCache({ maxSize: 10, ttlMs: 0, persistent: false });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("should support eviction callback", function () {
    const evictions = [];
    const cache = new LRUCache(
      { maxSize: 1, ttlMs: 0, persistent: false },
      "testCache"
    );
    cache.setEvictionCallback((key, value, reason) => {
      evictions.push({ key, value, reason });
    });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(evictions.length).toBe(1);
    expect(evictions[0].key).toBe("a");
    expect(evictions[0].reason).toBe("size");
  });
});

describe("CMapLoader", function () {
  let fetcher, bus, loader;
  beforeEach(function () {
    fetcher = createMockFetcher();
    bus = new FontEventBus();
    loader = new CMapLoader(
      fetcher,
      {
        cMapUrl: "/cmaps/",
        cMapPacked: true,
        preloadStrategy: "none",
        concurrency: 2,
      },
      bus
    );
  });
  afterEach(function () {
    bus.destroy();
  });

  it("should load a CMap by name", async function () {
    const data = await loader.load("Adobe-Japan1-UCS2");
    expect(data).toBeDefined();
    expect(data.cMapData).toBeInstanceOf(Uint8Array);
    expect(data.isCompressed).toBeTrue();
  });

  it("should cache loaded CMaps", async function () {
    await loader.load("Adobe-GB1-UCS2");
    await loader.load("Adobe-GB1-UCS2");
    const cmapCalls = fetcher.calls.filter(
      c => c.filename === "Adobe-GB1-UCS2.bcmap"
    );
    expect(cmapCalls.length).toBe(1);
  });

  it("should de-duplicate concurrent loads", async function () {
    const [r1, r2] = await Promise.all([
      loader.load("Adobe-CNS1-UCS2"),
      loader.load("Adobe-CNS1-UCS2"),
    ]);
    expect(r1).toBe(r2);
    const cmapCalls = fetcher.calls.filter(
      c => c.filename === "Adobe-CNS1-UCS2.bcmap"
    );
    expect(cmapCalls.length).toBe(1);
  });

  it("should emit lifecycle events", async function () {
    const startEvents = [];
    const successEvents = [];
    bus.on(FontEventType.CMapLoadStart, e => startEvents.push(e));
    bus.on(FontEventType.CMapLoadSuccess, e => successEvents.push(e));
    await loader.load("Adobe-Korea1-UCS2");
    expect(startEvents.length).toBe(1);
    expect(successEvents.length).toBe(1);
    expect(successEvents[0].fromCache).toBeFalse();
  });

  it("should preload with unicode strategy", async function () {
    const count = await loader.preload("unicode");
    expect(count).toBe(4);
  });

  it("should preload with cjk strategy", async function () {
    const count = await loader.preload("cjk");
    expect(count).toBeGreaterThan(10);
  });

  it("should create a fetch function", async function () {
    const fetchFn = loader.createFetchFn();
    const data = await fetchFn("Adobe-Japan1-UCS2");
    expect(data).toBeDefined();
  });

  it("should throw for identity CMaps", async function () {
    await expectAsync(loader.load("Identity-H")).toBeRejected();
  });
});

describe("FontFailureTracker", function () {
  it("should track failures", function () {
    const tracker = new FontFailureTracker();
    expect(tracker.isFailing("FontA")).toBeFalse();
    tracker.recordFailure("FontA");
    tracker.recordFailure("FontA");
    expect(tracker.isFailing("FontA")).toBeFalse();
    tracker.recordFailure("FontA");
    expect(tracker.isFailing("FontA")).toBeTrue();
  });

  it("should clear failures on success", function () {
    const tracker = new FontFailureTracker();
    tracker.recordFailure("FontA");
    tracker.recordFailure("FontA");
    tracker.recordSuccess("FontA");
    expect(tracker.getFailCount("FontA")).toBe(0);
  });
});

describe("FontFallbackChainBuilder", function () {
  let builder;
  beforeEach(function () {
    builder = new FontFallbackChainBuilder();
  });

  it("should build chain for embedded font", function () {
    const result = builder.build({
      baseFontName: "TestFont",
      standardFontName: undefined,
      subtype: "TrueType",
      isEmbedded: true,
      loadedName: "g_d0_s0",
      cssFontInfo: undefined,
      systemFontInfo: undefined,
      sampleCodepoints: undefined,
    });
    expect(result.hasEmbedded).toBeTrue();
    expect(result.chain[0].level).toBe(FallbackLevel.Embedded);
    const last = result.chain.at(-1);
    expect(last.level).toBe(FallbackLevel.RendererFallback);
  });

  it("should detect sans-serif family", function () {
    const result = builder.build({
      baseFontName: "Arial",
      standardFontName: "Helvetica",
      subtype: "TrueType",
      isEmbedded: false,
      loadedName: "g_d0_s2",
      cssFontInfo: undefined,
      systemFontInfo: undefined,
      sampleCodepoints: undefined,
    });
    expect(result.genericFamily).toBe("sans-serif");
  });

  it("should detect serif family", function () {
    const result = builder.build({
      baseFontName: "Times",
      standardFontName: "Times-Roman",
      subtype: "Type1",
      isEmbedded: false,
      loadedName: "g_d0_s3",
      cssFontInfo: undefined,
      systemFontInfo: undefined,
      sampleCodepoints: undefined,
    });
    expect(result.genericFamily).toBe("serif");
  });

  it("should detect monospace family", function () {
    const result = builder.build({
      baseFontName: "Courier New",
      standardFontName: "Courier",
      subtype: "Type1",
      isEmbedded: false,
      loadedName: "g_d0_s4",
      cssFontInfo: undefined,
      systemFontInfo: undefined,
      sampleCodepoints: undefined,
    });
    expect(result.genericFamily).toBe("monospace");
  });

  it("should detect CJK fonts by name", function () {
    const result = builder.build({
      baseFontName: "HeiseiMin-W3",
      standardFontName: undefined,
      subtype: "CIDFontType0",
      isEmbedded: false,
      loadedName: "g_d0_s5",
      cssFontInfo: undefined,
      systemFontInfo: undefined,
      sampleCodepoints: undefined,
    });
    const systemFonts = result.chain.filter(
      e => e.level === FallbackLevel.SystemFont
    );
    expect(systemFonts.length).toBeGreaterThan(0);
  });

  it("should skip failing fonts with tracker", function () {
    const tracker = new FontFailureTracker();
    const trackedBuilder = new FontFallbackChainBuilder(tracker);
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure("Arial");
    }
    const result = trackedBuilder.build({
      baseFontName: "Helvetica",
      standardFontName: "Helvetica",
      subtype: "Type1",
      isEmbedded: false,
      loadedName: "g_d0_s9",
      cssFontInfo: undefined,
      systemFontInfo: undefined,
      sampleCodepoints: undefined,
    });
    const fontNames = result.chain.map(e => e.fontFamily);
    expect(fontNames).not.toContain("Arial");
  });
});

describe("FontManager", function () {
  beforeEach(function () {
    resetFontManager();
  });
  afterEach(function () {
    resetFontManager();
  });

  it("should return same singleton", function () {
    const a = FontManager.getInstance();
    const b = FontManager.getInstance();
    expect(a).toBe(b);
  });

  it("should not be configured by default", function () {
    const mgr = FontManager.getInstance();
    expect(mgr.isConfigured).toBeFalse();
  });

  it("should configure with options", function () {
    const mgr = FontManager.getInstance();
    const fetcher = createMockFetcher();
    mgr.configure(
      {
        cMap: {
          cMapUrl: "/cmaps/",
          cMapPacked: true,
          preloadStrategy: "auto",
          concurrency: 4,
        },
      },
      fetcher
    );
    expect(mgr.isConfigured).toBeTrue();
    expect(mgr.config.cMap.cMapUrl).toBe("/cmaps/");
  });

  it("should register fonts and build fallback chains", function () {
    const mgr = FontManager.getInstance();
    const fetcher = createMockFetcher();
    mgr.configure({}, fetcher);
    const chain = mgr.registerFont({
      loadedName: "g_d0_s0",
      baseFontName: "Helvetica",
      standardFontName: "Helvetica",
      subtype: "Type1",
      vertical: false,
      missingFile: false,
      disableFontFace: false,
      cssFontInfo: undefined,
      systemFontInfo: undefined,
    });
    expect(chain).toBeDefined();
    expect(mgr.activeFontCount).toBe(1);
  });

  it("should record font load success", function () {
    const mgr = FontManager.getInstance();
    const fetcher = createMockFetcher();
    mgr.configure({}, fetcher);
    mgr.registerFont({
      loadedName: "g_d0_s0",
      baseFontName: "Test",
      standardFontName: undefined,
      subtype: "TrueType",
      vertical: false,
      missingFile: false,
      disableFontFace: false,
      cssFontInfo: undefined,
      systemFontInfo: undefined,
    });
    let eventReceived = false;
    mgr.eventBus.on(FontEventType.FontLoadSuccess, () => {
      eventReceived = true;
    });
    mgr.recordFontLoadSuccess("g_d0_s0", FallbackLevel.Embedded, false);
    expect(eventReceived).toBeTrue();
  });

  it("should fetch built-in CMaps", async function () {
    const mgr = FontManager.getInstance();
    const fetcher = createMockFetcher();
    mgr.configure(
      {
        cMap: {
          cMapUrl: "/cmaps/",
          cMapPacked: true,
          preloadStrategy: "none",
          concurrency: 4,
        },
      },
      fetcher
    );
    const data = await mgr.fetchBuiltInCMap("Adobe-Japan1-UCS2");
    expect(data).toBeDefined();
    expect(data.cMapData).toBeInstanceOf(Uint8Array);
  });

  it("should cache font data", function () {
    const mgr = FontManager.getInstance();
    const fetcher = createMockFetcher();
    mgr.configure({}, fetcher);
    const bytes = new Uint8Array([1, 2, 3]);
    mgr.cacheFontData("font1", bytes);
    expect(mgr.getCachedFontData("font1")).toBe(bytes);
  });

  it("should report stats", function () {
    const mgr = FontManager.getInstance();
    const fetcher = createMockFetcher();
    mgr.configure({}, fetcher);
    const stats = mgr.getStats();
    expect(stats).toBeDefined();
    expect(typeof stats.totalFontsLoaded).toBe("number");
    expect(stats.fontCacheStats).toBeDefined();
  });

  it("should cleanup registered fonts", function () {
    const mgr = FontManager.getInstance();
    const fetcher = createMockFetcher();
    mgr.configure({}, fetcher);
    mgr.registerFont({
      loadedName: "g_d0_s0",
      baseFontName: "Test",
      standardFontName: undefined,
      subtype: "TrueType",
      vertical: false,
      missingFile: false,
      disableFontFace: false,
      cssFontInfo: undefined,
      systemFontInfo: undefined,
    });
    expect(mgr.activeFontCount).toBe(1);
    mgr.cleanup();
    expect(mgr.activeFontCount).toBe(0);
  });
});

describe("FontManager adapter", function () {
  afterEach(function () {
    resetFontManager();
  });

  it("should configure via configureFontManager", function () {
    const fetcher = createMockFetcher();
    const mgr = configureFontManager({
      cMapUrl: "/cmaps/",
      cMapPacked: true,
      binaryDataFactory: {
        fetch: params => fetcher.fetch(params.kind, params.filename),
      },
    });
    expect(mgr.isConfigured).toBeTrue();
  });

  it("should return singleton via getFontManager", function () {
    const mgr1 = getFontManager();
    const mgr2 = getFontManager();
    expect(mgr1).toBe(mgr2);
  });
});
