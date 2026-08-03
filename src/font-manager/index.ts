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
 * @module font-manager
 *
 * Public entry point (barrel) for the FontManager subsystem. Importing from
 * here gives JS *and* TS callers the singleton plus every public type.
 *
 * Typical usage from existing JavaScript (post-compile):
 *
 *   import { FontManager } from "pdfjs/font-manager/index.js";
 *   const fm = FontManager.getInstance();
 *   await fm.configure({ cMapUrl, cMapPacked, standardFontDataUrl,
 *                        binaryDataFactory });
 *   const cmap = await fm.loadCMap("Adobe-Japan1-UCS2");
 *   const chain = fm.resolveFallback(descriptor);
 */

export { FontManager } from "./font-manager.js";
export { FontEventBus } from "./event-bus.js";
export { FontCache } from "./font-cache.js";
export { CMapLoader } from "./cmap-loader.js";
export { FallbackResolver } from "./fallback-resolver.js";

export type {
  BinaryDataFactoryLike,
  BinaryDataKind,
  BinaryDataKindLabelMap,
  BinaryDataRequest,
  CacheNamespace,
  CacheStats,
  CacheValueMap,
  CMapLoaderConfig,
  CMapPreloadStrategy,
  FallbackChain,
  FallbackEntry,
  FallbackSource,
  FontDescriptor,
  FontEventListener,
  FontEventListenerOptions,
  FontEventMap,
  FontEventName,
  FontManagerOptions,
  FontProgramType,
  GenericFontFamily,
  LoadedCMap,
} from "./types.js";
