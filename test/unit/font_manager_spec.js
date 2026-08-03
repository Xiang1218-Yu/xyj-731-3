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
 * Regression tests for the refactored FontManager sub-system.
 *
 * These tests are framework-agnostic Jasmine specs that exercise the compiled
 * JavaScript output (`build/font-manager/index.js`).  They intentionally avoid
 * depending on the rest of the PDF.js build so they can run quickly and in
 * isolation via `npx jasmine` / Node.js.
 *
 * Coverage map:
 *  - EventBus           : subscription, once, off, re-entrancy, isolation.
 *  - FontCache          : set/get, hit/miss stats, LRU/LFU eviction, clear.
 *  - CMapLoader         : async fetch, caching, in-flight de-dup, preload.
 *  - StandardFontLoader : filename mapping, caching, null for unknown names.
 *  - FontFallbackChain  : alias → local → generic → ultimate ordering.
 *  - FontManager        : singleton, end-to-end CMap load + events, adapters,
 *                         preload strategy, registry, cache stats, clear.
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const __dirname = import.meta.dirname;
const buildDir = resolve(__dirname, "../../src/shared/font_manager/dist");
// eslint-disable-next-line no-unsanitized/method
const mod = await import(pathToFileURL(resolve(buildDir, "index.js")).href);

const {
  FontManager,
  EventBus,
  FontCache,
  CMapLoader,
  StandardFontLoader,
  FontFallbackChain,
  createBinaryFetcherFromFactory,
  createLegacyCMapFetcher,
  createLegacyStandardFontFetcher,
  toFontDescriptor,
  registerLegacyFont,
  asCMapName,
  asFontName,
  cacheKey,
  COMMON_CMAP_NAMES,
  DEFAULT_CACHE_OPTIONS,
} = mod;

/** Build a deterministic in-memory fetcher used by the loader tests. */
function createFakeFetcher(responses) {
  const calls = [];
  const fetcher = {
    calls,
    async fetch(request) {
      calls.push(request);
      if (request.kind === "cmap") {
        // The fetcher receives a `ResourceRequest` whose name is the plain
        // CMap name; the compressed suffix is added by the binary-data
        // factory adapter.  Tests therefore key responses by the plain name.
        const key = request.name;
        if (key in responses) {
          return responses[key];
        }
        throw new Error(`Unknown CMap: ${key}`);
      }
      if (request.kind === "standardFont") {
        const key = request.filename;
        if (key in responses) {
          return responses[key];
        }
        throw new Error(`Unknown standard font: ${key}`);
      }
      throw new Error(`Unsupported kind: ${request.kind}`);
    },
  };
  return fetcher;
}

function bytes(str) {
  return new TextEncoder().encode(str);
}

describe("FontManager/EventBus", function () {
  afterEach(function () {
    FontManager.reset();
  });

  it("returns a singleton instance", function () {
    const a = FontManager.getInstance();
    const b = FontManager.getInstance();
    expect(a).toBe(b);
  });

  it("emits and receives typed events", function () {
    const bus = new EventBus();
    const received = [];
    bus.on("resource:load:start", p => received.push(p));
    bus.emit("resource:load:start", { kind: "cmap", name: "GBK-EUC-H" });
    expect(received).toEqual([{ kind: "cmap", name: "GBK-EUC-H" }]);
  });

  it("supports once() listeners that auto-unsubscribe", function () {
    const bus = new EventBus();
    let count = 0;
    bus.once("preload:done", () => count++);
    bus.emit("preload:done", { completed: 1, failed: 0 });
    bus.emit("preload:done", { completed: 2, failed: 0 });
    expect(count).toBe(1);
  });

  it("off() removes a listener", function () {
    const bus = new EventBus();
    let count = 0;
    const listener = () => count++;
    bus.on("preload:done", listener);
    bus.emit("preload:done", { completed: 1, failed: 0 });
    bus.off("preload:done", listener);
    bus.emit("preload:done", { completed: 1, failed: 0 });
    expect(count).toBe(1);
  });

  it("keeps dispatching when a listener throws", async function () {
    const bus = new EventBus();
    let secondCalled = false;
    bus.on("preload:done", () => {
      throw new Error("boom");
    });
    bus.on("preload:done", () => {
      secondCalled = true;
    });
    bus.emit("preload:done", { completed: 1, failed: 0 });
    // Wait for the microtask that re-throws the first listener error.
    await Promise.resolve();
    expect(secondCalled).toBeTrue();
  });

  it("is safe against listeners added during dispatch", function () {
    const bus = new EventBus();
    const calls = [];
    bus.on("preload:done", () => {
      calls.push("first");
      bus.on("preload:done", () => calls.push("added-during"));
    });
    bus.emit("preload:done", { completed: 1, failed: 0 });
    expect(calls).toEqual(["first"]);
    bus.emit("preload:done", { completed: 1, failed: 0 });
    expect(calls).toEqual(["first", "first", "added-during"]);
  });
});

