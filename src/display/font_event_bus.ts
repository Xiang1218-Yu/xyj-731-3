/* Copyright 2012 Mozilla Foundation
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
 * @fileoverview
 * A type-safe event bus for the FontManager subsystem.
 *
 * Design principles:
 *  - Single responsibility: only event pub/sub, no business logic.
 *  - Type safety: event names are mapped to payload types via FontEventMap.
 *  - Listener lifecycle: supports AbortSignal for automatic cleanup.
 *  - Re-entrancy safe: listeners are snapshotted before dispatch.
 *  - No external dependencies; works in both browser and Node.js.
 */

import type {
  FontEventListener,
  FontEventMap,
  FontEventType,
} from "./font_types.js";

/**
 * Internal record for a registered event listener.
 */
interface ListenerEntry<K extends FontEventType = FontEventType> {
  /** The event handler callback. */
  readonly listener: FontEventListener<K>;
  /** Whether this listener should only fire once. */
  readonly once: boolean;
  /** Optional cleanup function called when the listener is removed. */
  readonly cleanup: (() => void) | undefined;
}

/**
 * Options for registering an event listener.
 */
interface OnOptions {
  /** If true, the listener is automatically removed after first invocation. */
  readonly once?: boolean;
  /**
   * An AbortSignal. When aborted, the listener is automatically removed.
   * Useful for tying listener lifetime to a request or component.
   */
  readonly signal?: AbortSignal;
}

/**
 * A type-safe publish/subscribe event bus for font lifecycle events.
 *
 * The bus uses a discriminated event map (FontEventMap) so that dispatching
 * an event requires the correct payload type and listeners receive correctly
 * typed arguments.
 *
 * @example
 * ```ts
 * const bus = new FontEventBus();
 * bus.on(FontEventType.FontLoadSuccess, (evt) => {
 *   console.log(`Loaded ${evt.fontName} in ${evt.loadTimeMs}ms`);
 * });
 * bus.dispatch(FontEventType.FontLoadSuccess, { ... });
 * ```
 */
class FontEventBus {
  /**
   * Map of event name -> set of listener entries.
   * Using a Map for O(1) lookup and Set for O(1) add/remove.
   */
  readonly #listeners: Map<FontEventType, Set<ListenerEntry>> = new Map();

  /**
   * Total number of events dispatched, for diagnostics.
   */
  #dispatchCount = 0;

  /**
   * Whether the bus has been destroyed.
   */
  #destroyed = false;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register a listener for a specific font event.
   *
   * @typeParam K - The event type key (inferred from eventName).
   * @param eventName - The event to listen for.
   * @param listener - The callback invoked with the event payload.
   * @param options - Optional configuration (once, signal).
   * @throws Error if the bus has been destroyed.
   */
  on<K extends FontEventType>(
    eventName: K,
    listener: FontEventListener<K>,
    options: OnOptions = {}
  ): void {
    this.#assertNotDestroyed();

    let entrySet = this.#listeners.get(eventName);
    if (!entrySet) {
      entrySet = new Set();
      this.#listeners.set(eventName, entrySet);
    }

    // Set up AbortSignal-based cleanup.
    let cleanup: (() => void) | undefined;
    if (options.signal) {
      const { signal } = options;
      if (signal.aborted) {
        // If already aborted, don't register.
        return;
      }
      const onAbort = (): void => this.off(eventName, listener);
      signal.addEventListener("abort", onAbort, { once: true });
      cleanup = () => signal.removeEventListener("abort", onAbort);
    }

    const entry: ListenerEntry<K> = {
      listener,
      once: options.once === true,
      cleanup,
    };
    entrySet.add(entry as ListenerEntry);
  }

