/**
 * @license
 * Copyright 2012 Mozilla Foundation
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
 *
 * A minimal, strongly-typed event bus used by the FontManager.
 *
 * Design goals:
 *  - **Single responsibility**: the bus only knows how to dispatch events and
 *    keep track of listeners.  It has no knowledge of fonts or caching.
 *  - **Type safety**: the event map guarantees that a listener for an event
 *    receives the correct payload type.  No `any` is used.
 *  - **JS compatibility**: the compiled output is plain ES2022 JavaScript that
 *    can be imported by the existing JS codebase, while the `.d.ts` file makes
 *    the types available to TypeScript consumers.
 *  - **Re-entrancy safety**: listeners that are added or removed during a
 *    dispatch do not affect the current dispatch; they take effect on the next
 *    one.  This matches the behaviour of the DOM `EventTarget` and avoids class
 *    of bugs where a handler unsubscribes itself and corrupts the iteration.
 */

import type {
  FontManagerEventMap,
  FontManagerEventName,
} from "./types.ts";

/** A listener for event `K`. */
export type EventListener<K extends FontManagerEventName> = (
  payload: FontManagerEventMap[K]
) => void;

interface Subscription {
  /** The event the listener is subscribed to. */
  readonly event: FontManagerEventName;
  /** The listener callback (kept as a concrete function reference). */
  readonly listener: EventListener<FontManagerEventName>;
  /** When `true`, the listener is automatically removed after one dispatch. */
  readonly once: boolean;
}

export class EventBus {
  /**
   * Active subscriptions, stored in insertion order.  Insertion order matters
   * because listeners are notified in the order they were registered.
   */
  readonly #subscriptions: Subscription[] = [];

  /**
   * Re-usable empty array used while dispatching to avoid allocating a new
   * array for every event.
   */
  #dispatching = false;

  /**
   * Subscriptions added / removed while a dispatch is in flight are buffered
   * here and applied once the dispatch completes.
   */
  readonly #pending: Array<() => void> = [];

  /**
   * Handler invoked when a listener throws.  Defaults to `console.error` so
   * that errors are observable but do not become uncaught exceptions; tests
   * (and production callers) can replace it via {@link setErrorHandler}.
   */
  #errorHandler: (error: unknown) => void = (error: unknown): void => {
    // eslint-disable-next-line no-console
    console.error("FontManager EventBus listener error:", error);
  };

  /**
   * Register a listener for the given event.
   *
   * @returns an `unsubscribe` function.  Calling it removes the listener and
   *   is idempotent.
   */
  on<K extends FontManagerEventName>(
    event: K,
    listener: EventListener<K>
  ): () => void {
    return this.#add(event, listener, /* once = */ false);
  }

  /**
   * Register a listener that will be invoked at most once.
   */
  once<K extends FontManagerEventName>(
    event: K,
    listener: EventListener<K>
  ): () => void {
    return this.#add(event, listener, /* once = */ true);
  }

  /**
   * Remove a previously registered listener.  Both regular and `once`
   * subscriptions are matched.  The call is a no-op when the listener is not
   * found.
   */
  off<K extends FontManagerEventName>(
    event: K,
    listener: EventListener<K>
  ): void {
    const remove = (): void => {
      const index = this.#subscriptions.findIndex(
        sub => sub.event === event && sub.listener === listener
      );
      if (index !== -1) {
        this.#subscriptions.splice(index, 1);
      }
    };

    if (this.#dispatching) {
      this.#pending.push(remove);
    } else {
      remove();
    }
  }

  /**
   * Replace the error handler.  Pass `null` to silently swallow listener
   * errors (not recommended outside of tests).
   */
  setErrorHandler(handler: ((error: unknown) => void) | null): void {
    this.#errorHandler = handler ?? (() => {});
  }

  /**
   * Emit an event synchronously to every subscribed listener.  Exceptions
   * thrown by listeners are caught and re-thrown asynchronously so that a
   * misbehaving listener cannot prevent other listeners from being notified.
   */
  emit<K extends FontManagerEventName>(
    event: K,
    payload: FontManagerEventMap[K]
  ): void {
    if (this.#subscriptions.length === 0) {
      return;
    }

    // Snapshot the subscriptions that match the event so that mutations
    // performed by listeners don't affect this dispatch.
    const targets = this.#subscriptions
      .filter(sub => sub.event === event)
      .slice();

    this.#dispatching = true;
    try {
      for (const sub of targets) {
        try {
          (sub.listener as EventListener<K>)(payload);
        } catch (error) {
          // Delegate to the configurable error handler so a single broken
          // listener never prevents siblings from running, and the error does
          // not escape as an uncaught exception.
          this.#errorHandler(error);
        }
        if (sub.once) {
          // Schedule removal; don't mutate the array while iterating.
          this.off(sub.event, sub.listener);
        }
      }
    } finally {
      this.#dispatching = false;
      // Flush any pending add/remove operations that were requested from
      // within a listener.
      const pending = this.#pending.splice(0, this.#pending.length);
      for (const apply of pending) {
        apply();
      }
    }
  }

  /**
   * Remove every listener.  Primarily intended for tests and document
   * teardown.
   */
  clear(): void {
    this.#subscriptions.length = 0;
    this.#pending.length = 0;
  }

  /**
   * Returns the number of active listeners for the given event.  When no
   * event is provided the total number of subscriptions is returned.
   */
  listenerCount(event?: FontManagerEventName): number {
    if (event === undefined) {
      return this.#subscriptions.length;
    }
    return this.#subscriptions.filter(sub => sub.event === event).length;
  }

  #add<K extends FontManagerEventName>(
    event: K,
    listener: EventListener<K>,
    once: boolean
  ): () => void {
    const add = (): void => {
      this.#subscriptions.push({
        event,
        listener: listener as EventListener<FontManagerEventName>,
        once,
      });
    };

    if (this.#dispatching) {
      this.#pending.push(add);
    } else {
      add();
    }

    return () => this.off(event, listener);
  }
}