describe("FontManager/FontCache", function () {
  it("stores and retrieves values and tracks hits/misses", function () {
    const cache = new FontCache();
    const key = cacheKey("cmap", "GBK-EUC-H");
    cache.set(key, "cmap", { data: 1 }, 42);
    expect(cache.get(key)).toEqual({ data: 1 });
    expect(cache.get(key)).toEqual({ data: 1 });
    expect(cache.get(cacheKey("cmap", "missing"))).toBeUndefined();
    const stats = cache.getStats();
    expect(stats.totalHits).toBe(2);
    expect(stats.totalMisses).toBe(1);
    expect(stats.totalSize).toBe(42);
  });

  it("evicts the least-recently-used entry under LRU", function () {
    const cache = new FontCache({ maxEntries: 2, evictionPolicy: "lru" });
    const evictions = [];
    cache.setEvictionListener(n => evictions.push(n));
    cache.set(cacheKey("cmap", "a"), "cmap", 1, 10);
    cache.set(cacheKey("cmap", "b"), "cmap", 2, 10);
    // Touch "a" so "b" becomes the LRU.
    cache.get(cacheKey("cmap", "a"));
    cache.set(cacheKey("cmap", "c"), "cmap", 3, 10);
    expect(cache.has(cacheKey("cmap", "b"))).toBeFalse();
    expect(cache.has(cacheKey("cmap", "a"))).toBeTrue();
    expect(evictions[0].reason).toBe("entries");
  });

  it("evicts the least-frequently-used entry under LFU", function () {
    const cache = new FontCache({ maxEntries: 2, evictionPolicy: "lfu" });
    cache.set(cacheKey("cmap", "a"), "cmap", 1, 10);
    cache.set(cacheKey("cmap", "b"), "cmap", 2, 10);
    // "a" gets more hits; "b" should be evicted.
    cache.get(cacheKey("cmap", "a"));
    cache.get(cacheKey("cmap", "a"));
    cache.set(cacheKey("cmap", "c"), "cmap", 3, 10);
    expect(cache.has(cacheKey("cmap", "b"))).toBeFalse();
    expect(cache.has(cacheKey("cmap", "a"))).toBeTrue();
  });

  it("evicts by size budget", function () {
    const cache = new FontCache({
      maxEntries: 100,
      maxBytes: 30,
      evictionPolicy: "lru",
    });
    cache.set(cacheKey("cmap", "a"), "cmap", 1, 20);
    cache.set(cacheKey("cmap", "b"), "cmap", 2, 20);
    // Inserting "b" must evict "a" to satisfy the 30-byte budget.
    expect(cache.has(cacheKey("cmap", "a"))).toBeFalse();
    expect(cache.getStats().totalSize).toBe(20);
  });

  it("clear() empties the cache and emits manual evictions", function () {
    const cache = new FontCache();
    const evictions = [];
    cache.setEvictionListener(n => evictions.push(n));
    cache.set(cacheKey("cmap", "a"), "cmap", 1, 10);
    cache.set(cacheKey("cmap", "b"), "cmap", 2, 10);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(evictions.length).toBe(2);
    expect(evictions.every(e => e.reason === "manual")).toBeTrue();
  });

  it("exposes sane defaults", function () {
    expect(DEFAULT_CACHE_OPTIONS.maxEntries).toBeGreaterThan(0);
    expect(DEFAULT_CACHE_OPTIONS.evictionPolicy).toBe("lru");
  });

  it("does not infinite-loop when eviction cannot satisfy the byte budget", function () {
    // Even though eviction removes entries, a single entry larger than
    // `maxBytes` means the budget can never be met.  The iteration guard must
    // terminate the loop instead of spinning forever (which would hang the
    // test / thread).
    const cache = new FontCache({
      maxEntries: 100,
      maxBytes: 10,
      evictionPolicy: "lru",
    });
    const evictions = [];
    cache.setEvictionListener(n => evictions.push(n));
    cache.set(cacheKey("cmap", "huge"), "cmap", 1, 1000);
    // The oversized entry is evicted once and the loop terminates; it is not
    // retained because it alone exceeds the budget.
    expect(cache.size).toBe(0);
    expect(evictions.length).toBe(1);
  });
});

