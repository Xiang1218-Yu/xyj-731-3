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
 * 泛型 LRU（最近最少使用）缓存（单一职责：只负责键值存取与容量控制）。
 *
 * 实现说明：
 * - 基于 `Map` 的插入序特性：每次 `get`/`set` 命中后把键挪到末尾（最新），
 *   容量超限时从头部（最久未使用）逐出；
 * - 逐出时通过构造时注入的 `onEvict` 回调通知外部（FontManager 借此
 *   发出 `cache:evict` 事件），缓存本身不依赖事件总线，保持解耦；
 * - 泛型 `<K, V>` 不是 `any`：实例化时键/值类型被具体化，
 *   例如 `LruCache<string, BuiltInCMapData>`。
 */

/** LRU 缓存的构造选项。 */
export interface LruCacheOptions<K> {
  /** 最大条目数，超出即逐出最久未使用项；缺省为 `LruCache.DEFAULT_MAX_SIZE`。 */
  readonly maxSize?: number;
  /** 条目被逐出时的回调（同步触发，先于条目真正移除返回）。 */
  readonly onEvict?: (key: K) => void;
}

export class LruCache<K, V> {
  /** 默认容量上限。 */
  static readonly DEFAULT_MAX_SIZE = 128;

  readonly #maxSize: number;

  readonly #onEvict: ((key: K) => void) | null;

  /** 底层存储；迭代序即“最旧 → 最新”。 */
  readonly #store = new Map<K, V>();

  constructor(options: LruCacheOptions<K> = {}) {
    this.#maxSize = Math.max(1, options.maxSize ?? LruCache.DEFAULT_MAX_SIZE);
    this.#onEvict = options.onEvict ?? null;
  }

  /** 当前缓存条目数。 */
  get size(): number {
    return this.#store.size;
  }

  /** 容量上限。 */
  get maxSize(): number {
    return this.#maxSize;
  }

  /**
   * 判断键是否存在（不改变 LRU 顺序）。
   */
  has(key: K): boolean {
    return this.#store.has(key);
  }

  /**
   * 读取缓存。命中会把该键刷新为“最新使用”。
   * @returns 命中返回值，未命中返回 `undefined`。
   */
  get(key: K): V | undefined {
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
  set(key: K, value: V): void {
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
  delete(key: K): boolean {
    return this.#store.delete(key);
  }

  /** 清空缓存（不触发 `onEvict`，因为这不是“容量逐出”）。 */
  clear(): void {
    this.#store.clear();
  }

  /**
   * 以“最旧 → 最新”的顺序返回全部键的快照（主要用于统计与调试）。
   */
  keys(): K[] {
    return [...this.#store.keys()];
  }
}
