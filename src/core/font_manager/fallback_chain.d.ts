import type { FontFallbackContext, FontFallbackHandler, FontFallbackResult } from "./types.js";
export declare class FontFallbackChain {
    #private;
    /**
     * @param handlers 自定义链；缺省使用历史行为等价的默认链。
     *   传入自定义链时必须保证至少有一个“终态”处理器
     *   （`handle` 永不返回 `null`），否则 `resolve` 会抛出异常。
     */
    constructor(handlers?: readonly FontFallbackHandler[]);
    /** 链上处理器名称（按优先级顺序），主要用于调试与测试。 */
    get handlerNames(): readonly string[];
    /**
     * 在终端处理器之前插入一个处理器（推荐的扩展方式）。
     * @returns 插入成功返回 `true`；链为空（异常状态）返回 `false`。
     */
    addHandler(handler: FontFallbackHandler): boolean;
    /**
     * 按名称移除处理器。为保护链的完整性，最后一个（终态）处理器
     * 不允许移除。
     * @returns 是否实际移除了处理器。
     */
    removeHandler(name: string): boolean;
    /**
     * 运行回退链，产出最终回退决策。
     *
     * 依次询问链上处理器，首个返回非 `null` 者的决策生效；
     * 若链上没有任何处理器接管（自定义链缺少终态处理器的异常情况），
     * 返回一个保守的终态错误决策，保证调用方总能得到确定结果。
     */
    resolve(context: FontFallbackContext): FontFallbackResult;
}
