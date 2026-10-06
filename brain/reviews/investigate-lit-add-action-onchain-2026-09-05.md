# Investigation supplement — Lit Core API is on-chain-backed on Base; action registry read is reverting

**Date:** 2026-09-05
**Author:** DeepSeek V4 Flash 0731 (synthesized from direct probes; workers unavailable this run)
**Mode:** read-only — no source edited, no PR opened.
**Repo state:** `/home/joera/code/s2s` (main). Supplements `investigate-lit-add-action-timeout-2026-09-03.md`.

## Why this exists
Lit team asked to confirm (a) API vs ChainSecured, (b) did the writes land, then asked what
`/add_action` does on their end and how it could fail. This note adds the on-chain finding and
re-confirms content is not the cause.

## New findings (live-probed 2026-09-05, all fast/healthy calls unless noted)

1. **Lit Core API is backed by on-chain state on Base.**
   `GET /core/v1/get_node_chain_config` (healthy) → `{"chain_name":"Base","chain_id":8453,
   "is_evm":true,"testnet":false,"token":"ETH","contract_address":"0xaaaaa9120fe271f653cfdb6bf400db93d2dea7aa"}`.
   That `0xaaaaa…` vanity address is Lit's contract layer on Base.

2. **`/add_action` is an "Account Management" op** (per the API's own OpenAPI, fetched from
   `GET /core/v1/openapi.json`). Request `{action_ipfs_cid, name, description}`; the schema
   explicitly notes the CID is **keccak256-hashed on the server** (matches the local `hashedCid`
   that `swap-action.ts` computes). Response is `{success: bool}`. It is NOT group-scoped — group
   binding is a separate endpoint `/add_action_to_group`. So the hang is at global registration,
   before any group context (answers "not the specific group").

3. **The API's action-registry READ (`list_actions`) is deterministically reverting right now.**
   `GET /core/v1/list_actions?page_number=0&page_size=100` with `X-Api-Key` returns 500, 3/3
   (fast, 183–915ms): `list_actions failed: server returned an error response: error code 3:
   execution reverted, data: "0xd4a84737019726c6babc1de231f26fd6cbb2df2c912784a2e1ba55295496269a6d3ff651"`.
   - Not a format artifact: `?page_number/…` passes validation then reverts; wrong param names → 422.
   - `0xd4a84737` is an EVM custom-error selector (keccak verified correct; not in a large
     brute-forced candidate list of common Lit-style error names — left undecoded, citable as-is;
     also absent from the public 4byte registry → consistent with a private contract custom error).
   - **PRECISION BOUNDARY:** this is the API relaying an EVM revert from its backend, NOT a direct
     `eth_call` to the Base contract made by us. We could not independently reproduce the revert
     chain-side because the ABI/function selector that `list_actions` invokes is not available
     (Etherscan V2 requires an API key; 4byte has no entry). So "the contract itself reverts" is
     strongly implied but NOT independently confirmed. To close it: get a block-explorer key (or
     the contract ABI from the Lit team) and `eth_call` the exact function directly.

## On-chain architecture finding (2026-09-05, direct eth_getCode on Base)
- `0xaaaaa9120fe271f653cfdb6bf400db93d2dea7aa` is a **selector-routing proxy**, not the registry:
  runtime bytecode ≈194 bytes, zero dispatcher logic. It reads the 4-byte selector, looks it up in a
  routing map at storage slot `0xc8fcad8db84d3cc18b4c41d551ea0ee66dd599cde068d998e57d5e09332c131c`,
  `delegatecall`s to the per-function implementation; unrouted selectors revert with its own custom
  error `0x0a82dd73`. ERC-1967 implementation slot is empty (custom routing, not standard proxy).
- Implication: the `0xd4a84737` revert originates in one of the routed **implementation** contracts
  (unverified), not the proxy. Only Lit can decode the selector→function map and the error (source
  not public). Proxy bytecode also confirms the address is deployed on Base with code.

