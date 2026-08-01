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
 * Regression test suite for the FontManager subsystem.
 *
 * Run with:  node --test  (targeting the *compiled* JS under ./dist)
 *
 * These tests are the preserved regression flow required by the refactor. They
 * cover: the singleton, async/preload CMap loading, the smart fallback chain,
 * cache hits & eviction, the typed event bus, single-flight de-duplication, and
 * API-compatibility with the existing `factory.fetch({ kind, filename })`
 * contract.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  CMapLoader,
  FallbackResolver,
  FontCache,
  FontEventBus,
  FontManager,
} from "../dist/index.js";

/**
 * A fake binary data factory implementing the exact contract the real
 * DOM/Node factories expose. It records every call so we can assert
 * de-duplication and URL/kind correctness.
 */
class FakeBinaryDataFactory {
  constructor(bytesByFilename = {}) {
    this.bytesByFilename = bytesByFilename;
    this.calls = [];
  }

  async fetch({ kind, filename }) {
    this.calls.push({ kind, filename });
    const bytes = this.bytesByFilename[filename];
    if (!bytes) {
      throw new Error(`Unable to load ${kind} data at: ${filename}`);
    }
    return bytes;
  }
}

describe("FontManager singleton", () => {
  beforeEach(() => {
    FontManager.resetInstanceForTesting();
  });

  it("returns the same instance across calls", () => {
    const a = FontManager.getInstance();
    const b = FontManager.getInstance();
    assert.equal(a, b);
  });

  it("starts unconfigured and becomes configured", async () => {
    const fm = FontManager.getInstance();
    assert.equal(fm.isConfigured, false);
    await fm.configure({ cMapUrl: "/cmaps/", cMapPacked: true });
    assert.equal(fm.isConfigured, true);
  });
});

describe("FontEventBus", () => {
  it("dispatches typed payloads to listeners", () => {
    const bus = new FontEventBus();
    const seen = [];
    bus.on("cmapLoaded", payload => seen.push(payload));
    bus.dispatch("cmapLoaded", { name: "X", fromCache: false });
    assert.deepEqual(seen, [{ name: "X", fromCache: false }]);
  });

  it("honours { once } and removes after first dispatch", () => {
    const bus = new FontEventBus();
    let count = 0;
    bus.on("cmapLoaded", () => count++, { once: true });
    bus.dispatch("cmapLoaded", { name: "A", fromCache: false });
    bus.dispatch("cmapLoaded", { name: "B", fromCache: false });
    assert.equal(count, 1);
  });

  it("removes listeners via off()", () => {
    const bus = new FontEventBus();
    let count = 0;
    const fn = () => count++;
    bus.on("cmapError", fn);
    bus.off("cmapError", fn);
    bus.dispatch("cmapError", { name: "A", message: "x" });
    assert.equal(count, 0);
  });

  it("auto-removes on AbortSignal", () => {
    const bus = new FontEventBus();
    const ac = new AbortController();
    let count = 0;
    bus.on("cmapLoaded", () => count++, { signal: ac.signal });
    bus.dispatch("cmapLoaded", { name: "A", fromCache: false });
    ac.abort();
    bus.dispatch("cmapLoaded", { name: "B", fromCache: false });
    assert.equal(count, 1);
    assert.equal(bus.listenerCount("cmapLoaded"), 0);
  });
});

describe("FontCache (LRU + namespaces)", () => {
  it("hits and misses are tracked", () => {
    const cache = new FontCache(4);
    assert.equal(cache.get("fontData", "a"), undefined);
    cache.set("fontData", "a", new Uint8Array([1]));
    assert.deepEqual(cache.get("fontData", "a"), new Uint8Array([1]));
    assert.equal(cache.stats.hits, 1);
    assert.equal(cache.stats.misses, 1);
  });

  it("namespaces do not collide", () => {
    const cache = new FontCache(4);
    cache.set("fontData", "k", new Uint8Array([9]));
    cache.set("fallback", "k", { requested: "k", entries: [] });
    assert.deepEqual(cache.get("fontData", "k"), new Uint8Array([9]));
    assert.deepEqual(cache.get("fallback", "k"), { requested: "k", entries: [] });
  });

  it("evicts least-recently-used beyond capacity", () => {
    const evicted = [];
    const cache = new FontCache(2);
    const onEvict = (ns, key) => evicted.push(`${ns}:${key}`);
    cache.set("fontData", "a", new Uint8Array([1]), onEvict);
    cache.set("fontData", "b", new Uint8Array([2]), onEvict);
    // Touch "a" so "b" becomes LRU.
    cache.get("fontData", "a");
    cache.set("fontData", "c", new Uint8Array([3]), onEvict);
    assert.deepEqual(evicted, ["fontData:b"]);
    assert.equal(cache.has("fontData", "b"), false);
    assert.equal(cache.has("fontData", "a"), true);
  });

  it("rejects invalid capacity", () => {
    assert.throws(() => new FontCache(0), RangeError);
    assert.throws(() => new FontCache(1.5), RangeError);
  });
});

