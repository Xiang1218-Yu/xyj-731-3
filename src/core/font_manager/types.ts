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
 * 字体管理中心（FontManager）的公共类型定义。
 *
 * 本文件只负责“类型”这一件事（单一职责）：
 * 所有跨模块共享的接口、枚举式联合类型、事件载荷都集中在这里，
 * 并且每一种事件都有与其一一对应的具体载荷类型（禁止使用 any）。
 *
 * 说明：本模块被编译为纯 ESM JavaScript 供现有 JS 代码直接使用，
 * 类型信息仅存在于编译期与 `.d.ts` 声明文件中，运行时零开销。
 */

/* ============================================================================
 * 一、基础设施类型：缓存命名空间
 * ========================================================================== */

/**
 * 缓存命名空间。
 *
 * FontManager 内部为多类资源分别维护缓存，命名空间用于在事件与统计中
 * 明确标识“是哪一类缓存”：
 * - `"builtin-cmap"`：内置 CMap（.bcmap / 文本 CMap 字节）缓存；
 * - `"standard-font"`：标准 14 字体（standard fonts）原始字节缓存。
 */
export type CacheNamespace = "builtin-cmap" | "standard-font";

/* ============================================================================
 * 二、CMap 加载相关类型
 * ========================================================================== */

/**
 * 内置 CMap 数据载荷。
 *
 * 与 `src/core/evaluator.js` 中 `fetchBuiltInCMap` 历史上返回的字面量对象
 * 结构一一对应，保证 JS 侧调用方零改动：
 * - `cMapData`：CMap 原始字节。压缩格式为 `.bcmap` 二进制；
 *   非压缩格式为文本 CMap 的 UTF-8 字节；
 * - `isCompressed`：标记 `cMapData` 是否为压缩格式，
 *   供 `BinaryCMapReader` 或 `Lexer` 选择解析路径。
 */
export interface BuiltInCMapData {
  readonly cMapData: Uint8Array;
  readonly isCompressed: boolean;
}

/**
 * 内置 CMap 取数器（fetcher）函数签名。
 *
 * FontManager 本身不关心“字节从哪里来”（worker 直取 / 主线程代取），
 * 由调用方（目前是 `PartialEvaluator`）将具体的抓取实现注入进来，
 * FontManager 只负责调度、去重、缓存与事件通知。
 */
export type BuiltInCMapFetcher = (name: string) => Promise<BuiltInCMapData>;

/**
 * 标准字体原始字节取数器函数签名。
 *
 * 返回 `null` 表示该字体数据不可用（例如网络失败），
 * 调用方据此继续走后续回退逻辑；`null` 结果不会被缓存，
 * 以便后续渲染可以重试。
 */
export type StandardFontDataFetcher = (
  name: string
) => Promise<Uint8Array | null>;

/**
 * CMap 预加载策略。
 * - `"none"`：不预加载（默认，完全按需异步加载，不影响首屏渲染）；
 * - `"common"`：预加载常用 CMap 集合（见 `cmap_loader.ts` 中的
 *   `COMMON_BUILT_IN_CMAPS`），适合 CJK 文档高频场景；
 * - `"custom"`：按 `CMapPreloadConfig.names` 指定的名单预加载。
 */
export type CMapPreloadStrategy = "none" | "common" | "custom";

/**
 * CMap 预加载配置。
 *
 * 可通过 `getDocument({ cMapPreload: ... })` 传入（API 兼容的可选参数），
 * 也可通过 `FontManager.setCMapPreloadConfig` 动态调整。
 */
export interface CMapPreloadConfig {
  /** 预加载策略，缺省视为 `"none"`。 */
  readonly strategy: CMapPreloadStrategy;
  /** 当 `strategy === "custom"` 时生效的 CMap 名单。 */
  readonly names?: readonly string[];
}

/* ============================================================================
 * 三、智能字体回退链相关类型
 * ========================================================================== */

/**
 * 字体加载失败的原因（回退链的输入之一）。
 * - `"missing-dict"`：字体字典缺失或无法解析（PDF 文件损坏 / 引用错误）；
 * - `"load-failed"`：字体文件抓取、解析或转换失败；
 * - `"unsupported-type"`：字体类型不受支持。
 */
export type FontFallbackReason =
  "missing-dict" | "load-failed" | "unsupported-type";

/**
 * 回退上下文：描述一个“需要回退”的字体的全部已知特征。
 *
 * 回退链上的每个处理器（`FontFallbackHandler`）依据这些特征决定
 * 是否接管本次回退。字段与 PDF 字体描述符（FontDescriptor）中的
 * Flags 位一一对应。
 */
export interface FontFallbackContext {
  /** PDF 资源字典中的字体名（`Tf` 操作数），可能为 `null`。 */
  readonly fontName: string | null;
  /** 字体字典中的 `BaseFont` 名（已规范化），可能为 `null`。 */
  readonly baseFontName: string | null;
  /** 触发回退的原因。 */
  readonly reason: FontFallbackReason;
  /** FontDescriptor Flags 的加粗位。 */
  readonly bold: boolean;
  /** FontDescriptor Flags 的斜体位。 */
  readonly italic: boolean;
  /** FontDescriptor Flags 的等宽位。 */
  readonly monospace: boolean;
  /** FontDescriptor Flags 的衬线位。 */
  readonly serif: boolean;
}

