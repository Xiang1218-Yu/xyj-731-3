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
 * Integration regression tests for the FontManager transport adapter.
 *
 * These simulate the *live* PDF.js seam: the transport's `FetchBinaryData`
 * handler calls `binaryDataFactory.fetch({ kind, filename })`. We prove that
 * wrapping a real-shaped factory with the adapter preserves that contract while
 * adding caching, single-flight de-duplication, and lifecycle events.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { FontManager } from "../dist/index.js";

/**
 * A stand-in for `DOMBinaryDataFactory` / `NodeBinaryDataFactory`: it exposes
 * the exact `fetch({ kind, filename })` contract and records every call.
 */
class RealFactoryStub {
  constructor(bytesByKey = {}) {
    this.bytesByKey = bytesByKey;
    this.calls = [];
  }

  async fetch({ kind, filename }) {
    this.calls.push({ kind, filename });
    const bytes = this.bytesByKey[`${kind}:${filename}`];
    if (!bytes) {
      throw new Error(`Unable to load ${kind} data at: ${filename}`);
    }
    return bytes;
  }
}

describe("FontManager transport adapter (live integration seam)", () => {
  beforeEach(() => FontManager.resetInstanceForTesting());

  it("returns a drop-in factory satisfying the fetch contract", async () => {
    const fm = FontManager.getInstance();
    const real = new RealFactoryStub({
      "cMapUrl:Adobe-Japan1-UCS2.bcmap": new Uint8Array([1, 2]),
    });
    const adapter = fm.createBinaryDataFactoryAdapter(real);
    assert.equal(typeof adapter.fetch, "function");

    const bytes = await adapter.fetch({
      kind: "cMapUrl",
      filename: "Adobe-Japan1-UCS2.bcmap",
    });
    assert.deepEqual(bytes, new Uint8Array([1, 2]));
    assert.deepEqual(real.calls, [
      { kind: "cMapUrl", filename: "Adobe-Japan1-UCS2.bcmap" },
    ]);
  });

  it("caches identical requests (real factory hit once)", async () => {
    const fm = FontManager.getInstance();
    const real = new RealFactoryStub({
      "standardFontDataUrl:FoxitSans.pfb": new Uint8Array([9]),
    });
    const adapter = fm.createBinaryDataFactoryAdapter(real);
    await adapter.fetch({ kind: "standardFontDataUrl", filename: "FoxitSans.pfb" });
    await adapter.fetch({ kind: "standardFontDataUrl", filename: "FoxitSans.pfb" });
    assert.equal(real.calls.length, 1);
  });

  it("de-duplicates concurrent identical requests (single-flight)", async () => {
    const fm = FontManager.getInstance();
    const real = new RealFactoryStub({
      "wasmUrl:openjpeg.wasm": new Uint8Array([4, 5, 6]),
    });
    const adapter = fm.createBinaryDataFactoryAdapter(real);
    const [a, b] = await Promise.all([
      adapter.fetch({ kind: "wasmUrl", filename: "openjpeg.wasm" }),
      adapter.fetch({ kind: "wasmUrl", filename: "openjpeg.wasm" }),
    ]);
    assert.deepEqual(a, new Uint8Array([4, 5, 6]));
    assert.deepEqual(b, new Uint8Array([4, 5, 6]));
    assert.equal(real.calls.length, 1);
  });

  it("does not collide across kinds sharing a filename", async () => {
    const fm = FontManager.getInstance();
    const real = new RealFactoryStub({
      "cMapUrl:shared": new Uint8Array([1]),
      "standardFontDataUrl:shared": new Uint8Array([2]),
    });
    const adapter = fm.createBinaryDataFactoryAdapter(real);
    const cmap = await adapter.fetch({ kind: "cMapUrl", filename: "shared" });
    const font = await adapter.fetch({
      kind: "standardFontDataUrl",
      filename: "shared",
    });
    assert.deepEqual(cmap, new Uint8Array([1]));
    assert.deepEqual(font, new Uint8Array([2]));
    assert.equal(real.calls.length, 2);
  });

  it("emits binaryFetched with fromCache transitions", async () => {
    const fm = FontManager.getInstance();
    const real = new RealFactoryStub({
      "cMapUrl:Foo.bcmap": new Uint8Array([7]),
    });
    const events = [];
    fm.on("binaryFetched", e => events.push(e));
    const adapter = fm.createBinaryDataFactoryAdapter(real);
    await adapter.fetch({ kind: "cMapUrl", filename: "Foo.bcmap" });
    await adapter.fetch({ kind: "cMapUrl", filename: "Foo.bcmap" });
    assert.equal(events.length, 2);
    assert.equal(events[0].fromCache, false);
    assert.equal(events[0].byteLength, 1);
    assert.equal(events[1].fromCache, true);
  });

  it("propagates real-factory errors unchanged", async () => {
    const fm = FontManager.getInstance();
    const real = new RealFactoryStub(); // empty -> every fetch rejects
    const adapter = fm.createBinaryDataFactoryAdapter(real);
    await assert.rejects(
      () => adapter.fetch({ kind: "cMapUrl", filename: "missing.bcmap" }),
      /Unable to load cMapUrl data/
    );
    // A later successful fetch is still possible (in-flight entry cleared).
    real.bytesByKey["cMapUrl:missing.bcmap"] = new Uint8Array([1]);
    const bytes = await adapter.fetch({
      kind: "cMapUrl",
      filename: "missing.bcmap",
    });
    assert.deepEqual(bytes, new Uint8Array([1]));
  });
});
