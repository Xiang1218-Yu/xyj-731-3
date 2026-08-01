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

import type { FontEventMap } from "./types.js";

/**
 * 统一事件总线（单一职责：只负责事件的订阅、退订与分发）。
 *
 * 设计要点：
 * 1. 强类型：事件名必须来自 `FontEventMap`，回调载荷类型由事件名自动推导，
 *    全程无 `any`；拼错事件名会在编译期报错。
 * 2. 与 `web/event_utils.js` 的 `EventBus` 不同：后者只在查看器层可用，
 *    而本总线零依赖，可在 core worker 线程中运行；
 *    worker → 主线程的跨线程通信仍走 `MessageHandler`，两者职责互补。
 * 3. 监听器异常被隔离：某个监听器抛错不会影响同事件的其他监听器，
 *    也不会中断 `emit` 的调用方。
 */

/** 事件名联合类型：`"cmap:load:start" | "font:fallback" | ...`。 */
export type FontEventName = keyof FontEventMap;

/** 某个事件对应的监听器函数类型。 */
export type FontEventListener<K extends FontEventName> = (
  payload: FontEventMap[K]
) => void;

/**
 * 内部存储用的“擦除型”监听器签名。
 * 由于 `Map` 无法按键区分泛型，存储时统一视为接收联合载荷的函数，
 * 在 `emit` 处再通过类型断言恢复具体类型（断言是安全的：
 * 注册与分发使用同一个事件名作键）。
 */
type ErasedListener = (payload: FontEventMap[FontEventName]) => void;

export class FontEventBus {
  /** 事件名 → 监听器集合。用 `Set` 保证同一监听器不会被重复注册。 */
  readonly #listeners = new Map<FontEventName, Set<ErasedListener>>();

  /**
   * 订阅事件。
   * @param type 事件名（必须是 `FontEventMap` 中定义的键）。
   * @param listener 监听器，参数类型随事件名自动推导。
   * @returns 解绑函数，调用一次即可退订（等价于 `off`）。
   */
  on<K extends FontEventName>(
    type: K,
    listener: FontEventListener<K>
  ): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set<ErasedListener>();
      this.#listeners.set(type, set);
    }
    set.add(listener as ErasedListener);
    return () => this.off(type, listener);
  }

  /**
   * 退订事件。若该监听器未注册过，则为无操作（幂等）。
   */
  off<K extends FontEventName>(type: K, listener: FontEventListener<K>): void {
    const set = this.#listeners.get(type);
    if (!set) {
      return;
    }
    set.delete(listener as ErasedListener);
    if (set.size === 0) {
      this.#listeners.delete(type);
    }
  }

  /**
   * 同步分发事件。按注册顺序依次调用监听器；
   * 单个监听器抛出的异常会被捕获并静默忽略（保证分发健壮性）。
   */
  emit<K extends FontEventName>(type: K, payload: FontEventMap[K]): void {
    const set = this.#listeners.get(type);
    if (!set) {
      return;
    }
    // 先快照再遍历，避免监听器在执行过程中退订导致遍历异常。
    for (const listener of [...set]) {
      try {
        (listener as FontEventListener<K>)(payload);
      } catch {
        // 监听器异常不应影响事件分发与其他监听器。
      }
    }
  }

  /**
   * 某个事件当前是否有监听器（用于避免无谓地构造载荷对象）。
   */
  hasListeners(type: FontEventName): boolean {
    return this.#listeners.has(type);
  }

  /** 移除全部事件的全部监听器（主要用于测试与文档销毁场景）。 */
  clear(): void {
    this.#listeners.clear();
  }
}
