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

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

/**
 * ESM resolve hook: when a relative `./x.js` specifier has no corresponding
 * `.js` file but a `.ts` source exists, redirect to the `.ts` file.
 */
export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      specifier.startsWith("/")) &&
    specifier.endsWith(".js")
  ) {
    const parentURL = context.parentURL;
    if (parentURL) {
      const parentPath = fileURLToPath(parentURL);
      const parentDir = dirname(parentPath);
      const resolvedPath = pathResolve(parentDir, specifier);

      if (!existsSync(resolvedPath)) {
        const tsPath = resolvedPath.slice(0, -3) + ".ts";
        if (existsSync(tsPath)) {
          return nextResolve(pathToFileURL(tsPath).href, context);
        }
      }
    }
  }

  return nextResolve(specifier, context);
}
