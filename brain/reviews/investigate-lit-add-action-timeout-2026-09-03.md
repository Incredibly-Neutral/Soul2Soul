# Investigation — `pnpm actions:swap prep` hangs ~300s (HeadersTimeoutError on `/add_action`)

**Date:** 2026-09-03
**Author:** DeepSeek V4 Flash 0731 (synthesized from builder explore)
**Mode:** read-only `explore` — no source edited, no PR opened.
**Repo state:** `/home/joera/code/s2s`, branch `main`, HEAD `d1cbbf8`.

## Symptom
`pnpm actions:swap prep` (→ `tsx --require dotenv/config protocol/scripts/lit/swap-action.ts prep`) hangs ~300s then throws:

```
[RENDER-DEBUG] lit fetch begin endpoint=/add_action method=POST
[RENDER-DEBUG] lit fetch THREW (network) endpoint=/add_action elapsed=300836ms errType=TypeError
TypeError: fetch failed  [cause]: HeadersTimeoutError ... code: 'UND_ERR_HEADERS_TIMEOUT'
    at async LitService.call (shared/dist/lit/lit.service.js:52:24)
    at async LitService.registerAction (shared/dist/lit/lit.service.js:167:24)
    at async Promise.all (index 0) (protocol/scripts/lit/swap-action.ts:52:20)
```

300836ms ≈ undici's DEFAULT headers timeout (300s). `LitService.call` has no explicit
timeout (the `callWithTimeout`/`withRetry` helpers are commented out) → any stalled
Lit endpoint blocks the full 5 minutes.

## Topology
- **PROD base URL:** `https://api.chipotle.litprotocol.com/core/v1` — `swap-action.ts`
  hardcodes `environment: 'prod'`; no env override.
- **Failing endpoint:** `POST /core/v1/add_action` via `LitService.registerAction`,
  body `{"action_ipfs_cid":"<prep CID>","name":"prep","description":"prep"}`,
  header `X-Api-Key: <LIT_ACCOUNT_KEY>` (repo-root `./.env`).
- Runtime artifact `shared/dist/lit/lit.service.js` matches src (same URLs, same
  `[RENDER-DEBUG]`, no timeout). Node v22.23.1, no proxy env vars.

## Verdict — Upstream Lit API degradation on `/add_action` (NOT a repo regression, NOT local network)

- Host itself fast: 5× POST `{}` + 5× GET base all return in ~0.9–2.0s (404 expected on bare path).
  Authenticated GETs ~0.7s (`/get_node_chain_config`, `/list_wallets`), another POST ~0.84s.
- `POST /add_action` (exact payload, short cap): across 9 total attempts → 3 slow-success
  (~8.1s) and **6 hard timeouts** (0 bytes, ttfb=0.000, past 15–25s). Persistent degradation,
  never fast.
- TCP (~0.23s) and TLS (~0.7s) always succeed → request reaches server, response headers
  never arrive → server-side slowness in the action-registration handler (likely on-chain/IPFS work).
- Dev host `api.dev.litprotocol.com` fails TLS outright (3/3 SSL_ERROR_SYSCALL) — broader
  upstream Lit infrastructure trouble, but user issue is specifically prod `/add_action`.
- DNS fast/stable: `api.chipotle.litprotocol.com -> 66.220.6.102`, dev -> 66.220.6.105 (phala.network).

## Relevant git state
- **No repo regression.** Chipotle base URL last changed in `74ee217` (old). No recent change to
  fetch path, base URL, undici/tsx versions. Dist == src.
- **Unrelated working-tree change:** `protocol/scripts/lit/config.json` has an **uncommitted**
  diff swapping `prep`/`render`/`update`/`maintain-cache` CIDs (plus earlier `05ce3d0` rotation).
  This is about which CIDs are authorized — it does NOT cause the network hang. Same class as
  `investigate-lit403-2026-08-31.md` (but that was a 403, this is a stall).
- Contributing factor: no explicit timeout in `call()` → stalled Lit endpoint blocks 300s.

## Recommended next steps (NOT implemented)
1. **No code fix needed — upstream.** Re-run `pnpm actions:swap prep`; retry if it stalls
   (a success returns in ~8s). Contact Lit support re `/add_action` latency.
2. **Robustness (genuine improvement):** add explicit short timeout + retry to `call()` in
   `lit.service.ts` (e.g. `AbortSignal.timeout(20_000)` + a couple retries) so a stalled
   Lit endpoint fails fast instead of blocking 300s.
3. Re-verify after recovery:
   `curl --max-time 20 -X POST https://api.chipotle.litprotocol.com/core/v1/add_action -H 'Content-Type: application/json' -H "X-Api-Key: $LIT_ACCOUNT_KEY" --data '{"action_ipfs_cid":"<prep CID>","name":"prep","description":"prep"}' -w 'ttfb=%{time_starttransfer}s\n'` — expect `ttfb < 2s` when healthy.
4. Mind INV-8 group/records sync before running `update-protocol` given the uncommitted CID swaps
   (see `investigate-lit403-2026-08-31.md`).
