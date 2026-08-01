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

import type {
  BuiltInCMapData,
  BuiltInCMapFetcher,
  CMapPreloadConfig,
} from "./types.js";
import type { FontEventBus } from "./event_bus.js";
import type { LruCache } from "./lru_cache.js";

/**
 * 内置 CMap 异步加载器（单一职责：只负责 CMap 字节的“取、存、预取”）。
 *
 * 相对历史实现（`PartialEvaluator.fetchBuiltInCMap`）的改进：
 * 1. **异步按需加载保持不变**：调用方 `await load(name)` 才取数，
 *    不在文档打开阶段做任何阻塞式预取，不影响首屏渲染；
 * 2. **并发请求去重**：同一 CMap 的多个并发 `load` 共享同一个
 *    in-flight Promise，杜绝重复网络/主线程请求；
 * 3. **LRU 缓存**：加载结果写入进程级 LRU 缓存，跨页面、跨文档复用
 *    （CMap 数据按名静态不可变，天然安全）；
 * 4. **可配置预加载策略**：`none`（默认）/ `common` / `custom`，
 *    预加载在后台进行，调用方无需等待；
 * 5. **事件透明**：加载开始/成功/失败、预加载开始/结束都会经
 *    `FontEventBus` 广播，便于监控与调试。
 *
 * 取数来源（worker 直取或主线程代取）以 `BuiltInCMapFetcher` 形式注入，
 * 本类不做任何 I/O 假设。
 */

/**
 * 常用内置 CMap 名单（`"common"` 预加载策略使用）。
 * 选取覆盖中、日、韩、简/繁体最常用的 UCS-2 编码 CMap。
 */
export const COMMON_BUILT_IN_CMAPS: readonly string[] = [
  "UniGB-UCS2-H",
  "UniGB-UCS2-V",
  "UniCNS-UCS2-H",
  "UniCNS-UCS2-V",
  "UniJIS-UCS2-H",
  "UniJIS-UCS2-V",
  "UniKS-UCS2-H",
  "UniKS-UCS2-V",
];

/** 加载器构造选项。 */
export interface AsyncCMapLoaderOptions {
  /** 进程级 LRU 缓存（由 FontManager 创建并注入）。 */
  readonly cache: LruCache<string, BuiltInCMapData>;
  /** 事件总线（由 FontManager 创建并注入）。 */
  readonly events: FontEventBus;
  /** 初始预加载配置，缺省为 `{ strategy: "none" }`。 */
  readonly preload?: CMapPreloadConfig;
}

export class AsyncCMapLoader {
  readonly #cache: LruCache<string, BuiltInCMapData>;

  readonly #events: FontEventBus;

  /** 已注册的默认取数器（`load` 时也可按调用临时指定）。 */
  #fetcher: BuiltInCMapFetcher | null = null;

  /** in-flight 请求表：同名加载共享同一个 Promise，实现并发去重。 */
  readonly #inFlight = new Map<string, Promise<BuiltInCMapData>>();

  /** 当前预加载配置。 */
  #preloadConfig: CMapPreloadConfig = { strategy: "none" };

  /**
   * 已执行过的预加载指纹（策略 + 名单的序列化结果）。
   * 用于让重复的 `preload` 调用幂等，避免每个 CMap 加载都触发一轮预取。
   */
  #preloadedKey: string | null = null;

  constructor(options: AsyncCMapLoaderOptions) {
    this.#cache = options.cache;
    this.#events = options.events;
    if (options.preload) {
      this.#preloadConfig = options.preload;
    }
  }

  /** 注册默认取数器（后注册者覆盖先注册者）。 */
  registerFetcher(fetcher: BuiltInCMapFetcher): void {
    this.#fetcher = fetcher;
  }

  /** 更新预加载配置；指纹随之失效，下次 `preload` 会按新配置执行。 */
  setPreloadConfig(config: CMapPreloadConfig): void {
    this.#preloadConfig = config;
    this.#preloadedKey = null;
  }

  /** 某个 CMap 是否已加载（命中缓存）。 */
  isLoaded(name: string): boolean {
    return this.#cache.has(name);
  }

