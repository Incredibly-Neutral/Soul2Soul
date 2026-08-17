# Filecoin/PDP upload-confirm path + browser CORS — architecture findings

Read-only investigation. No code edited. All citations are file:line.

## Scope / runtime reality

The repo is an Obsidian PLUGIN (`@s2s/0xobsidian`, source label `"oxo-core"`). It does
not own an Electron main process. It runs entirely in Obsidian's renderer
(origin `app://obsidian.md`).

- `0xobsidian/esbuild.config.mjs`: `platform:"node"`, `format:"cjs"`,
  `external:["obsidian","electron",...node builtins]`, `define:{global:'window'}`,
  entry `src/main.ts`, outfile `/home/joera/dist/0xobsidian/main.js`.
- No `BrowserWindow` / `webSecurity` / `app.whenReady` anywhere in-repo (grep clean) ->
  we cannot configure Obsidian's BrowserWindow; webSecurity is on and out of our control.

---

## Q1 — TRANSPORT: where the SDK makes HTTP calls

Every Filecoin/PDP HTTP call bottoms out in **`iso-web/http`'s `request()`**, and its
default transport is **`globalThis.fetch` — the renderer's Chromium fetch (CORS-enforced)**.

iso-web (`node_modules/.pnpm/iso-web@3.1.2/node_modules/iso-web/src/http.js`):
- line 251: `fetch = globalThis.fetch.bind(globalThis)` — the transport used unless a
  caller injects `options.fetch`.
- lines 378-420: retry via `pRetry`; line 409-411 retries on network error.
- line 432-452: any non-HTTP failure (incl. a CORS TypeError) is wrapped as
  `NetworkError('Network request failed')`; `is-network-error` classifies Chromium's
  "NetworkError when attempting to fetch resource." message as a network error.

The SDK's SP functions call `request.*` with NO custom fetch, so they use the browser fetch:
- `@filoz/synapse-core@.../src/sp/upload.ts:48` POST `/pdp/piece`; `:79` PUT `/pdp/piece/upload/{uuid}`.
- `@filoz/synapse-core@.../src/sp/find-piece.ts:43` GET `/pdp/piece?...`.
- `@filoz/synapse-core@.../src/sp/add-pieces.ts:58` POST `/pdp/data-sets/{id}/pieces`; `:88`/`:240` status.
- `@filoz/synapse-core@.../src/sp/upload-streaming.ts:53` POST `/pdp/piece/uploads`;
  `:175` PUT `/pdp/piece/uploads/{uuid}`; `:198` POST finalize (the 3-leg upload).

Call chain from our code:
`shared/src/filecoin/index.ts:819-888 uploadCarWithMinCopies`
-> `filecoin-pin/dist/core/upload/synapse.js:30 uploadToSynapse`
-> `:191 synapse.storage.upload`
-> `@filoz/synapse-sdk storage/manager.ts:206 upload`
-> warm-storage -> `uploadPiece / findPiece / addPieces / uploadPieceStreaming` -> iso-web request2 -> browser fetch.

**Confirmed in the built renderer bundle** `/home/joera/dist/0xobsidian/main.js` (~offset 4,396,619):
`async function request2(resource, options={}){ ... fetch: fetch2 = globalThis.fetch.bind(globalThis) ... }` —
iso-web's `request` is inlined as `request2` into the renderer bundle, and the
`Network request failed` + p-retry wrapper are present too.

Verdict Q1: **Browser fetch in the renderer, subject to CORS.** The SDK transport is
effectively hardcoded to `globalThis.fetch` (no caller injects a custom fetch).

---

## Q2 — ELECTRON CONFIG / bridges

- Plugin runs entirely in the Obsidian renderer; there is no in-repo main process.
- The bundle is `platform:node` with `electron` and node builtins external, so at runtime
  the renderer `require('electron')` and node builtins resolve via Obsidian's require shim.
- **An established CORS-escape bridge ALREADY EXISTS in this repo**: requests routed through
  Electron's main-process net module via `electron.remote.net.request`:
  `0xobsidian/src/ipfs/remotekubo.service.ts:9-10` (`const net = electron.remote.net`),
  `:39`, `:87`, ...; `0xobsidian/src/ipfs/pinata.factory.ts:4,70`; `pin.factory.ts`.
  This is exactly how the WORKING public retrieval (IPFS/kubo + Pinata) escapes CORS.
- Keystore similarly reaches privileged APIs: `0xobsidian/src/keystore/keystore.ts:221-222`
  (electron.remote / @electron/remote).
- `contextIsolation`/`nodeIntegration` are Obsidian's renderer settings; plugins get
  `require` for electron/builtins (per above usage). No preload we own; `remote.net` is the usable bridge.

