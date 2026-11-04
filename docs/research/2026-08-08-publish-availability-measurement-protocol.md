---
research: publish-availability-measurement-protocol
date: 2026-08-08
status: draft — protocol to turn §8 guesstimates into measured data
author: Prof (GLM 5.2)
companion: 2026-08-08-publish-availability-time-gaps.md (defines the gaps + estimates this measures)
sources: the gaps note; user's operational history (the 110s .link method, port-4001 swarm finding); live probes 2026-08-08
---

# Measurement protocol — resolution lag & CID retrievability lag

> Companion to the time-gaps note. That note §8 gives **guesstimates** (1–11 min dangerous window,
> 5 min `.limo` cache, etc.); this file defines how to turn them into **measured data**. The two lags
> are **independent** and must be measured separately, then composed.

## 0. Why measure both separately

Resolution lag (on-chain `setText` → gateway serves new hash) and retrievability lag (new CID exists
→ fetchable by the world) compose into the user-visible gap, but they have **different root causes
and different fixes**:

- Resolution lag is a **gateway caching** property (`.limo`/`.link` `max-age=300`, verified live).
  Fix space: TTL tuning, cache-bust on publish, CCIP-gateway redundancy.
- Retrievability lag is a **DHT/Bitswap** property (provider-record propagation, swarm health,
  Pinata provide). Fix space: `routing/provide`, `Swarm.Peering`, multi-pin, port-4001 health.

Conflating them (as debugging did) hides which one is biting. Measure each in isolation, then the
composition.

---

## Measurement 1 — Resolution lag (on-chain → gateway serves new hash)

**Isolates the DNS/CCIP/gateway-cache path. Holds retrievability constant (use a CID already
durable on Pinata+Filecoin) so any lag is pure resolution.**

### Setup
- A **probe publication** under `soul2soul.eth` (dedicated, e.g. `probe.soul2soul.eth`) — do **not**
  test on real publications; `setText` mutates state + costs gas. The probe name's PKP/authorized
  path is the trigger.
- Two pre-staged CIDs, both **already durable** (Pinata-pinned + Filecoin-uploaded): `CID_old`
  (currently served) and `CID_new` (to flip to).

### Trigger
`t0` = Base block time of the `setText(node,"contenthash_wrapped",encode(CID_new))` tx (PKP-signed,
on C3). Capture from the tx receipt, not client submit time.

### Poll (parallel, every 2–5 s, until 3 consecutive `new`)

