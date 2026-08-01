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
export class LruCache {
    /** 默认容量上限。 */
    static DEFAULT_MAX_SIZE = 128;
    #maxSize;
    #onEvict;
    /** 底层存储；迭代序即“最旧 → 最新”。 */
    #store = new Map();
    constructor(options = {}) {
        this.#maxSize = Math.max(1, options.maxSize ?? LruCache.DEFAULT_MAX_SIZE);
        this.#onEvict = options.onEvict ?? null;
    }
    /** 当前缓存条目数。 */
    get size() {
        return this.#store.size;
    }
    /** 容量上限。 */
    get maxSize() {
        return this.#maxSize;
    }
    /**
     * 判断键是否存在（不改变 LRU 顺序）。
     */
    has(key) {
        return this.#store.has(key);
    }
    /**
     * 读取缓存。命中会把该键刷新为“最新使用”。
     * @returns 命中返回值，未命中返回 `undefined`。
     */
    get(key) {
        const value = this.#store.get(key);
        if (value === undefined) {
            return undefined;
        }
        // 挪到末尾，标记为最近使用。
        this.#store.delete(key);
        this.#store.set(key, value);
        return value;
    }
    /**
     * 写入缓存。已存在则覆盖并刷新为“最新使用”；
     * 写入后超出容量时，逐出最久未使用的条目并触发 `onEvict`。
     */
    set(key, value) {
        if (this.#store.has(key)) {
            this.#store.delete(key);
        }
        this.#store.set(key, value);
        while (this.#store.size > this.#maxSize) {
            // `Map` 迭代序的第一个键即最久未使用项。
            const oldest = this.#store.keys().next();
            if (oldest.done) {
                break;
            }
            this.#onEvict?.(oldest.value);
            this.#store.delete(oldest.value);
        }
    }
    /** 删除指定键。 */
    delete(key) {
        return this.#store.delete(key);
    }
    /** 清空缓存（不触发 `onEvict`，因为这不是“容量逐出”）。 */
    clear() {
        this.#store.clear();
    }
    /**
     * 以“最旧 → 最新”的顺序返回全部键的快照（主要用于统计与调试）。
     */
    keys() {
        return [...this.#store.keys()];
    }
}