  /**
   * 预填充（prime）：把“已有的” CMap 数据直接写入缓存，跳过取数。
   *
   * 用途：兼容历史调用方（如旧版 `PartialEvaluator` 的调用点在构造前
   * 预填充的 `builtInCMapCache`），把外部已加载的数据一次性迁入
   * 统一缓存，保证 FontManager 始终是唯一缓存数据源。
   * 已存在同名缓存时为无操作（外部数据与缓存语义一致，先到先得）。
   */
  prime(name: string, data: BuiltInCMapData): void {
    if (!this.#cache.has(name)) {
      this.#cache.set(name, data);
    }
  }

  /**
   * 异步按需加载一个内置 CMap。
   *
   * 流程：缓存命中 → 直接返回；in-flight 命中 → 共享 Promise；
   * 否则调用取数器抓取，成功后写缓存并广播事件。
   * 失败不会写入缓存（允许调用方重试），但会广播 `cmap:load:error`。
   *
   * @param name CMap 名（如 `"UniGB-UCS2-H"`）。
   * @param fetcher 可选的本次取数器；缺省使用 `registerFetcher` 注册的。
   * @returns CMap 字节数据。
   */
  async load(
    name: string,
    fetcher?: BuiltInCMapFetcher
  ): Promise<BuiltInCMapData> {
    const cached = this.#cache.get(name);
    if (cached) {
      this.#events.emit("cmap:load:success", { name, fromCache: true });
      return cached;
    }
    const pending = this.#inFlight.get(name);
    if (pending) {
      return pending;
    }
    const effectiveFetcher = fetcher ?? this.#fetcher;
    if (!effectiveFetcher) {
      throw new Error(`No CMap fetcher registered, cannot load "${name}".`);
    }

    this.#events.emit("cmap:load:start", { name });
    const promise = effectiveFetcher(name).then(
      data => {
        this.#cache.set(name, data);
        this.#events.emit("cmap:load:success", { name, fromCache: false });
        return data;
      },
      (reason: unknown) => {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        this.#events.emit("cmap:load:error", { name, message });
        // 失败必须继续抛出，维持与历史实现一致的错误语义。
        throw reason instanceof Error ? reason : new Error(message);
      }
    );
    this.#inFlight.set(name, promise);
    try {
      return await promise;
    } finally {
      this.#inFlight.delete(name);
    }
  }

  /**
   * 按策略在后台预加载 CMap。
   *
   * 设计为“发射后不管”：内部捕获所有失败，绝不向调用方抛出，
   * 因此可以安全地在关键渲染路径上触发而不影响首屏。
   * 相同配置的重复调用幂等（一轮预加载只执行一次）。
   *
   * @param config 预加载配置；缺省使用 `setPreloadConfig` 设置的配置。
   * @param fetcher 可选取数器，语义同 `load`。
   */
  async preload(
    config?: CMapPreloadConfig | null,
    fetcher?: BuiltInCMapFetcher
  ): Promise<void> {
    const effectiveConfig = config ?? this.#preloadConfig;
    const names = AsyncCMapLoader.#resolvePreloadNames(effectiveConfig);
    if (names.length === 0) {
      return;
    }
    const key = `${effectiveConfig.strategy}:${names.join(",")}`;
    if (this.#preloadedKey === key) {
      return; // 相同配置已预加载过，幂等返回。
    }
    this.#preloadedKey = key;

    this.#events.emit("cmap:preload:start", { names });
    const succeeded: string[] = [];
    const failed: string[] = [];
    // 串行预加载：避免对网络/主线程造成突发并发压力。
    for (const name of names) {
      try {
        await this.load(name, fetcher);
        succeeded.push(name);
      } catch {
        failed.push(name); // 失败已被 `load` 广播，这里只记录名单。
      }
    }
    this.#events.emit("cmap:preload:done", { succeeded, failed });
  }

  /**
   * 将预加载配置具体映射为 CMap 名单。
   * `"none"` → 空名单；`"common"` → 常用名单；`"custom"` → 用户名单。
   */
  static #resolvePreloadNames(config: CMapPreloadConfig): readonly string[] {
    switch (config.strategy) {
      case "common":
        return COMMON_BUILT_IN_CMAPS;
      case "custom":
        return config.names ?? [];
      case "none":
      default:
        return [];
    }
  }
}