| Target | What to capture | What it isolates |
|---|---|---|
| `HEAD https://probe.soul2soul.eth.limo/` | `x-ipfs-path`, `x-ipfs-roots`, HTTP status, `age`, `cache-control` | the cached `.limo` path (verified `max-age=300`) |
| `HEAD https://probe.soul2soul.eth.link/` | same | **confirms `.limo`≡`.link` single-operator in real time** (expect ~0 delta) |
| direct CCIP gateway call (construct the EIP-3668 `eth_call` to C3 `getText`) | returned hash | the **un-cached** resolution path (expect `t0 + <1s`) — confirms the no-cache claim + measures gateway RPC latency |
| Brave native `.eth` (manual/ scripted) | served CID | the uncached native path (redirects to `ipfs.io` — note this swaps to ipfs.io's *own* cache) |

### Signals per poll (mirrors the 110 s history's three phases)
- **old-served** (`x-ipfs-path == CID_old`, `age` climbing) — cache masking the flip.
- **fetch-failure** (HTTP 404/502/504, or `x-ipfs-path` absent) — revalidation window where the
  gateway has invalidated old but can't yet serve new. **This is the exposed-dangerous sub-window.**
- **new-served** (`x-ipfs-path == CID_new`) — synced.

### Derived metrics
- `t_resolve[client]` = first `new-served` poll − `t0`, per client.
- **Phase breakdown** — widths of old-served / fetch-failure / new-served (the 110 s history showed
  ~10 s old + a failure window + synced; quantify for the current stack).
- `Δ(limo,link)` — should be ~0 if single-operator; non-zero is a finding.
- `t_resolve[direct-CCIP]` — the floor; everything above it is caching.

### Decision thresholds
- If `t_resolve[.limo]` ≤ ~5 min consistently → cache usually masks the flip for cached readers
  (stale-but-available); the dangerous window is mainly an *uncached-client* problem.
- If > 5 min → even cached readers hit fetch-failure → urgent, and a cache-bust-on-publish or
  shorter TTL is needed.

---

## Measurement 2 — CID retrievability lag (CID exists → fetchable)

**Isolates the IPFS/DHT/Bitswap path. Holds resolution constant (don't touch the pointer) so any
lag is pure retrievability. This is the lag the dangerous window is made of.**

### Setup
- A **separate probe node** that is **not** the self-hosted Kubo (`ipfs.transport-union.dev`) —
  "fetchable" must mean fetchable by the world, not by ourselves. A fresh Kubo/kubo on a VM, or a
  public node with API access.
- `ipfs` CLI available on the probe node (needed for `routing findprovs` / `dht findpeer` — the
  precise DHT signals). HTTP-only probing (public gateways) is a fallback proxy.

### Trigger
`t0` = now. On the self-hosted Kubo: `ipfs add` a unique marker (a small dir tree mimicking a site
root — a root CID, not just a file, to match real publish shape). `pin/add`. Record `cid`.

### Variants (run both — quantifies the cheap fixes from the gaps note §8.6)
- **A — current behavior:** add + pin. **No `routing/provide`.**
- **B — with cheap fix:** add + pin + **`ipfs routing provide <cid>`** + (optionally) `Swarm.Peering`
  with Pinata's node. Compare A vs B → effect of the cheapest fix on the window.

### Poll (parallel, from the probe node, every 5–15 s, until ≥2 independent backends fetch)

| Probe | Signal | What it tells |
|---|---|---|
| `ipfs routing findprovs <cid>` (probe node) | first provider record seen | **DHT propagation lag** — the 1–10 min estimate. If empty in variant A and populated in B → `provide` is the fix. |
| `ipfs dht findpeer <self-node-id>` | is the self-node reachable as a peer | **port-4001 swarm health** (the historical root cause). If the self-node is never found as a peer → swarm still broken → self-node is gateway-only, contributes no Bitswap availability. |
| `HEAD https://ipfs.transport-union.dev/ipfs/<cid>` | self-hosted gateway 200 | the single-node baseline (expect instant) |
| `HEAD https://ipfs.io/ipfs/<cid>` | public gateway 200 | broad retrievability proxy; timeout = not provided |
| `HEAD https://dweb.link/ipfs/<cid>`, `https://flk.network/ipfs/<cid>` | other public gateways | multi-gateway spread |
| `ipfs cat <cid>` (probe node, Bitswap) | pure Bitswap fetch success | independent of any HTTP gateway — true IPFS retrievability |
| Pinata `pinByHash` at `t_pinata` (record it); keep polling | inflection point | **tests the hypothesis that Pinata provide is the unblock** (the gaps note's main claim) |

### Derived metrics
- `t_findprovs` = first DHT provider seen by the probe node.
- `t_gateway[gw]` = first 200 from each public gateway.
- `t_pinata_unblock` = retrievability inflection after Pinata pin completes.
- `t_retrievable` = first moment **≥2 independent providers** fetch successfully — **the "ready"
  candidate for the durability gate** (gaps note §5.4).
- **A vs B delta** — the value of `routing/provide` + peering in minutes saved.

### Decision thresholds
- If `t_retrievable` (A) > 5 min and (B) < 1 min → ship `routing/provide` + peering immediately
  (cheap, high leverage) even before the full `treeupdate`/`evmupdate` split.
- If self-node `findprovs` is empty in both → port-4001 still broken; the self-node is a gateway
  only — **retrievability is 100% dependent on Pinata** until fixed. That's a single-provider
  dependency masquerading as two.
- If Pinata pin is the consistent unblock → confirms the "ready = Pinata-confirmed + DHT-provided"
  gate definition (gaps note §5.4); PDP (~24 h) stays a backstop, not a blocker.

---

## Measurement 3 — Composition (the dangerous window, end-to-end)

**A real publish, instrumented at both ends. This is the number that matters for uptime.**

### Trigger
A real publish through the `update` action. Instrument:
- `t3` = on-chain `setText` confirmed (tx receipt).
- `cid` = the action's returned root.
- `t_retrievable(cid)` via Measurement-2 polling (started at `t3`).

### Derived metrics
- **Dangerous window** = `t3 → t_retrievable` (the fresh-but-unavailable gap).
- **Masked duration** = readers served `CID_old` (durable) during the window — the accidental grace.
- **Exposed duration** = readers getting errors during the window — the actual downtime.
- `t_first_visible[client]` = first new-content served, per client (from Meas-1 polling).

### What this tells that the isolated tests don't
Whether the dangerous window is **masked or exposed in practice** — i.e. whether the cache TTL
exceeds `t_retrievable` for real publishes. That's the single most decision-relevant number for
"do we need the split now, or is the cache hiding it?"

---

## Measurement 4 — Client matrix (uniformity)

Run Measurement-1 across the client set to quantify availability **non-uniformity** (the gaps note
§8.4 point that 99.9% "isn't uniformly definable across clients"):

- `.limo` (cached, `max-age=300` verified)
- `.link` (cached, same operator — confirm identical)
- Brave native `.eth` (uncached; redirects to `ipfs.io` — captures ipfs.io's cache as a second lag)
- IPFS Companion + local node (the "ideal" path)
- direct CCIP gateway + manual IPFS fetch (the floor)
- any other operator (Cloudflare ENS gateway if active, `flk.network`, etc.) — **a different
  operator is the only real redundancy for 99.9%** (gaps note §9.4)

**Spread** of `t_resolve` across clients = the uniformity gap. If Brave/direct expose a multi-minute
window that `.limo` masks → the cache is load-bearing for availability, which is fragile (one TTL
change at eth.limo silently breaks uncached clients' masking).

---

## Static probe (no publish trigger needed — current health snapshot)

When you can't trigger a publish, measure **current** retrievability of already-served content:
resolve a live `*.soul2soul.eth.limo` → extract `x-ipfs-path` → test that CID across public
gateways + `findprovs`. This doesn't measure the *lag* but answers: **are published sites redundantly
retrievable right now, or single-source?** A run on 2026-08-08 is in §"Live snapshot" below.

---

## Tooling notes

- **Needs an `ipfs` node:** `findprovs`/`findpeer`/Bitswap-cat (the precise DHT signals). Without
  one, public-gateway HEAD probes are a coarse proxy (fetch-success ≈ provided). Standing up a
  throwaway probe node is worth it — the DHT signals are the ones that diagnose port-4001 health.
- **curl-only subset:** resolution-lag polling + public-gateway retrievability HEAD probes are
  pure HTTP — runnable from anywhere, no node. Good for a first pass.
- **Operational care:** `setText` probes mutate C3 + cost gas → use a dedicated probe name, not real
  publications. `ipfs add` junk CIDs → unpin after. Pinata `pinByHash` of test CIDs → remove after.
- **Repeatability:** run each measurement N≥5 times; the lags are stochastic (DHT propagation,
  gateway cache eviction). Report median + spread, not single shots.

---

## Live snapshot — 2026-08-08 static probe (curl-only, no node)

*Run 2026-08-08 ~10:30 UTC. No `ipfs` CLI in env → curl-only subset (resolution + public-gateway
HEAD). Already surfaced three current-health issues before any lag measurement.*

### Control (confirms the path works)
- `vitalik.eth.limo` → **200**, `server: eth.limo`, `x-ipfs-path: /ipfs/bafybei…/`,
  `cache-control: max-age=300, must-revalidate`. ✅ The `.limo` path works for a 2-component ENS
  name with a contenthash set. The 5-min cache is confirmed live on a real resolution (not just the
  marketing-site homepage).

### Finding 1 — S2S publication subdomains FAIL on `.limo` (TLS/connection)
- `soul2soul.eth.limo` (3-label, the S2S **root**) → **200** (intermittent, see Finding 2).
- `alice.soul2soul.eth.limo`, `sentiment.soul2soul.eth.limo`, `brantly/probe/dev` (all 4-label,
  i.e. `*.soul2soul.eth` publication form) → **empty response / TLS rejection**
  (`OpenSSL: tlsv1 alert internal error (592)` — server-side TLS SNI rejection, before any app
  logic). This is **independent of whether the publication name is registered** (TLS happens before
  resolution), so it affects *all* S2S publications.
- Control contrast: `app.uniswap.eth.limo` (4-label under a different parent) → **500** (TLS
  *succeeded*, app error). So `.limo`'s cert covers `*.uniswap.eth.limo` but **not**
  `*.soul2soul.eth.limo`.
- **Hypothesis:** `.limo` holds a `*.eth.limo` wildcard (covers 3-label `vitalik.eth.limo`,
  `soul2soul.eth.limo`) + per-parent wildcards for some popular names (`*.uniswap.eth.limo`), but
  **no `*.soul2soul.eth.limo`** → **no S2S publication is servable via `.limo` at the standard
  `<pub>.soul2soul.eth.limo` form.** `[verify: with a known-live registered publication name; and
  check eth.limo's cert list / their subdomain scheme — they may use a different encoding for dotted
  ENS names, e.g. bracket or DNS-encoded form]`
- **If confirmed, this is a major 99.9% finding:** combined with `.link` = same operator (gaps note
  §9.4), **S2S publications currently have ZERO third-party gateway path** — only the protocol root
  `soul2soul.eth.limo` is reachable via `.limo`/`.link`. Publications are reachable only via direct
  CCIP + IPFS, or the S2S preview gateway (`preview.transport-union.dev`, per OPEN-TASK-1). The
  whitepaper DR-7.6 assumption that readers use `<pub>.soul2soul.eth.limo` may be **currently false**.

### Finding 2 — `soul2soul.eth.limo` intermittent 504 (CCIP round-trip timeout)
- Across the probe: `soul2soul.eth.limo` returned **504 (Caddy), 504, then 200**, and later **5/5
  200**. The 504s are Caddy timing out on the CCIP round-trip (`ccip.transport-union.dev` → C3 Base
  `getText`) — the CCIP gateway is **up** (returns JSON on probe) but the round-trip intermittently
  exceeds Caddy's timeout.
- **Implication:** even the S2S root's `.limo` availability is **intermittent** under momentary
  latency. 504s are exactly the "fetch-failure" phase from the 110 s history — happening *now*,
  not just on publishes. `[verify: sustained sample — is the 504 rate >0.1%?]`

### Finding 3 — `soul2soul.eth.limo` 200 returned `content-type: application/vnd.ipld.dag-cbor`
- On its 200 responses, the root served **dag-cbor**, not `text/html` like `vitalik.eth.limo`.
  Either `soul2soul.eth`'s contenthash points at a dag-cbor root (not a UnixFS HTML tree), or `.limo`
  is returning the raw resolved bytes rather than fetching IPFS. `[verify: on-chain contenthash for
  soul2soul.eth + what CID it resolves to]`

### What the probe validates / doesn't
- **Validates:** the curl-only subset works; resolution-lag polling (Meas-1) is runnable now;
  public-gateway retrievability HEAD probes (Meas-2 subset) are runnable now. The 3 findings above
  are exactly the "current health" signal the static probe was meant to surface.
- **Doesn't (needs a node):** DHT `findprovs`/`findpeer` (Meas-2's precise signals — the port-4001
  diagnosis), Bitswap-cat, the A/B `routing/provide` comparison. **Standing up a throwaway probe
  node is the single highest-value next step** — it unlocks the DHT signals that distinguish
  "single-node gateway, zero swarm peers" (the historical root cause) from "broadly provided."
- **Priority finding to chase:** Finding 1 (publication subdomains unservable on `.limo`) — if
  confirmed, it reframes the whole availability picture: the time-gap work (gaps note) assumes a
  working `<pub>.soul2soul.eth.limo` path that may not exist. Verify before investing in lag
  measurement, because the lag is moot if the path is TLS-broken.

---

## Cross-references
- Gaps + estimates: `2026-08-08-publish-availability-time-gaps.md` §8 (guesstimates this measures),
  §5.4 (ready-signal hierarchy), §8.6 (cheap fixes A/B test here), §9.4 (single-operator).
- Whitepaper 07 DR-7.6 (cross-client CID decoding — add a decoding-consistency check to Meas-4:
  compare the CID *bytes* each client fetches, not just the string, to catch `bciq`/`bafybei`
  multibase divergence).
