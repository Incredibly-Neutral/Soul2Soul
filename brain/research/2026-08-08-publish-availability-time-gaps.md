---
research: publish-availability-time-gaps
date: 2026-08-08
status: draft — problem framed; solution-space mapped, not committed
author: Prof (GLM 5.2)
sources: live code (protocol/actions, neutralpress, shared/filecoin); SPEC-00; SPEC-contracts-ens; SPEC-protocol-actions §A3; whitepaper 06/07; primary web checks (eth.limo/eth.link)
---

# Publish → availability time gaps (the problem, before the solution)

> **Prompt that opened this:** "research the time gap between (1) change of root CID on the ENS
> contract (and its delay from caching at the limo and link gateways) and (2) content being
> retrievable on IPFS, through Filecoin hot storage and Pinata. We need 99.9% uptime. [A split of
> the updater into `treeupdate` + `evmupdate` with upload-to-FC/Pinata-and-listen-for-ready in
> between, plus signing the rootCID so neither an arbitrary CID nor an old signed CID can be
> replayed,] is a solution. What is the *problem*? What can we say about these time gaps?"
>
> This note deliberately **frames the problem first** and keeps the proposed split as one option in
> a mapped solution space — not as the answer.

## 0. TL;DR

There is an **availability-consistency window in every publish**: the on-chain root pointer can move
to a new root *before* that new root is durably retrievable from independent providers, while the old
root stops being "the pointer." During that window the site is single-node (the self-hosted Kubo
node) or absent. The system has **no durability gate on the pointer move** and **no root-level
attestation** binding a pointer write to a specific, freshly-produced, durability-proven root.

The proposed `treeupdate`/`evmupdate` split is a valid way to *insert* that gate, but it introduces a
new seam (root authenticity + replay) that the existing per-leaf integrity gate (§A3) does **not**
cover — because §A3 signs each *page*, not the assembled *root*. So the split is not "add a signature
to what we have"; it is "add a *new* signature at a *new* layer," and it must be replay-safe.

Also: fixing the time gaps is **necessary but not sufficient** for 99.9%. The read path has ≥2
single points of failure today (the one CCIP gateway; the one Kubo node for fresh roots; reliance on
a single third-party gateway `.limo`). 99.9% ≈ 8.76 h downtime/year — none of those SPOFs tolerate
that alone.

---

## 1. The publish → availability timeline (what actually happens, grounded in code)

Stages and the code that performs them. Times are characteristic, not SLAs — see §3 for what governs
each and the `[verify]` items.