Verdict Q2: Console CORS errors confirm the renderer fetch is browser fetch. The
`electron.remote.net` path is the proven way out (used for Kubo/Pinata today).

---

## Q3 — ESCAPE PATHS (assessed for OUR code, not an SDK fork)

(a) **Swap SDK transport to a non-browser client (undici/node).**
  iso-web `request` accepts `options.fetch` (http.js:251, helpers spread options at
  :540-711), but the synapse-core SP callers never pass it — so it is **not injectable
  through the SDK's public API** as shipped. Patching the SDK (pnpm `patchedDependencies`
  or a vendored `@filoz/synapse-core`) would be required to pass a custom fetch down.
  => requires SDK patch OR global override (see d).

(b) **Route Filecoin HTTP through an Electron main/preload bridge.**
  A dedicated `ipcMain` handler would need Obsidian's main process — not owned, not available.
  BUT `electron.remote.net` is an existing in-repo bridge that already escapes CORS for
  Kubo/Pinata. Routing Filecoin PDP traffic through it (via a small custom fetch built on
  `electron.remote.net.request`) is feasible and stays 100% in our code.
  => available, in-repo, but needs a fetch shim.

(c) **`webSecurity:false`.** Not available — we don't own Obsidian's BrowserWindow (no
  in-repo main). Would also be dangerous; do not pursue.

(d) **Other — strongest in-repo option: globally inject a CORS-free fetch.**
  iso-web binds `globalThis.fetch` at CALL time (http.js:251 default param), so if we
  replace `globalThis.fetch` (i.e. `window.fetch`) with a CORS-free implementation **before**
  the Filecoin upload, iso-web picks it up with **no SDK patch**. Build the replacement on the
  existing `electron.remote.net` (or node `https`, already used for the Kubo export in
  `0xobsidian/src/filecoin/filecoin.ctrlr.ts exportTreeFromKubo`) and return a WHATWG
  `Response` (available in the renderer) so iso-web's `.ok/.status/.headers/.text()/.clone()`
  contract holds. Caveats: must handle the `Request` object + streaming body
  (`upload-streaming.ts:145-180`, `duplex:'half'`) iso-web constructs; scope the override to
  the Filecoin op and fall back to native fetch otherwise so other plugin HTTP is unaffected.

Files that would change (all in our repo): `shared/src/filecoin/index.ts` (install/restore a
`window.fetch` shim at the top of `uploadCarWithMinCopies`), or a new
`0xobsidian/src/filecoin/fetch-shim.ts` wired via the controller; no SDK edits required.

---

## Q4 — VERDICT

Is the user's representation accurate?
- YES. The SDK's PDP HTTP transport is renderer `globalThis.fetch`; CORS (a browser-only
  mechanism) rejects the cross-origin response because the SP response lacks
  `Access-Control-Allow-Origin`, which is why a 201/204/200 still arrives as
  `NetworkError: Network request failed` (Chromium CORS error is classified as a network
  error and retried by pRetry). The "producers effectively choose public vs private access
  via ACAO" framing is accurate: a provider that doesn't emit ACAO is unreadable to browser
  fetch.
- The "HTTP transport works fine elsewhere" claim is also accurate — but only because the
  non-Filecoin paths (IPFS/kubo, Pinata) go through `electron.remote.net`, not browser fetch.
  The Filecoin path alone uses browser fetch, which is the divergence.

Can the Filecoin confirm path be moved out of browser-CORS scope from within this repo?
- YES. Because iso-web resolves `globalThis.fetch` at call time, overriding `window.fetch`
  with a CORS-free transport built on the existing `electron.remote.net` pattern (or node
  `https`) — done around the Filecoin upload in our shared/Obsidian code — moves it out of
  browser-CORS scope **without forking the SDK**. The only scenario that requires touching
  `@filoz/synapse-core` is insisting on injecting a custom fetch through the SDK's request
  options, which the shipped callers don't expose. So: not architecturally stuck.

Key resolved paths
- iso-web transport: node_modules/.pnpm/iso-web@3.1.2/node_modules/iso-web/src/http.js:251
- SDK SP calls: @filoz/synapse-core@0.7.0/.../src/sp/{upload,find-piece,add-pieces,upload-streaming}.ts
- our upload path: shared/src/filecoin/index.ts:819-888
- bundler config: 0xobsidian/esbuild.config.mjs
- existing CORS escape: 0xobsidian/src/ipfs/remotekubo.service.ts:9-10 (electron.remote.net)
- built renderer bundle: /home/joera/dist/0xobsidian/main.js (request2, globalThis.fetch.bind)
