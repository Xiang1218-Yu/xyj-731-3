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
export class FontEventBus {
    /** 事件名 → 监听器集合。用 `Set` 保证同一监听器不会被重复注册。 */
    #listeners = new Map();
    /**
     * 订阅事件。
     * @param type 事件名（必须是 `FontEventMap` 中定义的键）。
     * @param listener 监听器，参数类型随事件名自动推导。
     * @returns 解绑函数，调用一次即可退订（等价于 `off`）。
     */
    on(type, listener) {
        let set = this.#listeners.get(type);
        if (!set) {
            set = new Set();
            this.#listeners.set(type, set);
        }
        set.add(listener);
        return () => this.off(type, listener);
    }
    /**
     * 退订事件。若该监听器未注册过，则为无操作（幂等）。
     */
    off(type, listener) {
        const set = this.#listeners.get(type);
        if (!set) {
            return;
        }
        set.delete(listener);
        if (set.size === 0) {
            this.#listeners.delete(type);
        }
    }
    /**
     * 同步分发事件。按注册顺序依次调用监听器；
     * 单个监听器抛出的异常会被捕获并静默忽略（保证分发健壮性）。
     */
    emit(type, payload) {
        const set = this.#listeners.get(type);
        if (!set) {
            return;
        }
        // 先快照再遍历，避免监听器在执行过程中退订导致遍历异常。
        for (const listener of [...set]) {
            try {
                listener(payload);
            }
            catch {
                // 监听器异常不应影响事件分发与其他监听器。
            }
        }
    }
    /**
     * 某个事件当前是否有监听器（用于避免无谓地构造载荷对象）。
     */
    hasListeners(type) {
        return this.#listeners.has(type);
    }
    /** 移除全部事件的全部监听器（主要用于测试与文档销毁场景）。 */
    clear() {
        this.#listeners.clear();
    }
}
