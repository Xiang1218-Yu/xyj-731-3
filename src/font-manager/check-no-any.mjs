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
 * Static guard: fail if any `.ts` source uses an `any` type.
 *
 * `strict`/`noImplicitAny` in tsconfig already forbids *implicit* any; this
 * additionally forbids *explicit* `any` (`: any`, `as any`, `<any>`,
 * `Array<any>`, etc.) so the "no any" requirement is enforced mechanically.
 *
 * Run with:  node check-no-any.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Recursively collect every `.ts` file under `dir`, skipping `dist`. */
function collectTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "dist" || entry === "node_modules") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// Matches the `any` keyword as a whole word used as a type, e.g. `: any`,
// `as any`, `<any>`, `any[]`, `Array<any>`. It will not match identifiers that
// merely contain the letters "any" (e.g. `many`, `anyOf`).
const ANY_RE = /(?<![A-Za-z0-9_$])any(?![A-Za-z0-9_$])/;

/** Strip comments from a single line so `any` inside prose is not flagged. */
function stripComments(line) {
  // Remove inline block comments `/* ... */` and trailing line comments `// ...`.
  return line.replaceAll(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
}

const offenders = [];
for (const file of collectTsFiles(here)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // Ignore full comment lines (`//`, `*`, `/*`, `/**`).
    if (
      trimmed.startsWith("*") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*")
    ) {
      return;
    }
    if (ANY_RE.test(stripComments(line))) {
      offenders.push(`${file}:${i + 1}: ${trimmed}`);
    }
  });
}

if (offenders.length > 0) {
  console.error("Found forbidden `any` usage:\n" + offenders.join("\n"));
  process.exit(1);
}
console.log("check-no-any: OK — no `any` types found.");