describe("FontManager/CMapLoader", function () {
  it("fetches, caches, and reports the compressed flag", async function () {
    const cache = new FontCache();
    const fetcher = createFakeFetcher({
      "GBK-EUC-H": bytes("cmap-bytes"),
    });
    const loader = new CMapLoader({
      fetcher,
      cMapPacked: true,
      cache,
    });
    const first = await loader.load(asCMapName("GBK-EUC-H"));
    expect(first.isCompressed).toBeTrue();
    expect(new TextDecoder().decode(first.cMapData)).toBe("cmap-bytes");
    // Second call must be served from cache — no extra fetch.
    const second = await loader.load(asCMapName("GBK-EUC-H"));
    expect(second).toBe(first);
    expect(fetcher.calls.length).toBe(1);
  });

  it("de-duplicates concurrent in-flight requests for the same CMap", async function () {
    const cache = new FontCache();
    let resolveFetch;
    const fetcher = {
      calls: 0,
      fetch() {
        this.calls++;
        return new Promise(res => {
          resolveFetch = res;
        });
      },
    };
    const loader = new CMapLoader({
      fetcher,
      cMapPacked: false,
      cache,
    });
    const p1 = loader.load(asCMapName("UniJIS-UCS2-H"));
    const p2 = loader.load(asCMapName("UniJIS-UCS2-H"));
    expect(fetcher.calls).toBe(1);
    expect(loader.isLoading(asCMapName("UniJIS-UCS2-H"))).toBeTrue();
    resolveFetch(bytes("shared"));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(fetcher.calls).toBe(1);
  });

  it("preloads multiple CMaps with bounded concurrency", async function () {
    const cache = new FontCache();
    let active = 0;
    let maxActive = 0;
    const fetcher = {
      async fetch(request) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => {
          setTimeout(r, 5);
        });
        active--;
        return bytes(request.name);
      },
    };
    const loader = new CMapLoader({
      fetcher,
      cMapPacked: true,
      cache,
    });
    const names = ["a", "b", "c", "d", "e"].map(asCMapName);
    const result = await loader.preload(names, 2);
    expect(result.completed).toBe(5);
    expect(result.failed).toBe(0);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("surfaces errors through the onLoadError hook", async function () {
    const cache = new FontCache();
    const fetcher = createFakeFetcher({});
    const errors = [];
    const loader = new CMapLoader({
      fetcher,
      cMapPacked: true,
      cache,
      hooks: { onLoadError: (name, err) => errors.push([name, err]) },
    });
    await expectAsync(loader.load(asCMapName("missing"))).toBeRejected();
    expect(errors.length).toBe(1);
  });

  it("returns immediately for an empty preload list without fetching", async function () {
    const cache = new FontCache();
    let fetches = 0;
    const loader = new CMapLoader({
      fetcher: {
        async fetch() {
          fetches++;
          return bytes("x");
        },
      },
      cMapPacked: true,
      cache,
    });
    const result = await loader.preload([], 4);
    expect(result).toEqual({ completed: 0, failed: 0 });
    expect(fetches).toBe(0);
  });

  it("does not tear down a newer in-flight retry after a failure", async function () {
    const cache = new FontCache();
    let attempt = 0;
    const fetcher = {
      async fetch() {
        attempt++;
        if (attempt === 1) {
          throw new Error("transient");
        }
        return bytes("recovered");
      },
    };
    const loader = new CMapLoader({
      fetcher,
      cMapPacked: false,
      cache,
    });
    const name = asCMapName("Flaky-H");
    // First call fails.
    await expectAsync(loader.load(name)).toBeRejected();
    // The in-flight entry must have been cleared so a retry can start.
    expect(loader.isLoading(name)).toBeFalse();
    const recovered = await loader.load(name);
    expect(new TextDecoder().decode(recovered.cMapData)).toBe("recovered");
  });
});

