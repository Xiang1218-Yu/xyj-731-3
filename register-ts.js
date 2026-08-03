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
 * Registers an ESM resolve hook that allows TypeScript source files to be
 * executed directly in Node.js without a build step.
 *
 * When importing a relative path with a `.js` extension where no `.js` file
 * exists but a corresponding `.ts` file does, the hook resolves to the `.ts`
 * file. This enables the TypeScript convention of writing
 * `import x from "./y.js"` while the source file is actually `y.ts`.
 *
 * Usage:
 *   node --experimental-strip-types --import ./register-ts.js <script>
 *
 * The webpack/babel build pipeline handles extension resolution automatically
 * via extensionAlias; this hook is only for direct Node.js execution.
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(__dirname, "register-ts-hook.mjs")).href);