/**
 * 回退决策结果：回退链输出给调用方的“下一步怎么做”。
 */
export interface FontFallbackResult {
  /**
   * 命中策略的名称，具体映射到链上某个 `FontFallbackHandler.name`，
   * 例如 `"default-dict"`、`"terminal-error-font"`。
   */
  readonly strategy: string;
  /**
   * 是否使用默认字体字典（Helvetica + WinAnsiEncoding）顶替，
   * 对应 `PartialEvaluator.fallbackFontDict` 的历史行为。
   */
  readonly useDefaultDict: boolean;
  /**
   * 是否为终态错误：为 `true` 时调用方应构造 `ErrorFont`，
   * 后续文本绘制走内置字形渲染，保证页面不崩。
   */
  readonly isTerminalError: boolean;
}

/**
 * 回退链上的处理器接口（责任链模式）。
 *
 * 每个处理器只实现一种回退策略（单一职责）：
 * `handle` 返回 `null` 表示“我不处理，交给下一级”；
 * 返回具体的 `FontFallbackResult` 表示“我接管，链路终止”。
 */
export interface FontFallbackHandler {
  /** 处理器（策略）名称，会原样出现在 `FontFallbackResult.strategy` 中。 */
  readonly name: string;
  /**
   * 尝试处理一次回退请求。
   * @param context 回退上下文。
   * @returns 决策结果；返回 `null` 表示不处理并移交下一级处理器。
   */
  handle(context: FontFallbackContext): FontFallbackResult | null;
}

/* ============================================================================
 * 四、统一事件总线相关类型：每一种事件都有具体的载荷类型
 * ========================================================================== */

/** 事件：开始加载某个内置 CMap。 */
export interface CMapLoadStartEvent {
  readonly name: string;
}

/** 事件：某个内置 CMap 加载成功。 */
export interface CMapLoadSuccessEvent {
  readonly name: string;
  /** 是否命中缓存（未发生真实网络/主线程请求）。 */
  readonly fromCache: boolean;
}

/** 事件：某个内置 CMap 加载失败。 */
export interface CMapLoadErrorEvent {
  readonly name: string;
  readonly message: string;
}

/** 事件：开始一轮 CMap 预加载。 */
export interface CMapPreloadStartEvent {
  readonly names: readonly string[];
}

/** 事件：一轮 CMap 预加载结束。 */
export interface CMapPreloadDoneEvent {
  readonly succeeded: readonly string[];
  readonly failed: readonly string[];
}

/** 事件：开始加载某个字体。 */
export interface FontLoadStartEvent {
  readonly fontName: string;
}

/** 事件：某个字体转换完成并已发往主线程注册。 */
export interface FontLoadSuccessEvent {
  readonly fontName: string;
  /** 发往主线程的全局唯一字体标识（`loadedName`）。 */
  readonly loadedName: string;
}

/** 事件：回退链对某个字体做出了回退决策。 */
export interface FontFallbackEvent {
  readonly fontName: string | null;
  readonly reason: FontFallbackReason;
  /** 命中的策略名（与 `FontFallbackResult.strategy` 一致）。 */
  readonly strategy: string;
  /** 是否为终态错误（ErrorFont）。 */
  readonly terminal: boolean;
}

/** 事件：主线程 FontFace 注册失败，回退到内置字形渲染器。 */
export interface FontFaceFallbackEvent {
  readonly loadedName: string;
}

/** 事件：字体彻底不可用（ErrorFont）。 */
export interface FontErrorEvent {
  readonly fontName: string | null;
  readonly message: string;
}

/** 事件：缓存发生淘汰（LRU 挤出）。 */
export interface CacheEvictEvent {
  readonly namespace: CacheNamespace;
  readonly key: string;
}

/**
 * 事件名 → 事件载荷 的具体映射表。
 *
 * 事件总线 `FontEventBus` 以此为约束实现强类型的
 * `on` / `off` / `emit`：订阅 `"cmap:load:success"` 时，
 * 回调参数自动推导为 `CMapLoadSuccessEvent`，编译期即可发现拼写错误。
 */
export interface FontEventMap {
  "cmap:load:start": CMapLoadStartEvent;
  "cmap:load:success": CMapLoadSuccessEvent;
  "cmap:load:error": CMapLoadErrorEvent;
  "cmap:preload:start": CMapPreloadStartEvent;
  "cmap:preload:done": CMapPreloadDoneEvent;
  "font:load:start": FontLoadStartEvent;
  "font:load:success": FontLoadSuccessEvent;
  "font:fallback": FontFallbackEvent;
  "font:face-fallback": FontFaceFallbackEvent;
  "font:error": FontErrorEvent;
  "cache:evict": CacheEvictEvent;
}

/* ============================================================================
 * 五、统计信息类型
 * ========================================================================== */

/** FontManager 各缓存的占用统计。 */
export interface FontCacheStats {
  /** 各命名空间当前缓存的条目数，键与 `CacheNamespace` 一一对应。 */
  readonly entries: Record<CacheNamespace, number>;
}
