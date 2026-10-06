---
rfc: gateway-keepalive-warmup
date: 2026-08-31
status: draft — proposed, not yet built
author: s2s-orchestrator (DeepSeek V4 Flash 0731)
companion: research/2026-08-08-publish-availability-time-gaps.md (§8.6 "warm public gateways"),
          research/2026-08-08-publish-availability-measurement-protocol.md,
          gateway-probe REPORT.md (2026-08-31)
---

# RFC — Gateway keepalive / warmup: periodically probe the root CID from many public gateways

An **RFC, not a spec**: this describes behavior that is **not yet built**. When built + independently
reviewed, fold the settled parts into the relevant SPECs (read path in `SPEC-00` / `SPEC-contracts-ens`)
and strike here.

## 1. Problem (empirical)

Public IPFS gateways serve content from **caches that evict** under inactivity. A publication that is
pinned and durable can nonetheless be **unavailable from a gateway** if no request has touched that
gateway's cache for a while — the gateway simply re-fetches on demand and, until it does, serves
nothing.

**Direct observation (the prompt that opened this RFC):** `.eth.link` only continues to serve CID
content when probed continuously. This is cache-warmth: a gateway that is probed keeps the resolved
contenthash → root-CID mapping and the CID's blocks hot; one that is never probed lets them fall out.

This is separate from (and additive to) the publish-time gap work in the companion research:

- The companion research (§8.6) already listed **"Warm public gateways (HEAD requests post-pin)"** as a
  cheap, ranked strategy — but **it was never implemented.** A repo-wide grep (2026-08-31) confirms no
  keepalive / gateway-probe / warmup code exists anywhere (only the brain research mentions it).
- The companion research also established the read path's SPOFs (§4): one CCIP gateway, one Kubo node,
  and **one operator (eth.limo) fronting both `.limo` and `.link`** (`max-age=300` cache rule verified
  live on 2026-08-08). A keepalive does not remove those SPOFs, but it does keep the gateways that *are*
  configured warm, so readers don't hit cold-cache misses.

**Net:** some availability loss today is not a durability problem — it is a **cache-warmth** problem.
`Pinned` ≠ `served-on-demand-instantly`. A periodic keepalive converts "served only when probed" into
"served continuously."

## 2. Proposed behavior

A small, periodic service that, for every published site under `soul2soul.eth`, issues cheap
`HEAD`/`GET` requests for its root CID to **as many public IPFS gateways as possible**, so their caches
stay warm.

**Invariant:** a request to a gateway **must not** be allowed to block the loop or take down the cycle.
Each probe is independent, time-boxed, and failure-tolerant (a gateway that is down/evicting is logged,
not fatal). The service is a *warmth* mechanism, not an *authority*: it never writes state, never opens
a PR's worth of new failure modes, and is safe to run read-only against the chain.

### 2.1 What to probe (two URL forms, both warm different caches)

For each publication with root CID `R` and ENS name `N.soul2soul.eth` (e.g. `s3nl.soul2soul.eth`):

1. **CID form** — `https://<gateway>/ipfs/<R>/` — warms the gateway's *content* cache (the CID's
   blocks) so any path resolving to `R` (via ENS, Pinata, direct) fetches instantly.
2. **ENS/serving form** — `https://N.soul2soul.eth.<gateway-front>/` for ENS fronts (`.eth.limo`,
   `.eth.link`) — warms the **resolution + contenthash cache** too, which is exactly what the browser
   URL `N.soul2soul.eth.limo` hits. Probing only the CID form would warm the backend but not the
   gateway's ENS contenthash cache.

> Note: `<name>.eth.link` is served by eth.limo (2024-09 take-over) — `.limo` and `.link` share backend
> and cache. Probing both still has value (two domain fronts, either may be the one a reader types) but
> they are **one operator**, so for operator-redundancy the list must also include *other* operators
> (see §2.2).

The root CID `R` comes from the on-chain `contenthash_wrapped` record for the publication (the
`getRecords` / `getProtocolInfo` read pattern already used by the code; see
`protocol/actions/src/libs/protocol.factory.ts`, `shared/src/protocol/index.ts`, and the 2026-08-31
gateway-probe REPORT §1).

### 2.2 Gateway set (initial, configurable)

A plain configurable list of public IPFS gateways, with explicit operator annotation so we can reason
about independence:

- `https://ipfs.io` (Protocol Labs)
- `https://dweb.link` (Protocol Labs front)
- `https://cloudflare-ipfs.com` (Cloudflare)
- `https://4everland.io` (4EVERLAND)
- `https://gateway.pinata.cloud` (Pinata — also the durabilty pin provider)
- `https://nftstorage.link` (NFT.Storage)
- `https://<site>.soul2soul.eth.limo` (eth.limo operator)
- `https://<site>.soul2soul.eth.link` (eth.limo operator — same backend as .limo)

