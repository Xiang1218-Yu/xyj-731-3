/* Copyright 2026 Mozilla Foundation
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
 * FontManager（字体统一管理中心）回归测试。
 *
 * 覆盖范围（与重构要求一一对应）：
 * 1. `FontEventBus`：统一事件总线的订阅/退订/分发；
 * 2. `LruCache`：字体加载缓存机制（含 LRU 逐出）；
 * 3. `AsyncCMapLoader`：CMap 异步按需加载、并发去重、预加载策略；
 * 4. `FontFallbackChain`：智能字体回退链（默认链行为与历史实现一致）；
 * 5. `FontManager`：单例门面、缓存统计与清理、回退决策事件。
 */

import {
  AsyncCMapLoader,
  COMMON_BUILT_IN_CMAPS,
  FontEventBus,
  FontFallbackChain,
  FontManager,
  LruCache,
} from "../../src/core/font_manager/index.js";
import { PartialEvaluator } from "../../src/core/evaluator.js";

/** 构造一个假的内置 CMap 数据对象。 */
function fakeCMapData(tag = "data") {
  return {
    cMapData: new Uint8Array([...tag].map(ch => ch.charCodeAt(0))),
    isCompressed: true,
  };
}

describe("font_manager", function () {
  describe("FontEventBus", function () {
    let bus;

    beforeEach(function () {
      bus = new FontEventBus();
    });

    it("订阅后能收到事件载荷", function () {
      const received = [];
      bus.on("cmap:load:success", payload => received.push(payload));

      bus.emit("cmap:load:success", { name: "UniGB-UCS2-H", fromCache: false });

      expect(received.length).toBe(1);
      expect(received[0].name).toBe("UniGB-UCS2-H");
      expect(received[0].fromCache).toBe(false);
    });

    it("不同事件之间互不分发", function () {
      const received = [];
      bus.on("font:error", payload => received.push(payload));

      bus.emit("cmap:load:start", { name: "X" });

      expect(received.length).toBe(0);
    });

    it("off 与 on 返回的解绑函数都能退订", function () {
      const received = [];
      const listener = payload => received.push(payload);

      bus.on("font:fallback", listener);
      bus.off("font:fallback", listener);
      bus.emit("font:fallback", {
        fontName: "F1",
        reason: "missing-dict",
        strategy: "default-dict",
        terminal: false,
      });
      expect(received.length).toBe(0);

      const unbind = bus.on("font:fallback", listener);
      unbind();
      bus.emit("font:fallback", {
        fontName: "F1",
        reason: "missing-dict",
        strategy: "default-dict",
        terminal: false,
      });
      expect(received.length).toBe(0);
    });

    it("同一监听器不会被重复注册", function () {
      let count = 0;
      const listener = () => count++;

      bus.on("cmap:load:start", listener);
      bus.on("cmap:load:start", listener);
      bus.emit("cmap:load:start", { name: "X" });

      expect(count).toBe(1);
    });

    it("监听器抛错不影响其他监听器与调用方", function () {
      const received = [];
      bus.on("cmap:load:start", () => {
        throw new Error("listener bug");
      });
      bus.on("cmap:load:start", payload => received.push(payload));

      expect(() => bus.emit("cmap:load:start", { name: "X" })).not.toThrow();
      expect(received.length).toBe(1);
    });

    it("clear 移除全部监听器", function () {
      let count = 0;
      bus.on("font:error", () => count++);
      bus.on("cmap:load:start", () => count++);

      bus.clear();
      bus.emit("font:error", { fontName: null, message: "m" });
      bus.emit("cmap:load:start", { name: "X" });

      expect(count).toBe(0);
      expect(bus.hasListeners("font:error")).toBe(false);
    });
  });

  describe("LruCache", function () {
    it("基本的存取与删除", function () {
      const cache = new LruCache({ maxSize: 3 });
      cache.set("a", 1);
      cache.set("b", 2);

      expect(cache.get("a")).toBe(1);
      expect(cache.get("missing")).toBeUndefined();
      expect(cache.has("b")).toBe(true);
      expect(cache.size).toBe(2);

      expect(cache.delete("a")).toBe(true);
      expect(cache.has("a")).toBe(false);
    });

    it("超出容量时逐出最久未使用项并触发 onEvict", function () {
      const evicted = [];
      const cache = new LruCache({
        maxSize: 2,
        onEvict: key => evicted.push(key),
      });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3); // 逐出 "a"

      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(true);
      expect(cache.has("c")).toBe(true);
      expect(evicted).toEqual(["a"]);
    });

    it("get 命中会刷新 LRU 顺序", function () {
      const cache = new LruCache({ maxSize: 2 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.get("a"); // "a" 变为最新，"b" 成为最旧
      cache.set("c", 3); // 逐出 "b"

      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(false);
      expect(cache.has("c")).toBe(true);
    });

    it("clear 清空但不触发 onEvict", function () {
      const evicted = [];
      const cache = new LruCache({
        maxSize: 2,
        onEvict: key => evicted.push(key),
      });
      cache.set("a", 1);
      cache.clear();

      expect(cache.size).toBe(0);
      expect(evicted).toEqual([]);
    });
  });

  describe("AsyncCMapLoader", function () {
    let bus, cache, loader;

    beforeEach(function () {
      bus = new FontEventBus();
      cache = new LruCache({ maxSize: 8 });
      loader = new AsyncCMapLoader({ cache, events: bus });
    });

    it("按需异步加载并缓存，重复加载不再调用取数器", async function () {
      let fetchCount = 0;
      const fetcher = async name => {
        fetchCount++;
        return fakeCMapData(name);
      };

      const first = await loader.load("UniGB-UCS2-H", fetcher);
      const second = await loader.load("UniGB-UCS2-H", fetcher);

      expect(fetchCount).toBe(1);
      expect(second).toBe(first);
      expect(loader.isLoaded("UniGB-UCS2-H")).toBe(true);
      expect(first.isCompressed).toBe(true);
    });

    it("并发加载同一个 CMap 只发起一次取数（并发去重）", async function () {
      let fetchCount = 0;
      const fetcher = async name => {
        fetchCount++;
        await new Promise(resolve => {
          setTimeout(resolve, 10);
        });
        return fakeCMapData(name);
      };

      const [a, b, c] = await Promise.all([
        loader.load("UniJIS-UCS2-H", fetcher),
        loader.load("UniJIS-UCS2-H", fetcher),
        loader.load("UniJIS-UCS2-H", fetcher),
      ]);

      expect(fetchCount).toBe(1);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it("加载过程广播 start/success 事件，缓存命中标记 fromCache", async function () {
      const events = [];
      bus.on("cmap:load:start", payload =>
        events.push(`start:${payload.name}`)
      );
      bus.on("cmap:load:success", payload =>
        events.push(`success:${payload.name}:${payload.fromCache}`)
      );
      const fetcher = async name => fakeCMapData(name);

      await loader.load("UniKS-UCS2-H", fetcher);
      await loader.load("UniKS-UCS2-H", fetcher);

      expect(events).toEqual([
        "start:UniKS-UCS2-H",
        "success:UniKS-UCS2-H:false",
        "success:UniKS-UCS2-H:true",
      ]);
    });

    it("加载失败广播 error 事件、向上抛出且不写缓存（可重试）", async function () {
      const errors = [];
      bus.on("cmap:load:error", payload => errors.push(payload));

      let fetchCount = 0;
      const fetcher = async () => {
        fetchCount++;
        throw new Error("network down");
      };

      await expectAsync(loader.load("Broken-H", fetcher)).toBeRejected();
      expect(errors.length).toBe(1);
      expect(errors[0].name).toBe("Broken-H");
      expect(errors[0].message).toBe("network down");
      expect(loader.isLoaded("Broken-H")).toBe(false);

      // 失败未缓存：修复取数器后重试成功。
      const goodFetcher = async name => fakeCMapData(name);
      const data = await loader.load("Broken-H", goodFetcher);
      expect(data.isCompressed).toBe(true);
      expect(fetchCount).toBe(1);
    });

    it("未注册取数器时抛出明确错误", async function () {
      await expectAsync(loader.load("X")).toBeRejectedWithError(
        /No CMap fetcher registered/
      );
    });

    it("registerFetcher 注册的默认取数器可被 load 复用", async function () {
      loader.registerFetcher(async name => fakeCMapData(name));
      const data = await loader.load("UniCNS-UCS2-H");
      expect(data.cMapData instanceof Uint8Array).toBe(true);
    });

    it('预加载策略 "none" 不做任何取数', async function () {
      let fetchCount = 0;
      const fetcher = async name => {
        fetchCount++;
        return fakeCMapData(name);
      };

      await loader.preload({ strategy: "none" }, fetcher);
      expect(fetchCount).toBe(0);
    });

    it('预加载策略 "common" 加载全部常用 CMap 并广播完成事件', async function () {
      const fetched = [];
      let donePayload = null;
      bus.on("cmap:preload:done", payload => (donePayload = payload));
      const fetcher = async name => {
        fetched.push(name);
        return fakeCMapData(name);
      };

      await loader.preload({ strategy: "common" }, fetcher);

      expect(fetched).toEqual([...COMMON_BUILT_IN_CMAPS]);
      expect(donePayload.succeeded).toEqual([...COMMON_BUILT_IN_CMAPS]);
      expect(donePayload.failed).toEqual([]);
      // 预加载结果进入缓存，后续按需加载直接命中。
      expect(loader.isLoaded(COMMON_BUILT_IN_CMAPS[0])).toBe(true);
    });

    it('预加载策略 "custom" 只加载指定名单，且相同配置幂等', async function () {
      const fetched = [];
      const fetcher = async name => {
        fetched.push(name);
        return fakeCMapData(name);
      };
      const config = { strategy: "custom", names: ["A-H", "B-V"] };

      await loader.preload(config, fetcher);
      await loader.preload(config, fetcher); // 幂等，不重复取数

      expect(fetched).toEqual(["A-H", "B-V"]);
    });

    it("预加载中的失败不会抛出，仅记录在 failed 名单", async function () {
      let donePayload = null;
      bus.on("cmap:preload:done", payload => (donePayload = payload));
      const fetcher = async name => {
        if (name === "bad") {
          throw new Error("boom");
        }
        return fakeCMapData(name);
      };

      await loader.preload(
        { strategy: "custom", names: ["good", "bad"] },
        fetcher
      );

      expect(donePayload.succeeded).toEqual(["good"]);
      expect(donePayload.failed).toEqual(["bad"]);
    });
  });

  describe("FontFallbackChain", function () {
    const missingDictContext = {
      fontName: "F1",
      baseFontName: null,
      reason: "missing-dict",
      bold: false,
      italic: false,
      monospace: false,
      serif: false,
    };
    const loadFailedContext = { ...missingDictContext, reason: "load-failed" };

    it("默认链：字典缺失 → 默认字典回退（与历史行为一致）", function () {
      const chain = new FontFallbackChain();
      const result = chain.resolve(missingDictContext);

      expect(result.strategy).toBe("default-dict");
      expect(result.useDefaultDict).toBe(true);
      expect(result.isTerminalError).toBe(false);
    });

    it("默认链：转换失败 → 终态 ErrorFont（与历史行为一致）", function () {
      const chain = new FontFallbackChain();
      const result = chain.resolve(loadFailedContext);

      expect(result.strategy).toBe("terminal-error-font");
      expect(result.useDefaultDict).toBe(false);
      expect(result.isTerminalError).toBe(true);
    });

    it("自定义处理器优先于终端处理器生效（智能扩展点）", function () {
      const chain = new FontFallbackChain();
      chain.addHandler({
        name: "system-serif",
        handle(context) {
          if (context.serif && context.reason === "load-failed") {
            return {
              strategy: "system-serif",
              useDefaultDict: false,
              isTerminalError: false,
            };
          }
          return null;
        },
      });

      const result = chain.resolve({ ...loadFailedContext, serif: true });
      expect(result.strategy).toBe("system-serif");

      // 不匹配的上下文仍回落到终端处理器。
      const fallback = chain.resolve(loadFailedContext);
      expect(fallback.strategy).toBe("terminal-error-font");

      expect(chain.handlerNames).toEqual([
        "default-dict",
        "system-serif",
        "terminal-error-font",
      ]);
    });

    it("终端处理器不允许被移除", function () {
      const chain = new FontFallbackChain();

      expect(chain.removeHandler("terminal-error-font")).toBe(false);
      expect(chain.removeHandler("default-dict")).toBe(true);
      expect(chain.handlerNames).toEqual(["terminal-error-font"]);
    });

    it("缺少终态处理器的自定义链仍有保守兜底", function () {
      const chain = new FontFallbackChain([]);
      const result = chain.resolve(missingDictContext);

      expect(result.isTerminalError).toBe(true);
      expect(result.strategy).toBe("implicit-terminal");
    });
  });

  describe("FontManager", function () {
    beforeEach(function () {
      FontManager.resetInstance();
    });

    afterEach(function () {
      FontManager.resetInstance();
    });

    it("getInstance 返回全局唯一实例（单例）", function () {
      const a = FontManager.getInstance();
      const b = FontManager.getInstance();

      expect(a).toBe(b);
      expect(a.events instanceof FontEventBus).toBe(true);
      expect(a.fallbackChain instanceof FontFallbackChain).toBe(true);
    });

    it("resetInstance 后得到新实例", function () {
      const a = FontManager.getInstance();
      FontManager.resetInstance();
      const b = FontManager.getInstance();

      expect(a).not.toBe(b);
    });

    it("loadBuiltInCMap 带缓存与去重，cacheStats 反映占用", async function () {
      const manager = FontManager.getInstance();
      let fetchCount = 0;
      const fetcher = async name => {
        fetchCount++;
        return fakeCMapData(name);
      };

      await manager.loadBuiltInCMap("UniGB-UCS2-H", fetcher);
      await manager.loadBuiltInCMap("UniGB-UCS2-H", fetcher);

      expect(fetchCount).toBe(1);
      expect(manager.isBuiltInCMapLoaded("UniGB-UCS2-H")).toBe(true);
      expect(manager.cacheStats().entries["builtin-cmap"]).toBe(1);

      manager.clearCaches();
      expect(manager.cacheStats().entries["builtin-cmap"]).toBe(0);
      expect(manager.isBuiltInCMapLoaded("UniGB-UCS2-H")).toBe(false);
    });

    it("preloadCMaps 后台预加载且幂等", async function () {
      const manager = FontManager.getInstance();
      const fetched = [];
      const fetcher = async name => {
        fetched.push(name);
        return fakeCMapData(name);
      };

      await manager.preloadCMaps(
        { strategy: "custom", names: ["P-H"] },
        fetcher
      );
      await manager.preloadCMaps(null, fetcher); // 沿用配置，幂等

      expect(fetched).toEqual(["P-H"]);
      expect(manager.isBuiltInCMapLoaded("P-H")).toBe(true);
    });

    it("loadStandardFontData 缓存成功结果、不缓存失败结果", async function () {
      const manager = FontManager.getInstance();
      let fetchCount = 0;
      const failingFetcher = async () => {
        fetchCount++;
        return null;
      };

      expect(
        await manager.loadStandardFontData("F", failingFetcher)
      ).toBeNull();
      expect(
        await manager.loadStandardFontData("F", failingFetcher)
      ).toBeNull();
      expect(fetchCount).toBe(2); // null 不缓存，每次都重新取
      expect(manager.cacheStats().entries["standard-font"]).toBe(0);

      const goodFetcher = async () => new Uint8Array([1, 2, 3]);
      const data = await manager.loadStandardFontData("F", goodFetcher);
      expect(data instanceof Uint8Array).toBe(true);
      expect(manager.cacheStats().entries["standard-font"]).toBe(1);
    });

    it("loadStandardFontData 并发去重", async function () {
      const manager = FontManager.getInstance();
      let fetchCount = 0;
      const fetcher = async () => {
        fetchCount++;
        await new Promise(resolve => {
          setTimeout(resolve, 10);
        });
        return new Uint8Array([9]);
      };

      const [a, b] = await Promise.all([
        manager.loadStandardFontData("G", fetcher),
        manager.loadStandardFontData("G", fetcher),
      ]);

      expect(fetchCount).toBe(1);
      expect(a).toBe(b);
    });

    it("resolveFontFallback 返回决策并广播 font:fallback 事件", function () {
      const manager = FontManager.getInstance();
      const events = [];
      manager.events.on("font:fallback", payload => events.push(payload));

      const result = manager.resolveFontFallback({
        fontName: "F9",
        baseFontName: null,
        reason: "missing-dict",
        bold: false,
        italic: false,
        monospace: false,
        serif: false,
      });

      expect(result.strategy).toBe("default-dict");
      expect(result.useDefaultDict).toBe(true);
      expect(events.length).toBe(1);
      expect(events[0].fontName).toBe("F9");
      expect(events[0].reason).toBe("missing-dict");
      expect(events[0].strategy).toBe("default-dict");
      expect(events[0].terminal).toBe(false);
    });

    it("fallbackChain 暴露扩展点，自定义策略即刻生效", function () {
      const manager = FontManager.getInstance();
      manager.fallbackChain.addHandler({
        name: "always-default-dict",
        handle() {
          return {
            strategy: "always-default-dict",
            useDefaultDict: true,
            isTerminalError: false,
          };
        },
      });

      const result = manager.resolveFontFallback({
        fontName: null,
        baseFontName: null,
        reason: "load-failed",
        bold: false,
        italic: false,
        monospace: false,
        serif: false,
      });

      expect(result.strategy).toBe("always-default-dict");
      expect(result.isTerminalError).toBe(false);
    });

    it("primeBuiltInCMap 预填充后 load 直接命中，不触发取数", async function () {
      const manager = FontManager.getInstance();
      let fetchCount = 0;
      const fetcher = async name => {
        fetchCount++;
        return fakeCMapData(name);
      };

      manager.primeBuiltInCMap("Primed-H", fakeCMapData("seed"));
      const data = await manager.loadBuiltInCMap("Primed-H", fetcher);

      expect(fetchCount).toBe(0);
      expect(String.fromCharCode(...data.cMapData)).toBe("seed");
      expect(manager.cacheStats().entries["builtin-cmap"]).toBe(1);

      // 重复 prime 同名数据为无操作（先到先得）。
      manager.primeBuiltInCMap("Primed-H", fakeCMapData("other"));
      const again = await manager.loadBuiltInCMap("Primed-H", fetcher);
      expect(String.fromCharCode(...again.cMapData)).toBe("seed");
    });

    it("primeStandardFontData 预填充后 load 直接命中，不触发取数", async function () {
      const manager = FontManager.getInstance();
      let fetchCount = 0;

      manager.primeStandardFontData("PrimedFont", new Uint8Array([7, 7]));
      const data = await manager.loadStandardFontData(
        "PrimedFont",
        async () => {
          fetchCount++;
          return new Uint8Array([9]);
        }
      );

      expect(fetchCount).toBe(0);
      expect([...data]).toEqual([7, 7]);
    });
  });

  describe("PartialEvaluator 集成（FontManager 为唯一缓存源）", function () {
    beforeEach(function () {
      FontManager.resetInstance();
    });

    afterEach(function () {
      FontManager.resetInstance();
    });

    /** 构造一个最小可用的 PartialEvaluator。 */
    function createEvaluator({
      handler = null,
      builtInCMapCache = new Map(),
      standardFontDataCache = new Map(),
      options = {},
    } = {}) {
      return new PartialEvaluator({
        xref: null,
        handler,
        pageIndex: 0,
        idFactory: null,
        fontCache: null,
        builtInCMapCache,
        standardFontDataCache,
        globalColorSpaceCache: null,
        globalImageCache: null,
        systemFontCache: null,
        options: {
          useWorkerFetch: false,
          useSystemFonts: false,
          cMapPacked: true,
          cMapPreload: null,
          cMapUrl: null,
          standardFontDataUrl: null,
          ...options,
        },
      });
    }

    it("fetchBuiltInCMap 经 FontManager 加载并缓存，不再回写旧缓存", async function () {
      let fetchCount = 0;
      const handler = {
        sendWithPromise: async (id, { filename }) => {
          fetchCount++;
          expect(id).toBe("FetchBinaryData");
          return new Uint8Array([...filename].map(ch => ch.charCodeAt(0)));
        },
      };
      const builtInCMapCache = new Map();
      const evaluator = createEvaluator({ handler, builtInCMapCache });

      const first = await evaluator.fetchBuiltInCMap("TestCMap-H");
      const second = await evaluator.fetchBuiltInCMap("TestCMap-H");

      expect(fetchCount).toBe(1); // 第二次命中 FontManager 缓存
      expect(first).toBe(second); // 缓存语义一致：同一数据对象
      expect(first.isCompressed).toBe(true);
      // 旧缓存不再被读写（无双写、无旁路）。
      expect(builtInCMapCache.size).toBe(0);
      expect("builtInCMapCache" in evaluator).toBe(false);
    });

    it("构造前预填充的 builtInCMapCache 被迁入 FontManager（兼容旧调用方）", async function () {
      const seed = fakeCMapData("seeded");
      const builtInCMapCache = new Map([["Seeded-H", seed]]);
      const handler = {
        sendWithPromise: async () => {
          throw new Error("不应发生真实抓取");
        },
      };
      const evaluator = createEvaluator({ handler, builtInCMapCache });

      const data = await evaluator.fetchBuiltInCMap("Seeded-H");
      expect(data).toBe(seed);
    });

    it("fetchStandardFontData 经 FontManager 缓存，失败返回 null 且不缓存", async function () {
      let fetchCount = 0;
      const handler = {
        sendWithPromise: async () => {
          fetchCount++;
          if (fetchCount === 1) {
            throw new Error("network down");
          }
          return new Uint8Array([1, 2, 3]);
        },
      };
      const standardFontDataCache = new Map();
      const evaluator = createEvaluator({ handler, standardFontDataCache });

      // 第一次失败：返回 null（语义与历史实现一致），且不写任何缓存。
      expect(await evaluator.fetchStandardFontData("Helvetica")).toBeNull();
      expect(standardFontDataCache.size).toBe(0);

      // 第二次成功：返回 Stream；第三次命中 FontManager 缓存，不再抓取。
      const stream = await evaluator.fetchStandardFontData("Helvetica");
      expect(stream).not.toBeNull();
      await evaluator.fetchStandardFontData("Helvetica");
      expect(fetchCount).toBe(2);
      expect(standardFontDataCache.size).toBe(0);
    });
  });
});
