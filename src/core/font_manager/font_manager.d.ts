import type { BuiltInCMapData, BuiltInCMapFetcher, CMapPreloadConfig, FontCacheStats, FontFallbackContext, FontFallbackResult, StandardFontDataFetcher } from "./types.js";
import { FontEventBus } from "./event_bus.js";
import { FontFallbackChain } from "./fallback_chain.js";
/**
 * 字体统一管理中心（单例门面）。
 *
 * 职责定位：FontManager 本身不实现具体加载/回退逻辑，只负责“组合与协调”
 * 下列各自单一职责的组件（门面模式）：
 * - `FontEventBus`：统一事件总线，广播字体/CMap 加载、回退、缓存事件；
 * - `AsyncCMapLoader`：内置 CMap 的异步按需加载、并发去重与预加载；
 * - `FontFallbackChain`：智能字体回退链，输出回退决策；
 * - `LruCache`：进程级缓存（内置 CMap、标准字体原始字节）。
 *
 * 为什么用单例：字体/CMap 资源按名全局唯一且不可变，进程级共享缓存
 * 可以跨页面、跨文档复用加载结果；同时事件总线作为统一观测入口，
 * 也要求全局唯一。通过 `getInstance()` 获取，`resetInstance()`
 * 仅供测试使用。
 *
 * 兼容性说明：本类由 TypeScript 编译为纯 ESM JavaScript，现有 JS 代码
 * （如 `PartialEvaluator`）直接 `import { FontManager }` 使用，
 * 其公开方法的参数/返回值结构与历史实现一一对应。
 */
export declare class FontManager {
    #private;
    /** 统一事件总线（公开只读，供上层订阅监控事件）。 */
    readonly events: FontEventBus;
    /** 私有构造：禁止 `new`，实例只能经 `getInstance()` 获取。 */
    private constructor();
    /** 获取全局唯一实例（首次调用时创建）。 */
    static getInstance(): FontManager;
    /**
     * 重置单例（清空全部缓存、监听器与配置）。
     * 仅供单元测试隔离使用，生产代码不应调用。
     */
    static resetInstance(): void;
    /** 注册默认的内置 CMap 取数器。 */
    registerCMapFetcher(fetcher: BuiltInCMapFetcher): void;
    /**
     * 异步按需加载一个内置 CMap（带并发去重与 LRU 缓存）。
     * @param name CMap 名。
     * @param fetcher 可选取数器；缺省使用 `registerCMapFetcher` 注册的。
     */
    loadBuiltInCMap(name: string, fetcher?: BuiltInCMapFetcher): Promise<BuiltInCMapData>;
    /**
     * 触发一轮后台 CMap 预加载（幂等，绝不抛出，不影响首屏渲染）。
     * @param config 预加载配置；传入 `null` 表示沿用已设置的配置。
     */
    preloadCMaps(config: CMapPreloadConfig | null, fetcher?: BuiltInCMapFetcher): Promise<void>;
    /** 动态更新 CMap 预加载配置。 */
    setCMapPreloadConfig(config: CMapPreloadConfig): void;
    /** 某个内置 CMap 是否已加载。 */
    isBuiltInCMapLoaded(name: string): boolean;
    /**
     * 预填充内置 CMap 缓存（兼容旧调用方的预加载数据迁入）。
     * 已存在同名缓存时为无操作。详见 `AsyncCMapLoader.prime`。
     */
    primeBuiltInCMap(name: string, data: BuiltInCMapData): void;
    /**
     * 预填充标准字体原始字节缓存（兼容旧调用方的预加载数据迁入）。
     * 已存在同名缓存时为无操作。
     */
    primeStandardFontData(name: string, data: Uint8Array): void;
    /**
     * 加载标准字体原始字节（带 LRU 缓存与并发去重）。
     *
     * 语义与历史 `PartialEvaluator.fetchStandardFontData` 一致：
     * 取数失败返回 `null` 而不是抛出；`null` 结果不缓存，允许后续重试。
     *
     * @param name 标准字体名（如 `"Helvetica-Bold"`）。
     * @param fetcher 原始字节取数器，由调用方注入。
     */
    loadStandardFontData(name: string, fetcher: StandardFontDataFetcher): Promise<Uint8Array | null>;
    /** 回退链（只读暴露，供上层插入/移除自定义回退处理器）。 */
    get fallbackChain(): FontFallbackChain;
    /**
     * 对一次字体加载失败进行回退决策，并广播 `font:fallback` 事件。
     *
     * 决策语义与历史实现一一对应：
     * - `useDefaultDict === true`：调用方用默认字体字典顶替；
     * - `isTerminalError === true`：调用方构造 `ErrorFont`。
     */
    resolveFontFallback(context: FontFallbackContext): FontFallbackResult;
    /** 各缓存当前的占用统计。 */
    cacheStats(): FontCacheStats;
    /** 清空全部资源缓存（不影响事件监听器与回退链配置）。 */
    clearCaches(): void;
}