describe("CMapLoader (async, dedup, preload)", () => {
  const bytes = new Uint8Array([1, 2, 3]);

  function makeLoader(strategy, preloadNames = []) {
    const cache = new FontCache(16);
    const eventBus = new FontEventBus();
    const factory = new FakeBinaryDataFactory({ "Foo.bcmap": bytes });
    const loader = new CMapLoader(
      {
        cMapUrl: "/cmaps/",
        cMapPacked: true,
        preloadStrategy: strategy,
        preloadNames,
      },
      { cache, eventBus, factory }
    );
    return { loader, factory, eventBus, cache };
  }

  it("loads packed cmap and caches it", async () => {
    const { loader, factory } = makeLoader("lazy");
    const first = await loader.load("Foo");
    assert.deepEqual(first.data, bytes);
    assert.equal(first.packed, true);
    // Second load is served from cache: no extra fetch.
    await loader.load("Foo");
    assert.equal(factory.calls.length, 1);
    assert.deepEqual(factory.calls[0], { kind: "cMapUrl", filename: "Foo.bcmap" });
  });

  it("de-duplicates concurrent loads (single-flight)", async () => {
    const { loader, factory } = makeLoader("lazy");
    const [a, b] = await Promise.all([loader.load("Foo"), loader.load("Foo")]);
    assert.deepEqual(a.data, bytes);
    assert.deepEqual(b.data, bytes);
    assert.equal(factory.calls.length, 1);
  });

  it("eager strategy preloads configured names", async () => {
    const { loader, factory } = makeLoader("eager", ["Foo"]);
    const loaded = await loader.runPreloadStrategy();
    assert.deepEqual(loaded, ["Foo"]);
    assert.equal(factory.calls.length, 1);
  });

  it("lazy/manual strategies do not preload", async () => {
    const { loader, factory } = makeLoader("manual", ["Foo"]);
    const loaded = await loader.runPreloadStrategy();
    assert.deepEqual(loaded, []);
    assert.equal(factory.calls.length, 0);
  });

  it("preload swallows per-name failures", async () => {
    const { loader } = makeLoader("manual");
    const loaded = await loader.preload(["Missing"]);
    assert.deepEqual(loaded, []);
  });

  it("emits cmapError and throws when factory is null", async () => {
    const cache = new FontCache(4);
    const eventBus = new FontEventBus();
    const errors = [];
    eventBus.on("cmapError", e => errors.push(e));
    const loader = new CMapLoader(
      { cMapUrl: "/cmaps/", cMapPacked: true, preloadStrategy: "lazy", preloadNames: [] },
      { cache, eventBus, factory: null }
    );
    await assert.rejects(() => loader.load("Foo"));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, "Foo");
  });
});

