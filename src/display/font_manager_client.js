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
 * Main-thread bridge for the TypeScript FontManager sub-system.
 *
 * On the main thread FontManager is not responsible for fetching resources
 * (that happens inside the worker).  Instead it acts as the event-bus endpoint
 * that viewer / business code subscribes to.  Worker-side font lifecycle
 * events are forwarded over the `MessageHandler` and re-emitted on the
 * main-thread FontManager's strongly typed event bus.
 */

import { FontManager } from "../shared/font_manager/dist/index.js";

let gMainThreadManager = null;

/**
 * Return the process-wide main-thread FontManager.  It is initialised lazily
 * and never needs a fetcher because the worker is the authority for resource
 * loading.
 *
 * @returns {FontManager}
 */
function getMainThreadFontManager() {
  if (!gMainThreadManager) {
    gMainThreadManager = FontManager.getInstance();
    gMainThreadManager.init({});
  }
  return gMainThreadManager;
}

/**
 * Forward a worker-originated FontManager event to the main-thread event bus.
 *
 * @param {{eventName: string, payload: object}} data - The payload of the
 *   `FontManagerEvent` message.
 */
function dispatchWorkerEvent(data) {
  if (!data || typeof data.eventName !== "string") {
    return;
  }
  const manager = getMainThreadFontManager();
  manager.dispatchWorkerEvent(data.eventName, data.payload);
}

export { dispatchWorkerEvent, getMainThreadFontManager };