| t | Event | Performed by / code | Characteristic time | State of the new root after this |
|---|---|---|---|---|
| t0 | Tree assembled on Kubo MFS (pages `cp`'d in, stale paths `rm`'d, assets `cp`'d) | `update` action, `update/main.ts:100–246` (Kubo `files/cp`,`files/rm`) | seconds (Lit action body) | blocks in Kubo store; root not yet computed |
| t1 | Root computed | `files/stat` → `newRootCid`, `update/main.ts:279–284` | instant | resolvable **only on the Kubo node**; not pinned; **not DHT-provided** |
| t2 | Root pinned on Kubo | `pin/add`, `update/main.ts:287` | instant (local pin) | pinned on **one node** (`ipfs.transport-union.dev`); still not DHT-provided |
| t3 | **Pointer moved on-chain** | `evmWrite setText(node,"contenthash_wrapped")`, `update/main.ts:293–302`, PKP-signed on Base (C3) | ~1 Base block (~2 s) + sequencer soft-finality | **publish committed.** New root is the pointer. Root is single-node. |
| — | action returns `{ cid }` to neutralpress | Lit → `renderwithLitActions` → `renderCalls`, `neutralpress/src/main.ctrlr.ts:~390` | seconds (Lit finalize) | — |
| t4 | **Pinata pin** (remote pin — Pinata fetches from Kubo) | `pinCidFromRemote(cid,'https://ipfs.transport-union.dev',pinata_jwt)`, `main.ctrlr.ts:~413–418` | seconds (request) + seconds→minutes (Pinata fetch of the tree) | root on Kubo **+ Pinata** (2 providers); Pinata provides to DHT ⇒ broadly IPFS-retrievable |
| t5 | **Filecoin durability** (fire-and-forget) | `filecoinUploadBackground('render-root', uploadTree(cid,kubo))`, `main.ctrlr.ts:~422–426` | seconds→minutes to upload (CAR via `dag/export` → Synapse) + **PDP proof cadence** before "proven" | `pieceCid` minted; `copies` replicas returned; on-chain PDP proof lags (see §3) |

Read path (after t3, pointer = new root):

| r | Event | Code / infra | Gap |
|---|---|---|---|
| r0 | user → `publication.soul2soul.eth.limo` | `.limo` gateway | — |
| r1 | `.limo` resolves ENS L1 → C5 `ENSResolverWithCCIP` → `OffchainLookup` → CCIP gateway `ccip.transport-union.dev` → `getText` on C3 (Base) | SPEC-contracts-ens C5; whitepaper 07 DR-7.2 | CCIP gateway does a fresh `eth_call` (no inherent cache); **`.limo` caches** the resolved contenthash with a TTL `[verify]` |
| r2 | `.limo` fetches the CID from an IPFS backend | `.limo`'s IPFS gateway / DHT | depends on whether the root is DHT-provided yet (only at/after t4) or pinned by a peer `.limo` reaches |

**Note on `.link`: alive, but now operated by `eth.limo`.** The bare `eth.link` domain is an
abandoned 178-byte S3 landing page (last-modified 2024-09-17) — but **subdomain resolution is
live**: `vitalik.eth.link` → 301 (Caddy) → 200 with `server: eth.limo`, `x-ipfs-path`,
`x-ipfs-roots`, `cache-control: max-age=300, must-revalidate`. `www.eth.link` likewise serves
`server: eth.limo`. Per a Binance post (2024-09-20), **"eth.link gateway now supported by eth
limo service"** — eth.limo took over eth.link's resolution in Sept 2024. **So "the limo and link
gateways" are one operator (eth.limo), two domain fronts — NOT two independent gateways.** This
is a stronger SPOF finding than two separate operators: they share backend, caching, and
failure domain. The 5-min cache (`max-age=300`) is now **verified current** on the live response
(see §8.2/§8.7).

---

## 2. The two failure modes (this is the heart of "the problem")

### FM-1 — Fresh-but-unavailable (the dangerous window)

Between **t3** (pointer moved) and **t4** (Pinata pin complete / root DHT-provided), the new root is
retrievable from **exactly one node**: the S2S Kubo node. If that node is down, slow, or
network-partitioned in that window, the site is **down** — even though (a) the pointer is correct,
(b) a perfectly good, fully-durable **old** root still exists on Pinata+Filecoin, and (c) nothing
about the new content is wrong. The system flipped to a fragile root by default.

- This window is **seconds to low-minutes** in the common case (t3→t4).
- It widens to **up to ~24 h** for *proven* durability (t3→t5+first-PDP-proof), though Pinata gives
  an off-chain-durable second copy much sooner.
- The hazard is **blip-amplifying**: a Kubo restart during a publish window takes the site down at
  the exact moment a new reader following the fresh pointer arrives.

### FM-2 — Stale-but-available (the partial mask)

`.limo` caches the resolved contenthash (r1). So for the cache TTL after t3, `.limo` keeps serving
the **old** root — which is durable. This *partially masks* FM-1: readers in the cache window see
the old (good) site, not the fragile new root. But:

- It is **unreliable**: cache hit/miss depends on path/edge; TTL is unconfirmed `[verify]`; `.link`
  is dead; native `.eth` clients behave differently (whitepaper DR-7.6 already flags cross-client
  decoding inconsistency).
- It **delays visibility** of the publish by the cache TTL — a latency/UX cost, not just a benefit.
- It does nothing for readers who bypass `.limo` (direct CCIP, other gateways, IPFS-native clients).

So the cache is an accidental, partial, uncontrolled grace window — not a durability guarantee.

### The problem, stated sharply

> Every publish moves the on-chain pointer to a new root that is **single-node** at that instant,
> and only becomes multi-provider-durable asynchronously (Pinata at t4, Filecoin-proven at t5+).
> There is **no gate** making "pointer moves" contingent on "new root is durably retrievable," and
> **no attestation** binding a pointer write to a specific freshly-produced root — so any design
> that lets the pointer move as a discrete step must add both, and must defend against replay of an
> old attestation (rollback). The accidental `.limo` cache only partially hides this.

---

## 3. The time gaps, characterized (what governs each)

| Gap | Governs | Typical magnitude | Primary-source note |
|---|---|---|---|
| **t1→t2 DHT provide** | whether the new root is advertised to the IPFS DHT | **never** (action does not call `dht/provide`) | `update/main.ts` calls only `files/cp`,`files/stat`,`pin/add`,`files/rm` (grep-confirmed). `pin/add` does not provide; the root is an MFS-dir hash, never `add`ed. ⇒ root is fetchable only via the Kubo gateway / direct peering until **Pinata** provides it at t4. `[verify Kubo internals: pin/add≠provide]` |
| **t2→t3 on-chain write** | Base L2 inclusion + soft finality | ~2 s (1 block) + sub-second sequencer | Base ~2 s block; sequencer soft-finality fast. For CCIP reads, the gateway `eth_call`s latest Base state. |
| **t3→t4 Pinata pin** | Pinata accepting + fetching the CID from Kubo | seconds (accept) + seconds→minutes (fetch tree) | `pinCidFromRemote` = pin-by-CID; Pinata pulls from the Kubo gateway. **Coupling:** if Kubo is down *at pin time*, the Pinata pin fails — the durability tier depends on the SPOF it's meant to back up. |
| **t3→t5 Filecoin proven** | Synapse upload + PDP on-chain proof cadence | upload: seconds→minutes; **first PDP proof: up to ~24 h** | whitepaper 06 DR-6.4: PDP proofs every 24 h, 2 replicas, payments halt if proofs stop. `uploadTree` returns `copies` (replica count) + `pieceCid` sooner; "proven" lags. `[verify first-proof latency vs 24 h cadence]` |
| **r1 cache (`.limo`)** | gateway contenthash cache TTL | minutes-scale (unconfirmed) | `.limo` alive (HTTP 200, Framer site); TTL not exposed in docs this session `[verify]`. CCIP gateway itself does fresh `eth_call` — caching is at `.limo`/client layer. |

**"Ready" is ill-defined today.** The user's "listen to ready" needs a definition of ready-for-what:
- *IPFS-retrievable via a 3rd-party gateway* ⇒ roughly t4 (Pinata provides to DHT).
- *Filecoin-proven durable* ⇒ t5 + first PDP proof (could be ~24 h).
- The shared `isRetrievable(pieceCid)` (`shared/src/filecoin/index.ts:373–375`) probes by
  `synapse.storage.download({pieceCid})` — i.e. **SP retrieval, pieceCid-keyed**, not IPFS-gateway
  retrievability, and not on-chain-PDP-proven. It is a liveness probe, not a durability proof.
- The Filecoin **IPFS gateway** (hot-storage serving) is **not implemented** (SPEC-00 GAP-13), so
  Filecoin is a durability/archive tier today, not a *retrieval* tier for HTML. Pinning "ready" to
  Filecoin retrievability would block on a gateway that doesn't exist yet.

---

## 4. 99.9% needs more than closing the time gaps (necessary, not sufficient)

The time-gap work removes FM-1. But the **read path** itself has single points of failure that no
amount of publish-side gating fixes:

1. **One CCIP gateway** — `ccip.transport-union.dev` is "a single service in the resolution path"
   (whitepaper 07, open GAP). If it is down, *no* client can resolve any S2S publication, regardless
   of how durable the content is. There is no mainnet fallback contenthash (DR-7.6: "no fallback
   stored on mainnet"). → 99.9% requires CCIP gateway redundancy (≥2 gateways, DNS-failover or
   client-side multi-gateway CCIP).
2. **One Kubo node for fresh roots** — until t4, the new root is single-node. Even with a durability
   gate (delay t3 until t4), the *write* of the tree still happens on one Kubo node; a publish-time
   Kubo outage blocks all publishes (not availability of the old site, but liveness of new ones).
3. **One third-party gateway (`.limo`)** — `.link` is dead; `.limo` is a single operator. ENSv2
   (DR-7.7) may normalize this later; today it is a dependency.

So 99.9% decomposes into: **(a)** no fresh-but-unavailable window (this note), **(b)** CCIP gateway
redundancy, **(c)** multi-gateway / multi-node read path. (a) alone is not enough.

---

## 5. Solution space (mapped, not prescribed) — and where the "sign the rootCID" idea lands

### 5.1 The core move: a durability gate on the pointer flip

Instead of t3 immediately following t2 (current: pin on Kubo → write pointer, one atomic action),
**decouple tree-production from pointer-write** and gate the latter on a readiness signal:

```
treeupdate (Lit/PKP):  build MFS tree on Kubo → root CID R (t1/t2). Do NOT write pointer.
                       ↓ publish R + metadata
[ durability stage ]:  Pinata pin (t4) + Filecoin upload (t5) + readiness probe
                       ↓ ready(R) = ≥2 independent providers hold R (and/or PDP-proven)
evmupdate (Lit/PKP):   setText(pointer := R)   ← only accepted if attestation says R is fresh+ready
```

This converts FM-1 into a **graceful publish**: the old root stays the pointer (and stays served,
durable) until the new root is durable; then flip. Cost = publish latency = the t3→t4 (or t3→t5)
window, now on the *write* critical path instead of the *read* availability path. That is the right
trade for an availability-first system.

### 5.2 The new seam this opens — root authenticity + replay (the "sign the rootCID" problem)

Today the `update` action is **one PKP atomic action**: tree-build + pointer-write happen inside one
enclave run, so the root is transitively "PKP-produced" by construction. **Splitting breaks that.**
`evmupdate` would take a CID argument → two attacks appear:

- **Arbitrary CID:** call `evmupdate` with a CID never produced by `treeupdate` (a constructed CID,
  or content the attacker controls). `evmupdate` is `onlyAuthorized` = PKP (INV-12), so the attack
  surface is *what input makes the PKP call it* — i.e. the attestation must be PKP-produced and
  verified, not caller-supplied.
- **Replay / rollback:** reuse an old attestation to move the pointer **back** to a prior root
  (rollback a publication to a stale version), or replay a valid "R is ready" to flip after R has
  since been unpinned.

**Defense = a PKP-signed attestation over a freshness-bound payload:**
`attest = sig_PKP({ publication, newRoot R, prevRoot P, epoch/nonce, readyClaims })` and `evmupdate`
checks `prevRoot P == on-chain current root` **and** `epoch == expected` (monotonic). Binding to the
current on-chain root as a challenge kills replay: an old attestation references an old `prevRoot`
that no longer matches. A monotonic epoch kills cross-publication / reordering replays.

### 5.3 This is the *root-level* analogue of the existing §A3 leaf-level gate — not the same thing

The system **already has** an integrity gate (SPEC-protocol-actions §A3, implemented 2026-08-07):
the PKP signs **each rendered page's** JSON-LD schema (committing to `sha256(html)` + genesis), and
`update` verifies that sig before a page enters the tree. That proves *"every leaf is PKP-rendered
for the claimed genesis."* It does **not** sign the **assembled root CID** — the root is
authenticated only *transitively* (all leaves signed + structure built inside the atomic action).

Splitting `treeupdate`/`evmupdate` **removes** the "built inside the atomic action" leg for the
root. So a root-level attestation is the **new** mechanism needed at the **new** seam — it is not
redundant with §A3. §A3 stays (leaf integrity); the root attestation adds (root authenticity +
freshness + durability-claim). The two compose: §A3 proves the tree is made of genuine PKP pages;
the root attestation proves "this specific root was produced from such a tree, now, and is durable."

### 5.4 The ready-signal hierarchy (what "ready" should bind to)

An attestation can lie about readiness unless the ready-claim is itself verifiable. Hierarchy,
strong→weak:

1. **Filecoin PDP on-chain proof** (strongest): the proof is public/on-chain/auditable; payments
   halt if it stops. But proof cadence (~24 h) makes this a *slow* gate — fine as a backstop, too
   slow as the publish blocker.
2. **Pinata pin confirmation** (off-chain trust): fast (seconds–minutes), but trusts Pinata. Good
   as the *fast* gate for the t3→t4 window, with PDP as the later backstop.
3. **Self-probe / Kubo + 1** (weakest): probing the S2S Kubo node proves nothing about independent
   durability — it's the SPOF itself. Do not use as the sole ready-signal.

For 99.9%, the pragmatic gate is **"Pinata pin confirmed AND root DHT-provided"** (fast, 2
independent providers) to flip, with **Filecoin PDP** as the durable backstop that triggers an alert
(not a block) if it later fails. Pinning the publish *block* on PDP would add up to ~24 h publish
latency — likely unacceptable.

### 5.5 What this does *not* need (avoid scope creep)

- No new on-chain path→root index (the attestation carries the root; the contract just stores the
  pointer — same as today).
- No changing `contenthash_wrapped` / INV-6 codec.
- No replacing `.limo`; that's a separate (§4) availability workstream.

---

## 6. Open questions / what to verify next

- `[verify]` **`.limo` contenthash cache TTL** — primary source (Etherflare docs / `eth.limo`).
  Determines how much FM-1 is accidentally masked and the publish-visibility latency.
- `[verify]` **First PDP-proof latency vs the 24 h cadence** — is the first proof within the same
  epoch (~24 h) or sooner? Sets whether PDP can ever be a publish-time gate (likely no).
- `[verify]` **Kubo `pin/add` ≠ `dht/provide`** — confirm the root is genuinely un-provided until
  Pinata; if so, an explicit `dht/provide` in `treeupdate` is a cheap win (broadens retrieval
  independent of Pinata).
- `[decide]` **Ready definition** for the gate: Pinata-confirmed + DHT-provided (fast) vs
  PDP-proven (slow). Recommend the former as blocker, latter as backstop.
- `[decide]` **Attestation freshness scheme**: `prevRoot`-challenge vs monotonic epoch vs both.
  `prevRoot`-as-challenge is the minimal replay-killer; epoch handles ordering.
- `[separate workstream]` CCIP gateway redundancy (§4) — required for 99.9% regardless of this gate.

## 7. Sources

- **Code (primary):**
  - `protocol/actions/src/update/main.ts:100–312` — tree build, `files/stat`, `pin/add`,
    `evmWrite setText` (Kubo-only; no `dht/provide`, no Pinata, no Filecoin in the action).
  - `neutralpress/src/main.ctrlr.ts:~390–426` — post-action `pinCidFromRemote` (Pinata, awaited) +
    `filecoinUploadBackground('render-root', uploadTree)` (fire-and-forget).
  - `shared/src/filecoin/index.ts:373–375` — `isRetrievable(pieceCid)` = Synapse download probe;
    `:223–246` `uploadTree` → `{rootCid, pieceCid, copies}`; `:58` `ready` field in result type.
  - `0xobsidian/src/filecoin/filecoin.ctrlr.ts` — `FilecoinStorage` adapter (`isRetrievable`,
    `uploadTree`, `uploadJson`).
- **Specs:** SPEC-00 §3.2 (storage tiers), INV-13 (CID parity), GAP-13 (Filecoin IPFS gateway not
  implemented), INV-6/INV-12 (root write/read path); SPEC-contracts-ens (C3/C5/CCIP read path);
  SPEC-protocol-actions §A3 (tree-mutation integrity gate — per-leaf, not per-root).
- **Whitepaper:** 06 DR-6.3/6.4/6.5 (PDP, 24 h proofs, 2 replicas, warm-storage guarantee
  hierarchy); 07 DR-7.2/7.6/7.7 (L2-root + CCIP, cross-client decoding, single-gateway concern).
- **Web (checked 2026-08-08):** `eth.limo` alive (HTTP 200); `eth.link` dead (178-byte S3
  placeholder, last-modified 2024-09-17).

---

## 8. Quantified gap estimates (synthesized from operational history + code)

> Incorporates the consolidated conversation history (the "two distinct lags," the measured
> `eth.link` lag, the `.limo` Redis-cache research, the port-4001 swarm findings, the
> shortening strategies) into the code-grounded timeline of §1/§3. Estimates are guesstimates with
> a stated confidence and source — not SLAs.

### 8.1 The two lags (the framing the history got right)

Debugging conflated these for a while. They are **independent** and compose into the user-visible
gap:

- **Resolution lag** — how long after the on-chain `setText` until a gateway *serves the new
  contenthash* to a reader. Governed by gateway-side caching of the CCIP result.
- **Retrievability lag** — how long after the new root CID exists until it is *actually fetchable*
  by a gateway's IPFS backend (DHT provider records propagated + a Bitswap peer reachable).

The site serves the **new** content only once **both** have elapsed. The **dangerous window** is
when resolution has elapsed but retrievability has not — the gateway resolves the new CID, tries to
fetch it, and fails. How wide that window is, and whether it is masked, is client-dependent (§8.4).

### 8.2 Estimated timeline (with confidence + source)

| Stage | Estimate | Confidence | Source / basis |
|---|---|---|---|
| **Publish-write side** | | | |
| Tree assembly on Kubo MFS (t0→t1) | 1–5 s | medium | code: `files/cp`/`rm` per page in the Lit action body; scales with page count |
| Root `files/stat` (t1) | <1 s | high | code: local stat |
| Kubo `pin/add` (t2) | <1 s | high | code: local pin (does **not** `dht/provide`) |
| Base L2 confirmation (t2→t3) | ~2 s | high | Base ~2 s block time; sequencer soft-finality fast |
| Action finalize → return to neutralpress | 2–5 s | medium | Lit action overhead + transport |
| Pinata pin accept (t4a) | 1–3 s | medium | typical pin-by-CID API latency |
| Pinata fetch tree from Kubo (t4b) | 5–30 s | low | size-dependent; **coupled to Kubo health** (Pinata pulls from the Kubo gateway) |
| Filecoin CAR export + Synapse upload (t5) | 10–60 s | medium | `uploadTree` (dag/export → Synapse) |
| First PDP on-chain proof | up to ~24 h | medium | whitepaper DR-6.4 (proofs every 24 h, 2 replicas) |
| **Resolution side** | | | |
| CCIP gateway `getText` on C3 (r1, post-L2) | <1 s | high | user-confirmed: real-time `eth_call`, no cache |
| `.limo` contenthash cache TTL | ~5 min | **low** | mid-2025 web research (Node/ethers+Caddy+Redis, resolver cache in Redis; "hotcache" in progress → likely shorter now) `[verify: current]` |
| `.link` observed lag | ~110 s | **medium** (historical) | user's own 2025 measurement (on-chain 3:27:27 → synced 3:29:17, with a revalidation fetch-failure window). **Path is alive** (2026-08-08: `vitalik.eth.link` → 200, `server: eth.limo`, `max-age=300`); `.link` is now operated by eth.limo (2024-09-20 takeover), so this measurement reflects the same Caddy+Redis stack as `.limo` |
| Brave native `.eth` | ~0 (resolution) | high | live CCIP, no cache — but redirects to `ipfs.io/ipfs/{CID}` (swaps to another gateway's cache) |
| **Retrievability side** | | | |
| DHT provider-record propagation (post-Pinata) | 1–10 min | low | IPFS provider-record republish/propagation; Pinata providing is what makes the root broadly reachable |
| Public-gateway Bitswap fetch (r2) | 1–30 s typical; **can time out** | low | user-measured: `ipfs.io` timed out on a CID `dag/get` could fetch from the self-hosted node — when swarm (port 4001) was unreachable |

### 8.3 The dangerous window, estimated

Pointer moves at **t3**. New root is durably/broadly retrievable at **≈ t4b + DHT propagation**.
Guesstimate of that window:

```
t3 → retrievable ≈  (2 s L2) + (2–5 s action return) + (5–30 s Pinata fetch) + (1–10 min DHT)
                 ≈  **~1 to ~11 minutes**
```

So: **on the order of 1–11 minutes** during which the on-chain pointer is the new root but that
root is single-node (Kubo) or not-yet-DHT-provided. Filecoin-proven durability lags far further
(up to ~24 h for the first PDP proof) — that is a *backstop* tier, not a publish-time gate.

### 8.4 Why "uptime" is client-dependent (the core of the problem)

The mask depends on whether the client's resolution lag is **longer** than the retrievability lag:

- **`.limo` (~5 min cache):** if retrievability < 5 min → gateway keeps serving the **old durable**
  root until cache expiry → **stale-but-available** (masked). If retrievability > 5 min → gateway
  resolves the new CID, fetch fails → **down** (unmasked). So `.limo` masks *only when lucky*.
- **Brave / direct-CCIP (no cache):** resolves the new CID at t3 + ~1s → must fetch immediately →
  **fully exposed** to the 1–11 min window. No mask.
- **Cross-client CID encoding** (whitepaper DR-7.6; Brave showed `bciq…` vs `bafybei…`) adds a
  *correctness* failure mode on top of the availability one — a client may resolve but decode wrong.

> **The problem, with numbers:** every publish opens a ~1–11 minute window where the on-chain
> pointer is the new root but that root is single-node / not-DHT-provided. Cached gateways (`.limo`)
> accidentally mask it *iff* their cache TTL exceeds the retrievability lag — which is not
> guaranteed and not a designed property. Uncached clients (Brave, direct CCIP) are fully exposed.
> Filecoin durability lags up to ~24 h (PDP cadence) and is not yet a *retrieval* tier (GAP-13). So
> "99.9% uptime" is not just unclosed — it is **not even uniformly definable** across clients today.

### 8.5 The structural retrievability finding (deeper than the cache)

The history surfaces a root cause my code read missed: **the self-hosted Kubo node's *swarm*
connectivity is the actual SPOF for IPFS-native retrieval**, distinct from its HTTP gateway.

- The node's **RPC API** (`ipfs.transport-union.dev/api/v0/...`) was publicly reachable while its
  **swarm** (port 4001, TCP+UDP) was not — after a router replacement, port 4001 wasn't forwarded.
- Symptom: `dag/get` worked against the self-hosted node, but `ipfs.io` **timed out** on the same
  CID. The node was a **gateway-only node**, not a real Bitswap/DHT participant.
- Consequence: until **Pinata** pins + provides (t4), the root is unreachable from *any* public
  IPFS gateway — the self-hosted node can serve it over HTTP but cannot answer Bitswap requests. So
  the "single-node" claim in §1 is sharper than "one node holds it": it's "**one HTTP gateway holds
  it, zero swarm peers can serve it**" until Pinata.

This means the retrievability lag is dominated by **Pinata's pin + DHT provide**, not by the
self-hosted node at all — the self-hosted node contributes a gateway but (when swarm is broken) no
Bitswap availability. The port-4001 health is a **silent, unmonitored** dependency.

### 8.6 Strategies to shorten time-to-availability (ranked, from the history)

| Strategy | Effect | Cost | Notes |
|---|---|---|---|
| **Explicit `routing/provide` after pin** | advertises the root to the DHT immediately (don't wait for Pinata) | trivial | the action currently does **not** call it; cheapest win for broadening retrieval independent of Pinata |
| **Peering with Pinata/public nodes** (`Swarm.Peering`) | Bitswap fetch beats DHT lookup — pinned peer is a known provider | low (config) | makes the self-hosted node + Pinata a tight Bitswap pair; helps even before DHT propagates |
| **Multi-service pin** (Pinata + a 2nd pinning service) | more DHT provider records → faster gateway discovery | low | raises the provider count; the redundancy also helps 99.9% |
| **Warm public gateways** (HEAD requests post-pin) | pre-fetches the root into gateway caches | low | trades a few HEAD calls for faster first-read; also exercises the path |
| **Pinata `pinByHash` + `hostNodes`** | Pinata fetches from a known node directly (not DHT) | low | fallback when swarm is broken; needs the node's multiaddr in Pinata's allowlist |
| **CAR export + direct upload** (Pinata/Filecoin) | bypass Bitswap entirely | medium | the reliable route when swarm is broken (already used for Filecoin `uploadTree`) |

**Cheapest high-leverage pair:** `routing/provide` in the action + `Swarm.Peering` with Pinata.
Together they cut the DHT-propagation portion of the window (1–10 min) toward zero *without*
waiting on Pinata's own provide. They do **not** remove the single-node window (still one holder
until Pinata pins) — for that you need the durability gate (§5.1).

### 8.7 Reconciliation notes (don't trust stale figures)

- **`.link` is alive but now operated by `eth.limo`** (2024-09-20 takeover per Binance; confirmed
  2026-08-08: `vitalik.eth.link` → `server: eth.limo`, `max-age=300`). The bare `eth.link` domain
  is an abandoned S3 placeholder — that fooled an earlier draft of this note. The 110 s
  measurement is a valid *behavioral* data point for the eth.limo Caddy+Redis stack's
  revalidation lag (~2 min, with a fetch-failure sub-window). **Critical implication: "limo and
  link" are one operator, two domain fronts — not redundant.** For 99.9% they are a single
  external failure domain (§4).
- **`.limo` 5-min figure is mid-2025 research — now verified current.** The live response for
  `vitalik.eth.link` (served by eth.limo) carries `cache-control: max-age=300, must-revalidate`
  (2026-08-08). "hotcache in progress" (mid-2025) may still shorten it further, but 5 min is the
  confirmed present value. This single number determines how much of the window is accidentally
  masked for `.limo`/`.link` readers.
- **The 20-min Optimism fraud-proof figure** (noted in history) applies to *provable* L2-backed
  resolution, **not** this setup (Base soft-finality + a real-time CCIP gateway). Do not carry it
  into estimates.
- **Base ~2 s** is the one well-pinned number; it is negligible in the total.

---

## 9. Revised problem statement (with the numbers)

1. Every publish moves the on-chain pointer to a new root that is **single-node + zero-swarm-peers**
   at that instant (the Kubo node's HTTP gateway serves it, but unless port 4001 is healthy it
   answers no Bitswap requests), and only becomes broadly retrievable when **Pinata** pins + provides
   (~5–30 s pin + 1–10 min DHT propagation) → a **~1–11 minute dangerous window** per publish.
2. `.limo`'s ~5-min contenthash cache *accidentally* masks this **iff** retrievability < cache TTL —
   not guaranteed, not designed. Uncached clients (Brave, direct CCIP) are fully exposed. So
   availability is **client-dependent**, not uniform.
3. Filecoin durability lags up to ~24 h (PDP cadence) and is not yet a *retrieval* tier (GAP-13) —
   it is an archive backstop, not a publish-time gate.
4. The read path has ≥3 SPOFs (one CCIP gateway, one Kubo node, one **operator** serving both
   `.limo` and `.link`) that no publish-side gating fixes — 99.9% needs CCIP-gateway redundancy +
   multi-**operator** reads *in addition* to closing the time gap. Note: `.limo` and `.link` are
   the same operator (eth.limo, confirmed 2026-08-08) — they do **not** count as independent.
5. The proposed `treeupdate`/`evmupdate` split + root attestation (§5) closes (1) by making the
   pointer flip *contingent* on a readiness signal — but "ready" must be defined (recommend
   Pinata-confirmed + DHT-provided, fast; PDP as backstop alert), and the attestation must be
   replay-safe (`prevRoot`-as-challenge + monotonic epoch). It is a **new root-level** attestation,
   not the existing per-leaf §A3 gate.

**Net:** the time-gap problem is real, ~1–11 min/publish, partially and inconsistently masked, and
closing it is *necessary but not sufficient* for 99.9%. The split is the right shape of fix; the
open work is defining "ready" and making the root attestation replay-safe.

---

*First entry in `brain/research/`. Proposed convention: dated slug (`YYYY-MM-DD-<topic>.md`),
metadata block, problem-first, sources cited per claim, `[verify]`/`[decide]` markers for open
items. Distinct from `specs/` (system contract), `handoffs/` (transient work pointers),
`whitepaper/` (protocol-level decisions).*