describe("FontManager/StandardFontLoader", function () {
  it("returns null for an unknown font name", async function () {
    const cache = new FontCache();
    const loader = new StandardFontLoader({
      fetcher: createFakeFetcher({}),
      cache,
    });
    expect(await loader.load(asFontName("NotAFont"))).toBeNull();
  });

  it("loads and caches base-14 font bytes", async function () {
    const cache = new FontCache();
    const fetcher = createFakeFetcher({
      "Helvetica.afm": bytes("helvetica-data"),
    });
    const loader = new StandardFontLoader({ fetcher, cache });
    const first = await loader.load(asFontName("Helvetica"));
    expect(new TextDecoder().decode(first)).toBe("helvetica-data");
    const second = await loader.load(asFontName("Helvetica"));
    expect(second).toBe(first);
    expect(fetcher.calls.length).toBe(1);
  });

  it("exposes the static filename mapping", function () {
    expect(StandardFontLoader.filenameFor("Times-Roman")).toBe(
      "Times-Roman.afm"
    );
    expect(StandardFontLoader.filenameFor("ZapfDingbats")).toBe(
      "ZapfDingbats.afm"
    );
  });

  it("returns immediately for an empty preload list without fetching", async function () {
    const cache = new FontCache();
    let fetches = 0;
    const loader = new StandardFontLoader({
      fetcher: {
        async fetch() {
          fetches++;
          return bytes("x");
        },
      },
      cache,
    });
    const result = await loader.preload([], 4);
    expect(result).toEqual({ completed: 0, failed: 0 });
    expect(fetches).toBe(0);
  });
});

describe("FontManager/FontFallbackChain", function () {
  it("builds an ordered alias → local-match → ultimate chain", function () {
    const chain = new FontFallbackChain(() => true);
    const descriptor = toFontDescriptor({
      loadedName: "g_d0_f1",
      name: "Times-Roman",
    });
    const entries = chain.buildChain(descriptor);
    const reasons = entries.map(e => e.reason);
    // Priority ordering check.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].priority).toBeLessThanOrEqual(entries[i].priority);
    }
    expect(reasons).toContain("alias");
    expect(reasons).toContain("local-match");
    expect(reasons).toContain("ultimate");
    // The terminal entry must always be marked ultimate.
    expect(entries.at(-1).reason).toBe("ultimate");
  });

  it("never produces duplicate candidate names", function () {
    const chain = new FontFallbackChain(() => true);
    for (const name of [
      "Times-Roman",
      "Times-Bold",
      "Helvetica",
      "Courier",
      "Courier-Bold",
      "UnknownFont",
    ]) {
      const entries = chain.buildChain(
        toFontDescriptor({ loadedName: "f", name })
      );
      const candidates = entries.map(e => e.candidate);
      const unique = new Set(candidates);
      expect(unique.size)
        .withContext(`duplicate candidates for ${name}: ${candidates}`)
        .toBe(candidates.length);
      // The ultimate guarantee must still be present exactly once.
      const ultimateCount = entries.filter(e => e.reason === "ultimate").length;
      expect(ultimateCount).toBe(1);
    }
  });

  it("resolves to the first available candidate", async function () {
    const available = new Set(["Liberation Serif"]);
    const chain = new FontFallbackChain(c => available.has(c));
    const descriptor = toFontDescriptor({
      loadedName: "f1",
      name: "Times-Roman",
    });
    const result = await chain.resolve(descriptor);
    expect(result.resolved).toBe("Liberation Serif");
    expect(result.chain.length).toBeGreaterThan(0);
  });

  it("always falls back to the ultimate entry when nothing is available", async function () {
    const chain = new FontFallbackChain(() => false);
    const descriptor = toFontDescriptor({
      loadedName: "f1",
      name: "UnknownFont",
    });
    const result = await chain.resolve(descriptor);
    expect(["serif", "sans-serif", "monospace"]).toContain(result.resolved);
    const last = result.chain.at(-1);
    expect(last.reason).toBe("ultimate");
  });

  it("replaces the availability checker via setChecker", async function () {
    const chain = new FontFallbackChain(() => false);
    chain.setChecker(c => c === "Arial");
    const descriptor = toFontDescriptor({
      loadedName: "f1",
      name: "Helvetica",
    });
    const result = await chain.resolve(descriptor);
    expect(result.resolved).toBe("Arial");
  });
});

