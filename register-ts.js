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
 * Node.js ESM resolve hook that allows TypeScript source files to be executed
 * directly in Node.js without a build step.
 *
 * When importing a relative path with a `.js` extension where no `.js` file
 * exists but a corresponding `.ts` file does, this hook resolves to the `.ts`
 * file. This enables the TypeScript convention of writing `import x from "./y.js"`
 * while the source file is actually `y.ts`.
 *
 * Usage:
 *   node --experimental-strip-types --import ./register-ts.js <script>
 *
 * This hook is only needed for direct Node.js execution of TypeScript source
 * files. The webpack/babel build pipeline handles extension resolution
 * automatically via extensionAlias.
 */

import { existsSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, resolve as pathResolve } from "path";

/**
 * Register the resolve hook globally.
 * Call this once at the entry point.
 */
export function register() {
  if (typeof register._registered !== "undefined") {
    return;
  }
  register._registered = true;

  // Use Node's module register API if available (Node 20.6+).
  if (typeof globalThis.process?.version === "string") {
    // The hook is installed by importing this module with --import.
    // No additional action needed if using the hook below.
  }
}

/**
 * ESM resolve hook.
 * Intercepts relative specifiers ending in .js and checks if a .ts source
 * file exists instead.
 */
export async function resolve(specifier, context, nextResolve) {
  // Only intercept relative/absolute specifiers with .js extension.
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

      // If the .js file doesn't exist but a .ts file does, redirect to .ts.
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

// Auto-register when imported.
register();