  /**
   * Remove a previously registered listener.
   *
   * @typeParam K - The event type key.
   * @param eventName - The event to remove the listener from.
   * @param listener - The exact callback function to remove.
   */
  off<K extends FontEventType>(
    eventName: K,
    listener: FontEventListener<K>
  ): void {
    const entrySet = this.#listeners.get(eventName);
    if (!entrySet) {
      return;
    }

    for (const entry of entrySet) {
      if (entry.listener === listener) {
        entry.cleanup?.();
        entrySet.delete(entry);
        break;
      }
    }

    // Clean up empty sets to avoid memory leaks.
    if (entrySet.size === 0) {
      this.#listeners.delete(eventName);
    }
  }

  /**
   * Dispatch an event to all registered listeners.
   *
   * Listeners are invoked synchronously in registration order.
   * A snapshot of listeners is taken before dispatch, so listeners that
   * add/remove other listeners during dispatch don't affect the current
   * dispatch cycle.
   *
   * Errors thrown by listeners are caught and silently ignored, so one bad
   * listener does not prevent others from receiving the event.
   *
   * @typeParam K - The event type key.
   * @param eventName - The event to dispatch.
   * @param payload - The event payload (type-checked against FontEventMap).
   */
  dispatch<K extends FontEventType>(
    eventName: K,
    payload: FontEventMap[K]
  ): void {
    if (this.#destroyed) {
      return;
    }

    this.#dispatchCount++;

    const entrySet = this.#listeners.get(eventName);
    if (!entrySet || entrySet.size === 0) {
      return;
    }

    // Snapshot to allow listeners to mutate the set during dispatch.
    const snapshot = Array.from(entrySet);

    for (const entry of snapshot) {
      if (entry.once) {
        this.off(eventName, entry.listener);
      }
      try {
        (entry.listener as FontEventListener<K>)(payload);
      } catch {
        // Silently ignore; one bad listener shouldn't break others.
      }
    }
  }

  /**
   * Returns a promise that resolves when the specified event fires.
   * Useful for async/await patterns in tests and startup flows.
   *
   * @typeParam K - The event type key.
   * @param eventName - The event to wait for.
   * @param signal - Optional AbortSignal to cancel waiting.
   * @returns A promise resolving to the event payload.
   */
  waitFor<K extends FontEventType>(
    eventName: K,
    signal?: AbortSignal
  ): Promise<FontEventMap[K]> {
    return new Promise<FontEventMap[K]>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      const listener: FontEventListener<K> = payload => {
        signal?.removeEventListener("abort", onAbort);
        resolve(payload);
      };

      const onAbort = (): void => {
        this.off(eventName, listener);
        reject(signal?.reason);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      this.on(eventName, listener, { once: true });
    });
  }

  /**
   * Check whether any listeners are registered for an event.
   *
   * @param eventName - The event to check.
   * @returns True if at least one listener is registered.
   */
  hasListeners(eventName: FontEventType): boolean {
    const entrySet = this.#listeners.get(eventName);
    return !!entrySet && entrySet.size > 0;
  }

  /**
   * Get the number of listeners for an event.
   *
   * @param eventName - The event to count.
   * @returns The listener count.
   */
  listenerCount(eventName: FontEventType): number {
    const entrySet = this.#listeners.get(eventName);
    return entrySet ? entrySet.size : 0;
  }

  /**
   * Get the total number of events dispatched since creation.
   */
  get dispatchCount(): number {
    return this.#dispatchCount;
  }

  /**
   * Remove all listeners from all events and mark the bus as destroyed.
   * After destruction, no further events will be dispatched.
   */
  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;

    for (const [, entrySet] of this.#listeners) {
      for (const entry of entrySet) {
        entry.cleanup?.();
      }
      entrySet.clear();
    }
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Assert that the bus has not been destroyed.
   * @throws Error if destroyed.
   */
  #assertNotDestroyed(): void {
    if (this.#destroyed) {
      throw new Error(
        "FontEventBus has been destroyed and cannot accept new listeners."
      );
    }
  }
}

export { FontEventBus, type OnOptions };
