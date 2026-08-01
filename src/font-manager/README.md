# FontManager subsystem

A unified, strongly-typed (TypeScript, **zero `any`**) font & CMap management
layer for PDF.js. It centralizes logic that was previously spread across the
core/display layers and addresses three problems called out for this refactor:

1. **Scattered font logic → one manager.** A singleton `FontManager` is the
   single composition/lifecycle entry point.
2. **Synchronous/blocking CMap loading → async, on-demand.** `CMapLoader` fetches
   CMaps asynchronously with a configurable **preload strategy**
   (`eager` / `lazy` / `manual`) and single-flight de-duplication.
3. **Naïve fallback → a smart fallback chain.** `FallbackResolver` produces an
   ordered chain that is *guaranteed* to terminate in a generic CSS family, so
   text can never render as "nothing".

Plus: a per-namespace **LRU cache**, a **typed event bus**, and **API
compatibility** with the existing pipeline.

## Architecture (single responsibility per file)

| File | Responsibility |
|------|----------------|
| `types.ts` | All shared types. Every "kind"/event name has a **concrete mapping** interface (`BinaryDataKindLabelMap`, `CacheValueMap`, `FontEventMap`). |
| `event-bus.ts` | `FontEventBus` — typed pub/sub, mirrors `web/event_utils.js` `on/off/dispatch` semantics (`signal`, `once`). |
| `font-cache.ts` | `FontCache` — namespaced, capacity-bounded LRU with stats. |
| `cmap-loader.ts` | `CMapLoader` — async on-demand CMap loading + preload strategy. |
| `fallback-resolver.ts` | `FallbackResolver` — embedded → substitution → standard-14 → generic. |
| `font-manager.ts` | `FontManager` — the singleton facade wiring the above together. |
| `index.ts` | Public barrel export. |

## Why this preserves API compatibility

- `configure()` accepts the **same option names** the viewer already passes to
  `getDocument`: `cMapUrl`, `cMapPacked`, `standardFontDataUrl`, plus a
  `binaryDataFactory` implementing the existing
  `fetch({ kind, filename }) → Promise<Uint8Array>` contract. The current
  `DOMBinaryDataFactory` / `NodeBinaryDataFactory` satisfy this as-is.
- The event bus intentionally matches the viewer `EventBus` method shape.
- Output is emitted as **ES2022 JS + `.d.ts`**, so it drops into the existing
  webpack/babel build and is consumable from plain `.js` with full types.

## Usage

```js
import { FontManager } from "pdfjs/font-manager/index.js";

const fm = FontManager.getInstance();
await fm.configure({
  cMapUrl: "/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/standard_fonts/",
  cMapPreloadStrategy: "eager",
  cMapPreloadNames: ["Adobe-Japan1-UCS2"],
  binaryDataFactory, // existing DOM/Node factory
});

const cmap  = await fm.loadCMap("Adobe-Japan1-UCS2");     // async, cached
const chain = fm.resolveFallback(descriptor);              // smart fallback
fm.on("cmapLoaded", ({ name, fromCache }) => { /* ... */ });
```

## Build, lint & test (regression flow)

From this directory (requires a local TypeScript; `../../node_modules/.bin/tsc`):

```bash
# 1. Enforce "no explicit any" (implicit any is already blocked by tsconfig).
node check-no-any.mjs

# 2. Strict compile → dist/ (JS + .d.ts + source maps).
../../node_modules/.bin/tsc -p tsconfig.json

# 3. Run the preserved regression suite against the compiled output.
node --test test/font-manager.test.mjs
```

All 27 regression tests cover the singleton, async/preload CMap loading,
single-flight de-dup, the fallback chain invariants, cache hits/eviction, the
typed event bus, and factory API-compatibility.