4. **Content is NOT the cause — verified with data (kills "did something slip in?").**
   - Current `protocol/actions/dist/prep/main.js` (79,490 bytes), compacted exactly as
     `compactAction` does (newline→space, collapse ≥2 spaces, trim), POSTed to the healthy
     `get_lit_action_ipfs_id` → returned `QmNPXjE8X9fP1JeqMGNrhq6GDypghtdYBWJfXQdzd6sLQy`, the
     exact registered CID (200, ~1.1s). Byte-stable since registration.
   - Prep action source last changed `257459a` 2026-08-19 ("ripples from a revoke"), >2 weeks
     before the first hangs (2026-09-03).
   - Even a bad CID/content yields a fast 4xx, never a 300s silent header timeout.

## Failure-mode taxonomy for `/add_action` (what it does + how it fails)
- **Fast deterministic errors (not the hang):** 401 auth; 422 validation; and — observed now —
  the 500 on-chain **read** revert above.
- **The hang (300s, no response headers):** consistent with the **write** path stalling — the
  API submits an on-chain tx (Base) and waits for confirmation. Healthy `/add_action` ≈ 8s
  (chain write + confirm); when RPC/mempool/confirmation degrades, the handler wedges → undici's
  default 300s headers timeout (no client timeout set in `LitService.call`).
- **Asymmetry worth telling Lit:** reads revert *fast* (contract returns an error), writes *hang*
  (submitted, never confirmed) — both point at the same degraded on-chain layer on Base.

## Hand to Lit
- Chain **Base (8453)**, contract **`0xaaaaa9120fe271f653cfdb6bf400db93d2dea7aa`**.
- Read revert error **`0xd4a84737019726c6babc1de231f26fd6cbb2df2c912784a2e1ba55295496269a6d3ff651`**.
- Write hang: request reaches server (TCP/TLS fine), no headers, 300s; 6/9 hard timeouts, 3 ~8s slow-successes.
- Our side: raw `fetch` + `X-Api-Key` to `api.chipotle.litprotocol.com/core/v1` (API mode, not ChainSecured).

## Still open (not implemented)
1. Fail-fast robustness PR: explicit `AbortSignal.timeout(20s)` + retry in `LitService.call()`.
2. Re-verify `/add_action` once upstream recovers (expect `ttfb < 2s`).

---
## Supplement 2026-09-06 — full revert payload + selector disambiguation (post Lit-team reply)
Lit team came back: `0x0a82dd73` reads as a generic OZ panic to them and they asked for the
"rest of the revert payload." Two clarifications from fresh live probes:

1. **Selector mix-up to correct with them.** `0x0a82dd73` is the **routing proxy's own
   "no route for this selector" error** (from a DIRECT eth_call to an un-routed selector),
   NOT the `list_actions` revert. The live read-path revert selector is **`0xd4a84737`**
   (this is the one `list_actions` actually returns). Send them `0xd4a84737` + data, not
   `0x0a82dd73`. (Also note: the standard OZ `Panic(uint256)` selector is `0x4e487b71`, not
   `0x0a82dd73` — worth not letting them chase OZ if it's the proxy's no-route error.)

2. **Full, fresh, deterministic payload (3/3 identical today, stable across group ids 14/1/99):**
   `0xd4a84737bfac2b42b42f246ec302c9d56cbf9c54a6cad51c93ac3d793571b2e86f8e3f5d`
   = selector `0xd4a84737` + a single 32-byte ABI argument `bfac2b42...8e3f5d`.
   **The 32-byte arg is TIME-VARYING**: the 2026-09-05 capture had arg `019726c6...a6d3ff651`,
   today's is `bfac2b42...8e3f5d`. Stable across group ids but different day-over-day → the
   error carries a state/time-dependent value (timestamp / block / nonce / state hash), not a
   fixed constant. Team can name it from their ABI; the changing arg is the signal.

