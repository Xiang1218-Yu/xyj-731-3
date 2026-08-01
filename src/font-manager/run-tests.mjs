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
 * Preserved regression flow for the FontManager subsystem.
 *
 * This is the single, reproducible entry point for the whole verification
 * pipeline so the flow is no longer a set of ad-hoc shell commands. It runs, in
 * order and fail-fast:
 *
 *   1. `check-no-any.mjs`  — enforce the "no explicit any" rule.
 *   2. `tsc -p tsconfig`   — strict compile of the TS sources → ./dist.
 *   3. `node --test`       — the preserved regression test suite (./test).
 *
 * Run it via:  npm run test:font-manager     (from the repo root)
 *          or:  node run-tests.mjs            (from this directory)
 *
 * Any step's failure aborts the run with a non-zero exit code, so it is safe to
 * wire into CI / pre-commit.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve the local TypeScript compiler, preferring the repo's node_modules. */
function resolveTsc() {
  const candidates = [
    join(here, "..", "..", "node_modules", ".bin", "tsc"),
    join(here, "node_modules", ".bin", "tsc"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  // Fall back to a PATH lookup (e.g. a globally installed tsc).
  return "tsc";
}

/**
 * Run one pipeline step, streaming its output. Returns on success; throws with
 * a descriptive message (and the child's exit code) on failure.
 */
function step(label, command, args) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(command, args, {
    cwd: here,
    stdio: "inherit",
    // `shell: true` lets Windows resolve the `.cmd` shim for local bins.
    shell: process.platform === "win32",
  });
  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}.`);
  }
  if (result.signal) {
    throw new Error(`${label} terminated by signal ${result.signal}.`);
  }
}

try {
  step("1/3 no-any lint", process.execPath, [join(here, "check-no-any.mjs")]);
  step("2/3 strict compile", resolveTsc(), ["-p", join(here, "tsconfig.json")]);
  step("3/3 regression tests", process.execPath, [
    "--test",
    join(here, "test", "font-manager.test.mjs"),
  ]);
  process.stdout.write("\nFontManager regression flow: ALL STEPS PASSED.\n");
} catch (error) {
  process.stderr.write(`\nFontManager regression flow FAILED: ${error.message}\n`);
  process.exit(1);
}
