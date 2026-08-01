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
export type FontEventListener<K extends FontEventName> = (payload: FontEventMap[K]) => void;
export declare class FontEventBus {
    #private;
    /**
     * 订阅事件。
     * @param type 事件名（必须是 `FontEventMap` 中定义的键）。
     * @param listener 监听器，参数类型随事件名自动推导。
     * @returns 解绑函数，调用一次即可退订（等价于 `off`）。
     */
    on<K extends FontEventName>(type: K, listener: FontEventListener<K>): () => void;
    /**
     * 退订事件。若该监听器未注册过，则为无操作（幂等）。
     */
    off<K extends FontEventName>(type: K, listener: FontEventListener<K>): void;
    /**
     * 同步分发事件。按注册顺序依次调用监听器；
     * 单个监听器抛出的异常会被捕获并静默忽略（保证分发健壮性）。
     */
    emit<K extends FontEventName>(type: K, payload: FontEventMap[K]): void;
    /**
     * 某个事件当前是否有监听器（用于避免无谓地构造载荷对象）。
     */
    hasListeners(type: FontEventName): boolean;
    /** 移除全部事件的全部监听器（主要用于测试与文档销毁场景）。 */
    clear(): void;
}
