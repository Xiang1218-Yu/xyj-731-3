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
 * 智能字体回退链（单一职责：只负责“字体加载失败时选哪种回退策略”）。
 *
 * 采用责任链（Chain of Responsibility）模式：
 * - 链上每个 `FontFallbackHandler` 只实现一种策略；
 * - `resolve` 按优先级依次询问，首个返回非 `null` 的处理器接管，
 *   其 `FontFallbackResult` 即最终决策；
 * - 默认链保持 PDF.js 的历史行为（见下方两个内置处理器），
 *   调用方可在终端处理器之前插入自定义处理器，实现更智能的回退
 *   （例如按字体特征映射到本机系统字体）。
 *
 * 默认链（与历史行为一一对应，保证重构无回归）：
 *   1. `default-dict`：字体字典缺失时回退到默认字典
 *      （Helvetica + WinAnsiEncoding，见 `PartialEvaluator.fallbackFontDict`）；
 *   2. `terminal-error-font`：兜底策略，构造 `ErrorFont`，
 *      文本走内置字形渲染，保证页面不崩、不再出现整段乱码。
 */
/**
 * 内置处理器：字体字典缺失时的默认字典回退。
 * 对应历史代码 `loadFont` 中 `font = fallbackFontDict || ...` 的分支。
 */
class DefaultDictFallbackHandler {
    name = "default-dict";
    handle(context) {
        if (context.reason !== "missing-dict") {
            return null; // 本处理器只处理“字典缺失”，其余原因移交下一级。
        }
        return {
            strategy: this.name,
            useDefaultDict: true,
            isTerminalError: false,
        };
    }
}
/**
 * 内置处理器：终态兜底。任何未被前级处理的情况都由它接管，
 * 决策为构造 `ErrorFont`。它必须始终是链上最后一个处理器。
 */
class TerminalErrorFontHandler {
    name = "terminal-error-font";
    handle(context) {
        return {
            strategy: this.name,
            useDefaultDict: false,
            isTerminalError: true,
        };
    }
}
export class FontFallbackChain {
    /** 处理器列表，按优先级从高到低排列。 */
    #handlers;
    /**
     * @param handlers 自定义链；缺省使用历史行为等价的默认链。
     *   传入自定义链时必须保证至少有一个“终态”处理器
     *   （`handle` 永不返回 `null`），否则 `resolve` 会抛出异常。
     */
    constructor(handlers) {
        this.#handlers = handlers
            ? [...handlers]
            : [new DefaultDictFallbackHandler(), new TerminalErrorFontHandler()];
    }
    /** 链上处理器名称（按优先级顺序），主要用于调试与测试。 */
    get handlerNames() {
        return this.#handlers.map(handler => handler.name);
    }
    /**
     * 在终端处理器之前插入一个处理器（推荐的扩展方式）。
     * @returns 插入成功返回 `true`；链为空（异常状态）返回 `false`。
     */
    addHandler(handler) {
        const terminalIndex = this.#handlers.length - 1;
        if (terminalIndex < 0) {
            return false;
        }
        this.#handlers.splice(terminalIndex, 0, handler);
        return true;
    }
    /**
     * 按名称移除处理器。为保护链的完整性，最后一个（终态）处理器
     * 不允许移除。
     * @returns 是否实际移除了处理器。
     */
    removeHandler(name) {
        const index = this.#handlers.findIndex((handler, position) => handler.name === name && position < this.#handlers.length - 1);
        if (index < 0) {
            return false;
        }
        this.#handlers.splice(index, 1);
        return true;
    }
    /**
     * 运行回退链，产出最终回退决策。
     *
     * 依次询问链上处理器，首个返回非 `null` 者的决策生效；
     * 若链上没有任何处理器接管（自定义链缺少终态处理器的异常情况），
     * 返回一个保守的终态错误决策，保证调用方总能得到确定结果。
     */
    resolve(context) {
        for (const handler of this.#handlers) {
            const result = handler.handle(context);
            if (result) {
                return result;
            }
        }
        // 防御性兜底：理论上默认链不会走到这里。
        return {
            strategy: "implicit-terminal",
            useDefaultDict: false,
            isTerminalError: true,
        };
    }
}
