# safe-app QA — headless verification harness

`qa/qa.mjs` verifies the **production build** inside a mocked Safe iframe, using
Playwright + Chromium. It exists to catch the "tabs don't switch" class of
regression — a silent reactivity failure (e.g. the `useDefineForClassFields`
bug) that no build error surfaces and that can't be seen outside a Safe iframe.

## What it checks (functional only)

- the app boots and renders `s2s-app`
- all 5 nav tabs render **enabled** (Agreements / Whitelists / Records / Storage / Website-Tree)
- clicking each tab switches the **active tab** AND swaps the rendered component
- no uncaught page errors

No typography/style assertions — that's a design pass, not a regression test.

## How it works

The Safe iframe handshake is mocked via `context.addInitScript`: it intercepts
`window.parent.postMessage` and answers `getSafeInfo` with the protocol's real
Safe (`0x24936f...20c6B`, chainId 8453 / Base) and its Publication + Records
modules. So `SafeAppsSDK.getInfo()` resolves, tabs become enabled, and module
detection runs against real RPC — no Safe UI, no wallet needed.

## Usage

```sh
pnpm qa                        # build (if dist/ missing) + preview + probe
PROBE_URL=http://host:port pnpm qa   # probe an already-running server
QA_PORT=4175 pnpm qa           # different preview port (default 4174)
```

- Exit `0` = all checks passed; `1` = a check failed; `2` = harness error
  (server didn't start, etc.).
- The preview server is spawned with `--no-open` (the vite config sets
  `preview.open: true`, which fails headless) and is killed on exit.

## One-time setup

```sh
pnpm install                 # brings in the playwright devDependency
npx playwright install chromium   # downloads the browser (cached in ~/.cache/ms-playwright)
```

## Gotchas baked into this workflow

- **`useDefineForClassFields: false` is required** in `tsconfig.json` — with it
  `true` (the ES2022 default), Lit's `@state`/`@property` decorators are
  shadowed by own class fields and reactive re-renders silently stop (the tab
  bug). If tabs stop switching, check this first.
- **`//` comments inside `css` template literals break the rule they precede** —
  Lit's `css` tag does not strip them here, and the garbage token swallows the
  next declaration (hit with `--font-mono-family`). Use `/* */` or no comment.
- **`pnpm dev` is broken** (ethers v5/v6 dedupe in `shared/src/identity`) —
  production build is unaffected; always verify against `pnpm build` + preview.
- **`vite preview` auto-opens a browser** (`preview.open: true`) — pass
  `--no-open` when headless.