describe("FontManager/integration", function () {
  afterEach(function () {
    FontManager.reset();
  });

  it("loads CMaps end-to-end and emits lifecycle events", async function () {
    const manager = FontManager.getInstance();
    const events = [];
    manager.on("resource:load:start", e => events.push(["start", e.name]));
    manager.on("resource:load:done", e => events.push(["done", e.name]));
    manager.init({
      cMapPacked: true,
      fetcher: createFakeFetcher({
        "GBK-EUC-H": bytes("gbk"),
      }),
    });
    const data = await manager.loadCMap("GBK-EUC-H");
    expect(new TextDecoder().decode(data.cMapData)).toBe("gbk");
    // Second call: cache hit, should still emit start/done but no fetch.
    await manager.loadCMap("GBK-EUC-H");
    const names = events.filter(([t]) => t === "start").map(([, n]) => n);
    expect(names).toEqual(["GBK-EUC-H", "GBK-EUC-H"]);
  });

  it("registers fonts and exposes them via the registry", function () {
    const manager = FontManager.getInstance().init({});
    const name = registerLegacyFont(manager, {
      loadedName: "g_d0_f1",
      name: "Arial",
      bold: true,
    });
    expect(manager.getFont(name).name).toBe("Arial");
    expect(manager.listFonts().length).toBe(1);
    manager.clear();
    expect(manager.listFonts().length).toBe(0);
  });

  it("exposes cache statistics after loading", async function () {
    const manager = FontManager.getInstance().init({
      cMapPacked: false,
      fetcher: createFakeFetcher({ "ETen-B5-H": bytes("b5") }),
    });
    await manager.loadCMap("ETen-B5-H");
    const stats = manager.getCacheStats();
    expect(stats.entryCount).toBe(1);
    expect(stats.totalSize).toBeGreaterThan(0);
  });

  it("supports a preload strategy", async function () {
    const responses = {};
    for (const name of COMMON_CMAP_NAMES) {
      responses[name] = bytes(name);
    }
    const manager = FontManager.getInstance();
    const done = new Promise(res => {
      manager.once("preload:done", res);
    });
    manager.init({
      cMapPacked: true,
      preload: { commonCMaps: true, concurrency: 3 },
      fetcher: createFakeFetcher(responses),
    });
    const result = await done;
    expect(result.completed).toBe(COMMON_CMAP_NAMES.length);
    expect(result.failed).toBe(0);
  });

  it("exposes legacy-compatible CMap/standard-font fetchers", async function () {
    const manager = FontManager.getInstance().init({
      cMapPacked: true,
      fetcher: createFakeFetcher({
        "GBK-EUC-H": bytes("legacy-cmap"),
        "Helvetica.afm": bytes("legacy-font"),
      }),
    });
    const fetchCMap = createLegacyCMapFetcher(manager);
    const cmap = await fetchCMap("GBK-EUC-H");
    expect(cmap.isCompressed).toBeTrue();
    expect(new TextDecoder().decode(cmap.cMapData)).toBe("legacy-cmap");

    const fetchFont = createLegacyStandardFontFetcher(manager);
    const font = await fetchFont("Helvetica");
    expect(new TextDecoder().decode(font)).toBe("legacy-font");
  });

  it("adapts a DOMBinaryDataFactory-like object", async function () {
    const factory = {
      async fetch({ kind, filename }) {
        if (kind === "cMapUrl" && filename === "GBK-EUC-H.bcmap") {
          return bytes("factory-cmap");
        }
        throw new Error(`unexpected ${kind}/${filename}`);
      },
    };
    const manager = FontManager.getInstance().init({
      cMapPacked: true,
      fetcher: createBinaryFetcherFromFactory(factory),
    });
    const data = await manager.loadCMap("GBK-EUC-H");
    expect(new TextDecoder().decode(data.cMapData)).toBe("factory-cmap");
  });
});