describe("FallbackResolver (smart chain)", () => {
  const resolver = new FallbackResolver();

  function desc(overrides) {
    return {
      baseFontName: "Helvetica",
      type: "Type1",
      embedded: false,
      isSerif: false,
      isMonospace: false,
      isItalic: false,
      isBold: false,
      ...overrides,
    };
  }

  it("always terminates in a generic family", () => {
    const chain = resolver.resolve(desc({ baseFontName: "TotallyUnknownFont" }));
    const last = chain.entries[chain.entries.length - 1];
    assert.equal(last.source, "generic");
    assert.ok(["serif", "sans-serif", "monospace", "cursive", "fantasy"].includes(last.family));
  });

  it("prefers embedded program first", () => {
    const chain = resolver.resolve(desc({ baseFontName: "MyEmbedded", embedded: true }));
    assert.equal(chain.entries[0].source, "embedded");
    assert.equal(chain.entries[0].family, "MyEmbedded");
  });

  it("applies alias substitution (ArialMT -> Arial -> Helvetica)", () => {
    const chain = resolver.resolve(desc({ baseFontName: "ArialMT" }));
    const sources = chain.entries.map(e => e.source);
    assert.ok(sources.includes("substitution"));
    assert.ok(sources.includes("standard"));
    // Standard maps Arial -> Helvetica with a data file.
    const standard = chain.entries.find(e => e.source === "standard");
    assert.equal(standard.family, "Helvetica");
    assert.equal(standard.standardFontFile, "FoxitSans.pfb");
  });

  it("strips subset prefix for TrueType/Type1", () => {
    const chain = resolver.resolve(
      desc({ baseFontName: "ABCDEF+Times", type: "TrueType" })
    );
    assert.equal(chain.requested, "Times");
  });

  it("classifies monospace and serif generically", () => {
    const mono = resolver.resolve(desc({ baseFontName: "SomeMono", isMonospace: true }));
    assert.equal(mono.entries.at(-1).family, "monospace");
    const serif = resolver.resolve(desc({ baseFontName: "SomeThing", isSerif: true }));
    assert.equal(serif.entries.at(-1).family, "serif");
  });
});

describe("FontManager integration & API compatibility", () => {
  beforeEach(() => FontManager.resetInstanceForTesting());

  it("loadCMap flows through cache and emits events", async () => {
    const fm = FontManager.getInstance();
    const bytes = new Uint8Array([7]);
    const factory = new FakeBinaryDataFactory({ "Adobe.bcmap": bytes });
    const events = [];
    fm.on("cmapLoaded", e => events.push(e));
    await fm.configure({
      cMapUrl: "/cmaps/",
      cMapPacked: true,
      binaryDataFactory: factory,
    });
    const cmap = await fm.loadCMap("Adobe");
    assert.deepEqual(cmap.data, bytes);
    await fm.loadCMap("Adobe"); // cache hit
    assert.equal(factory.calls.length, 1);
    assert.equal(events.length, 2);
    assert.equal(events[0].fromCache, false);
    assert.equal(events[1].fromCache, true);
  });

  it("eager preload warms the cache during configure()", async () => {
    const fm = FontManager.getInstance();
    const factory = new FakeBinaryDataFactory({ "Warm.bcmap": new Uint8Array([1]) });
    await fm.configure({
      cMapUrl: "/cmaps/",
      cMapPacked: true,
      cMapPreloadStrategy: "eager",
      cMapPreloadNames: ["Warm"],
      binaryDataFactory: factory,
    });
    // Already fetched during configure; loadCMap is now a pure cache hit.
    assert.equal(factory.calls.length, 1);
    await fm.loadCMap("Warm");
    assert.equal(factory.calls.length, 1);
  });

  it("loadFontData caches standard font programs", async () => {
    const fm = FontManager.getInstance();
    const factory = new FakeBinaryDataFactory({ "FoxitSans.pfb": new Uint8Array([2]) });
    await fm.configure({
      standardFontDataUrl: "/fonts/",
      binaryDataFactory: factory,
    });
    await fm.loadFontData("FoxitSans.pfb");
    await fm.loadFontData("FoxitSans.pfb");
    assert.equal(factory.calls.length, 1);
    assert.equal(factory.calls[0].kind, "standardFontDataUrl");
  });

  it("resolveFallback is cached", async () => {
    const fm = FontManager.getInstance();
    await fm.configure({});
    const d = {
      baseFontName: "ArialMT",
      type: "TrueType",
      embedded: false,
      isSerif: false,
      isMonospace: false,
      isItalic: false,
      isBold: false,
    };
    const a = fm.resolveFallback(d);
    const b = fm.resolveFallback(d);
    // Same object returned from cache on second call.
    assert.equal(a, b);
  });

  it("throws clearly when unconfigured factory is used", async () => {
    const fm = FontManager.getInstance();
    await fm.configure({ cMapUrl: "/cmaps/" });
    await assert.rejects(() => fm.loadCMap("Foo"), /no binary data factory/);
  });

  it("reset() clears cache, listeners and config", async () => {
    const fm = FontManager.getInstance();
    const factory = new FakeBinaryDataFactory({ "X.bcmap": new Uint8Array([1]) });
    await fm.configure({ cMapUrl: "/c/", cMapPacked: true, binaryDataFactory: factory });
    await fm.loadCMap("X");
    fm.reset();
    assert.equal(fm.isConfigured, false);
    assert.equal(fm.cacheStats.size, 0);
  });
});
