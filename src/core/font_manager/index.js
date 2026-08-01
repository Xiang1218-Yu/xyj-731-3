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
 * 字体管理中心的公共入口（桶文件）。
 *
 * JS 调用方推荐从此文件导入：
 *   `import { FontManager } from "./font_manager/index.js";`
 * 类型导入（仅 TS 调用方需要）同样从此文件导出。
 */
export { COMMON_BUILT_IN_CMAPS, AsyncCMapLoader } from "./cmap_loader.js";
export { FontEventBus } from "./event_bus.js";
export { FontFallbackChain } from "./fallback_chain.js";
export { FontManager } from "./font_manager.js";
export { LruCache } from "./lru_cache.js";