describe("FontManager/business integration (worker bridge)", function () {
  let bridge;

  beforeAll(async function () {
    // eslint-disable-next-line no-unsanitized/method
    bridge = await import(
      pathToFileURL(resolve(__dirname, "../../src/core/font_manager_bridge.js"))
        .href
    );
  });

  afterEach(function () {
    bridge.resetFontManager();
  });

  it("routes CMap loads through FontManager and caches them", async function () {
    let fetches = 0;
    const manager = bridge.getFontManagerForEvaluator({
      useWorkerFetch: true,
      cMapUrl: "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "standard_fonts/",
      fetchBinaryData: async url => {
        fetches++;
        return bytes(`data:${url}`);
      },
    });
    const first = await manager.loadCMap("GBK-EUC-H");
    const second = await manager.loadCMap("GBK-EUC-H");
    expect(first).toBe(second);
    expect(fetches).toBe(1);
    expect(first.isCompressed).toBeTrue();
    // The cache is actively used: one entry, one hit after the second load.
    const stats = manager.getCacheStats();
    expect(stats.entryCount).toBe(1);
    expect(stats.totalHits).toBeGreaterThan(0);
  });

  it("forwards lifecycle events through a handler.send-like object", async function () {
    const sent = [];
    const handler = {
      send(name, data) {
        sent.push([name, data]);
      },
    };
    const manager = bridge.getFontManagerForEvaluator({
      useWorkerFetch: true,
      cMapUrl: "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "standard_fonts/",
      handler,
      fetchBinaryData: async () => bytes("cmap"),
    });
    await manager.loadCMap("ETen-B5-H");
    const eventNames = sent.map(([n]) => n);
    expect(eventNames).toContain("FontManagerEvent");
    const done = sent.find(([, d]) => d.eventName === "resource:load:done");
    expect(done).toBeTruthy();
    expect(done[1].payload.name).toBe("ETen-B5-H");
  });
});

describe("FontManager/business integration (main-thread client)", function () {
  let client;

  beforeAll(async function () {
    // eslint-disable-next-line no-unsanitized/method
    client = await import(
      pathToFileURL(
        resolve(__dirname, "../../src/display/font_manager_client.js")
      ).href
    );
  });

  it("re-dispatches worker events on the main-thread event bus", function () {
    const manager = client.getMainThreadFontManager();
    const received = [];
    const unsubscribe = manager.on("resource:load:done", p => received.push(p));
    client.dispatchWorkerEvent({
      eventName: "resource:load:done",
      payload: {
        kind: "cmap",
        name: "UniJIS-UCS2-H",
        durationMs: 5,
        size: 42,
        fromCache: true,
      },
    });
    expect(received.length).toBe(1);
    expect(received[0].name).toBe("UniJIS-UCS2-H");
    expect(received[0].fromCache).toBeTrue();
    unsubscribe();
  });
});
