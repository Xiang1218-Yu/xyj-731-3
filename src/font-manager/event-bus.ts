/* Copyright 2024 Mozilla Foundation
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
 * @module font-manager/event-bus
 *
 * A strongly-typed event bus for the FontManager subsystem.
 *
 * Single responsibility: publish/subscribe. It owns no font logic.
 *
 * API compatibility: the `on` / `off` / `dispatch` method names and the
 * `{ signal, once }` option semantics intentionally mirror the viewer's
 * `web/event_utils.js` `EventBus`, so existing code & mental models transfer
 * directly. The difference is that this bus is *generic over*
 * {@link FontEventMap}: the compiler verifies that each event name is paired
 * with exactly its declared payload — eliminating stringly-typed dispatch and
 * any use of `any`.
 */

import type {
  FontEventListener,
  FontEventListenerOptions,
  FontEventMap,
  FontEventName,
} from "./types.js";

/** Internal bookkeeping for a single registered listener. */
interface ListenerRecord<K extends FontEventName> {
  /** The user-supplied callback. */
  readonly listener: FontEventListener<K>;
  /** Remove the first time it fires. */
  readonly once: boolean;
  /** Detaches the paired AbortSignal handler, if any. */
  readonly removeAbort: (() => void) | null;
}

/**
 * A minimal, dependency-free, type-safe event emitter.
 *
 * We store listeners in a `Map` keyed by event name. The value is an array of
 * {@link ListenerRecord}; we type it as `ListenerRecord<FontEventName>[]`
 * because a single map cannot preserve the per-key generic — the *public*
 * methods re-establish the precise type via their `K extends FontEventName`
 * signatures, so callers still get full checking.
 */
export class FontEventBus {
  readonly #listeners = new Map<
    FontEventName,
    Array<ListenerRecord<FontEventName>>
  >();

  /**
   * Subscribe to `eventName`. The `listener` payload type is inferred from
   * {@link FontEventMap}.
   *
   * @param eventName The event to listen for.
   * @param listener  Callback invoked with the event's typed payload.
   * @param options   Optional `{ signal, once }` — same contract as the viewer.
   */
  on<K extends FontEventName>(
    eventName: K,
    listener: FontEventListener<K>,
    options?: FontEventListenerOptions
  ): void {
    let removeAbort: (() => void) | null = null;

    const signal = options?.signal;
    if (signal) {
      if (signal.aborted) {
        // Match event_utils.js: refuse an already-aborted signal.
        return;
      }
      const onAbort = (): void => this.off(eventName, listener);
      signal.addEventListener("abort", onAbort);
      removeAbort = (): void => signal.removeEventListener("abort", onAbort);
    }

    const records = this.#listeners.get(eventName) ?? [];
    // The cast is safe: we only ever read this record back through the same
    // `eventName`, whose `K` is fixed. It never leaks a wrong payload type.
    records.push({
      listener: listener as FontEventListener<FontEventName>,
      once: options?.once === true,
      removeAbort,
    });
    this.#listeners.set(eventName, records);
  }

  /**
   * Unsubscribe a previously-registered `listener` from `eventName`. Also tears
   * down any AbortSignal wiring so no listener leaks.
   */
  off<K extends FontEventName>(
    eventName: K,
    listener: FontEventListener<K>
  ): void {
    const records = this.#listeners.get(eventName);
    if (!records) {
      return;
    }
    for (let i = 0; i < records.length; i++) {
      if (records[i].listener === listener) {
        records[i].removeAbort?.();
        records.splice(i, 1);
        break;
      }
    }
    if (records.length === 0) {
      this.#listeners.delete(eventName);
    }
  }

  /**
   * Emit `eventName` with its typed `payload`. Listeners are invoked against a
   * *copy* of the current list, so a listener that (un)subscribes during
   * dispatch cannot corrupt the in-progress iteration — matching the viewer's
   * `dispatch` behaviour.
   */
  dispatch<K extends FontEventName>(
    eventName: K,
    payload: FontEventMap[K]
  ): void {
    const records = this.#listeners.get(eventName);
    if (!records || records.length === 0) {
      return;
    }
    for (const record of records.slice(0)) {
      if (record.once) {
        this.off(eventName, record.listener as FontEventListener<K>);
      }
      // Cast is sound: the record was stored under `eventName`, so its listener
      // expects `FontEventMap[K]`, which is exactly `payload`'s type.
      (record.listener as FontEventListener<K>)(payload);
    }
  }

  /** Remove every listener (used by {@link FontManager.reset}). */
  clear(): void {
    for (const records of this.#listeners.values()) {
      for (const record of records) {
        record.removeAbort?.();
      }
    }
    this.#listeners.clear();
  }

  /** Number of listeners currently registered for `eventName` (diagnostics). */
  listenerCount(eventName: FontEventName): number {
    return this.#listeners.get(eventName)?.length ?? 0;
  }
}