**Operator redundancy matters:** because limo≡link is a single failure domain, the keepalive is only as
independent as the *set of operators* it covers, not the count of domain fronts. The config should
expose both `id` and `operator` per gateway so coverage can be reported and audited.

### 2.3 Schedule & cadence

- Run **periodically**, cadence configurable, default chosen to be **more frequent than the verified
  gateway cache TTL** (`max-age=300` → every **2–4 min** so a warm entry never expires between probes).
- Add a small **jitter** so the loop does not synchronize with itself or thundering-herd a gateway.
- One pass = probe every site × every gateway, each with an independent per-request timeout (e.g.
  5–10 s) and concurrency limit.

### 2.4 Failure tolerance & observability

- Per-probe outcome tri-state: `warm` (served), `cold` (served but fetch happened — cache miss we
  just re-filled), `fail` (timeout/error). Log/record the aggregate, not just the happy path.
- A gateway that fails is **excluded/backed-off**, never allowed to stall the loop.
- Emit a small per-pass summary (sites × gateways warmed / failed) so drift (a site no longer probed, a
  gateway permanently down) is visible.

### 2.5 Where it lives (initial recommendation)

A **standalone script** (`protocol/scripts/` or a dedicated small package) driven by a scheduler, not
wedged into the path-critical Lit actions or `neutralpress` render flow:

- `tsx` script + a `node-cron`/`setInterval` or external cron/systemd-timer.
- Reuses existing `shared` + `.env` read plumbing for on-chain resolution (public RPCs only — no keys
  needed to *read* records / gateways).
- No on-chain writes. Read-only against the chain; only outbound HTTP to gateways.

## 3. Acceptance contract (for the implementer)

1. **Enumerates** published sites under `soul2soul.eth` and their current root CIDs from on-chain
   records (same source as production reads).
2. **Probes** both URL forms (CID + ENS-front) across a configurable multi-operator gateway set in one
   periodic pass.
3. **Isolation:** any single gateway timeout/error does not crash or block the pass; slow gateways are
   bounded by per-request timeout + concurrency cap.
4. **Cadence** configured below the verified gateway cache TTL (default ~every 2–4 min), with jitter.
5. **Observability:** per-pass summary log/state with per-gateway, per-site outcomes; backed-off failure
   classification for persistently-down gateways.
6. **Read-only, no secrets:** resolves via public RPCs; no private keys; no on-chain writes; no edits to
   the Lit actions, `neutralpress` render path, or anything path-critical.
7. **Tests:** unit tests for the probe/timeout/concurrency/enumeration logic with a mocked gateway and
   a mocked records source; deterministic gates green (repo test/lint/typecheck conventions).

## 4. Scope guards (explicitly NOT in this RFC)

- **Not a durability gate** — does not gate pointer moves on readiness (that is the separate
  `treeupdate`/`evmupdate` split in the companion research §5). This RFC is orthogonal: it keeps
  *cold-start* from being an availability failure, it does not move pointers.
- **Not the durability/archive tier** (Filecoin, Pinata pin) — the keepalive *uses* the gateway list; it
  does not manage pins or PDP proofs.
- **Not a replacement for CCIP-gateway / Kubo redundancy** — warmth is orthogonal to those SPOFs; this
  RFC just keeps the configured gateways warm.
- **No new on-chain state, no new contracts, no ENS changes.**

## 5. Open questions / to verify

- `[verify]` Does eth.limo/Cloudflare/etc. **warm on `HEAD`**, or only on `GET`? If `HEAD` does not
  populate cache, the probe must use `GET` (with `Range: bytes=0-0` or a cheap early-abort) — this is
  the single most important unknown for cost-vs-effectiveness.
- `[decide]` Cadence default (2 vs 4 min) — driven by measured eviction, not theory; the measurement
  protocol could measure how long a probed gateway stays warm.
- `[decide]` Which site set: all publications under the ENS, or an allowlist? (Warming every historical
  root CID may be wasteful; the *current* contenthash per publication is the right default.)
- `[verify]` Gateway rate limits / terms — proving many public gateways this often is cheap, but the
  default cadence + jitter should not run afoul of any gateway's usage policy.
- `[decide]` Standalone script + external scheduler vs a tiny serverless function under
  `protocol/serverless` (matching where the repo already runs periodic infra).

## 6. Relationship to existing work

- **Companion research §8.6** already ranked "warm public gateways (HEAD requests post-pin)" as a cheap,
  high-leverage strategy — **this RFC is the implementation of that row**, generalized from a
  post-pin one-shot to a periodic keepalive.
- **Companion research §8.6 cheap wins** — `routing/provide` after pin and `Swarm.Peering` with
  Pinata cut the DHT-propagation portion of the publish window and are complementary (they make content
  *findable*; keepalive makes it *warm*). They are separate workstreams, not this RFC.
- **gateway-probe REPORT (2026-08-31)** — proves the on-chain `data_gateway` read path works with public
  RPCs only; the keepalive's enumeration reuses exactly that pattern.
