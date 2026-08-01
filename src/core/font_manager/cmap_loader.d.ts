import type { BuiltInCMapData, BuiltInCMapFetcher, CMapPreloadConfig } from "./types.js";
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
export declare const COMMON_BUILT_IN_CMAPS: readonly string[];
/** 加载器构造选项。 */
export interface AsyncCMapLoaderOptions {
    /** 进程级 LRU 缓存（由 FontManager 创建并注入）。 */
    readonly cache: LruCache<string, BuiltInCMapData>;
    /** 事件总线（由 FontManager 创建并注入）。 */
    readonly events: FontEventBus;
    /** 初始预加载配置，缺省为 `{ strategy: "none" }`。 */
    readonly preload?: CMapPreloadConfig;
}
export declare class AsyncCMapLoader {
    #private;
    constructor(options: AsyncCMapLoaderOptions);
    /** 注册默认取数器（后注册者覆盖先注册者）。 */
    registerFetcher(fetcher: BuiltInCMapFetcher): void;
    /** 更新预加载配置；指纹随之失效，下次 `preload` 会按新配置执行。 */
    setPreloadConfig(config: CMapPreloadConfig): void;
    /** 某个 CMap 是否已加载（命中缓存）。 */
    isLoaded(name: string): boolean;
    /**
     * 预填充（prime）：把“已有的” CMap 数据直接写入缓存，跳过取数。
     *
     * 用途：兼容历史调用方（如旧版 `PartialEvaluator` 的调用点在构造前
     * 预填充的 `builtInCMapCache`），把外部已加载的数据一次性迁入
     * 统一缓存，保证 FontManager 始终是唯一缓存数据源。
     * 已存在同名缓存时为无操作（外部数据与缓存语义一致，先到先得）。
     */
    prime(name: string, data: BuiltInCMapData): void;
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
    load(name: string, fetcher?: BuiltInCMapFetcher): Promise<BuiltInCMapData>;
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
    preload(config?: CMapPreloadConfig | null, fetcher?: BuiltInCMapFetcher): Promise<void>;
    /**
     * 释放加载器内部状态：清空 in-flight 表、预加载指纹与默认取数器。
     * 由 `FontManager.dispose` 调用；进行中的加载 Promise 仍会正常
     * 落定（其结果写入的缓存随 FontManager 一并释放，无副作用）。
     */
    dispose(): void;
}