3. **Key-binding theory (their 403 "API key not tied to action/PKP") — partial fit.**
   Counter-evidence to fold in: (a) two INDEPENDENT apps/accounts fail identically in the same
   window (s2s + nillcc's `@s3ntiment/shared`), so a single-account key-binding break doesn't
   explain both; (b) s2s `/add_action` HANGS (300s, no headers) rather than returning 403 — a
   missing key→action binding would more likely fail fast with an auth error; (c) the `0xd4a84737`
   revert is on a GET read (`list_actions`) with no write/auth-bind step involved. Still worth
   them confirming the account remains properly authorized/bound; the 403 they see is real and
   specific ("Failed to send transaction: HTTP error 403"), just doesn't cleanly fit all three
   observations.

## External context
- nillcc (separate app, separate account, same Lit API) also failing today on `/add_action` and
  `/create_wallet`: 500 "add_action failed: **Failed to send transaction: HTTP error 403 with
  empty body**" / "**Simulation failed: HTTP error 403 with empty body**", then 25s×3 timeouts.
  Same write path, different presentation (their client prints the API's error body + 25s retry;
  s2s's raw-fetch client waits silently on undici's 300s default and never got a body).

## Supplement 2026-09-06 (3) — transport ruled out (user asked re IP/provider/transport)
Measured from the user's machine (outbound IP 62.166.178.42, Odido NL / Rotterdam; hostname
`agent-vm`, a VM behind that connection):
- Prod API `api.chipotle.litprotocol.com` (→ 66.220.6.102, Phala dstack infra): DNS 3ms, TCP
  148ms, TLS 504ms, real GET 200 in 0.65s. Clean — a blocked/filtered IP would not serve fast 200s.
- Dashboard `www.litprotocol.com` (→ 66.33.60.34, Vercel): 200 in 0.2s. Loads fine.
- The failing responses travel back through transport intact: `list_actions` returns a full HTTP
  500 with structured EVM revert `0xd4a84737`; nillcc's `/add_action` returns 500 wrapping Lit's
  internal "Failed to send transaction: HTTP error 403" (a backend-layer 403, not a client-IP WAF
  block — a WAF write-block would be a direct 403, not a 500-wrapped internal message).
- Two INDEPENDENT networks see the same write-path failure: this NL VM (s2s) and nillcc's own
  server/container (`/app/nillcc-backend`). Rules out "your IP/provider".
- User reports the dashboard "create new key" ALSO timing out. Dashboard loads fine (200/0.2s),
  so it's the create-key backend action hanging — and that creates a FRESH account/key, further
  undermining the "your key isn't tied" theory (a brand-new key has nothing to be untied from).
- ONE genuine transport anomaly: `api.dev.litprotocol.com` fails TLS outright from our side
  (`OpenSSL SSL_ERROR_SYSCALL`, tls=0ms) — consistent 3/3. Dev host only, not prod; possibly a
  geo/region TLS block or dev-infra issue. Worth mentioning to Lit but not the prod failure cause.
- Conclusion: transport/IP/provider is NOT implicated in the prod failures; root cause remains
  server/on-chain (Base-backed) on the account-management write path.

## Supplement 2026-09-06 (2) — cross-account probe: BOTH account keys trip same selector
Tested BOTH real Lit account keys directly against `list_actions` (authenticated read):
- s2s key (`/home/joera/code/s2s/.env` → `LIT_ACCOUNT_KEY`): revert `0xd4a84737` + arg
  `bfac2b42b42f246ec302c9d56cbf9c54a6cad51c93ac3d793571b2e86f8e3f5d`, stable across groups 1/14/99.
- s3ntiment key (`/home/joera/code/s3ntiment/.env` → `VITE_LIT_API_ACCOUNT_KEY`, prod via
  `VITE_LIT_NETWORK==prod`): revert **same selector `0xd4a84737`** + arg
  `9c97c8097cf52250a8d90c9894dfcf73154b3bf21f9278dad1b2165411c15cd5` (groups 1 & 99);
  group 14 gave `http=000` 0 bytes (hung/drop) — mirrors the intermittent stall on the read path.
- So the error selector is account-independent (both accounts trip it) but its 32-byte argument
  is **per-account** (s2s `bfac2b42...` vs s3ntiment `9c97c809...`, each stable across groups).
  Implication: the contract custom error is keyed on the account, and BOTH independent accounts
  hit it → weakens the "one account's key is untied" theory; points to systemic contract/backend
  state or a shared account-state problem. 3rd fresh account key (user generating) is the
  discriminator: fresh key reverting too ⇒ systemic (kills key-binding theory); fresh key 200/empty
  ⇒ account-specific after all.
- Key semantics confirmed: `registerAction`(`/add_action`) runs BEFORE group assignment and uses
  the ACCOUNT key (no key override → `this.accountKey`); usage key is minted per-group, used only
  later for execute/usage. No account/usage key mixup in either codebase (values differ; both
  verified).
