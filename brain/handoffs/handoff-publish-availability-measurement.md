# Handoff: Publish→availability measurement — instrument the gap in neutralpress (2026-08-08)

**Date:** 2026-08-08
**Scope:** Transient work pointer to a next implementation step. The *problem* is framed and
quantified in two research notes (not re-derived here); this handoff specifies the *measurement
instrumentation* to build in neutralpress. It was sketched in conversation but **not implemented**
— the user asked for this handoff instead.
**Status:** Research complete; instrumentation not started.

## Context — read the research notes, not this handoff, for the problem

Two notes in `brain/research/` are the durable reference:

1. `2026-08-08-publish-availability-time-gaps.md` — the problem, code-grounded + quantified. §5 =
   solution space (the `treeupdate`/`evmupdate` split + root attestation); §8 = the guesstimates
   with confidence; §9 = revised problem statement.
2. `2026-08-08-publish-availability-measurement-protocol.md` — how to turn §8 guesstimates into
   measured data (Meas-1 resolution lag, Meas-2 retrievability lag, Meas-3 composition, Meas-4
   client matrix) + a 2026-08-08 static-probe snapshot with three live findings.

This handoff is the pointer to the **next actionable step**: ship a real measurement against a live
publish, inside neutralpress.

## The problem, one paragraph

Every publish moves the on-chain root pointer (t3) to a new root that is **single-node +
zero-swarm-peers** at that instant, and only becomes broadly retrievable when Pinata pins+provides
(~5–30 s pin + 1–10 min DHT propagation) → a **~1–11 min dangerous window** per publish. `.limo`'s
~5-min contenthash cache *accidentally* masks it **iff** retrievability beats the cache TTL (not
guaranteed, not designed); uncached clients (Brave, direct CCIP) are fully exposed. Filecoin
durability lags up to ~24 h (PDP cadence) and is not yet a retrieval tier (GAP-13). Closing the gap
is *necessary but not sufficient* for 99.9% — the read path also has ≥3 SPOFs (one CCIP gateway;
one Kubo node; **one operator** behind both `.limo` and `.link`).

## Hard-won findings that must not be re-derived

These were corrections during the research. Trust them; do not re-litigate without new evidence.

- **`.limo` and `.link` are ONE operator** (eth.limo), two domain fronts. Confirmed 2026-08-08:
  `vitalik.eth.link` → 200, `server: eth.limo`, `cache-control: max-age=300, must-revalidate`.
  eth.limo took over eth.link resolution ~2024-09-20 (per a Binance post). **They are NOT
  redundant for 99.9%** — a second *operator* is the only real read-path redundancy. (The bare
  `eth.link` domain is an abandoned 178-byte S3 landing page — that fooled an earlier draft into
  calling `.link` dead. Subdomain resolution is alive; the bare domain is just a placeholder.)
- **The 5-min `.limo` cache is verified current** (`max-age=300, must-revalidate` on the live
  response), not just mid-2025 research. This single number governs how much of the dangerous
  window is accidentally masked.
- **🔴 Open finding — S2S publication subdomains may be TLS-broken on `.limo`.** The static probe
  found `*.soul2soul.eth.limo` (4-label, the publication form) → TLS rejection
  (`tlsv1 alert internal error`), while 3-label `soul2soul.eth.limo` → 200 and a different parent
  `app.uniswap.eth.limo` (4-label) → TLS-succeeds-then-500. Hypothesis: `.limo` has no
  `*.soul2soul.eth.limo` wildcard cert. **If confirmed, S2S publications currently have ZERO
  third-party gateway path** (only the root works). This reframes everything — verify before
  trusting any `<pub>.soul2soul.eth.limo` measurement. The known-live publication
  `s3nl.soul2soul.eth.limo` is exactly this 4-label form, so the first measurement run doubles as
  the verification of this finding.
- **The self-hosted Kubo node's swarm (port 4001) is a silent SPOF.** Historically the node was
  gateway-reachable but swarm-unreachable → it serves HTTP but answers no Bitswap requests. So
  "single-node" really means "one HTTP gateway holds it, zero swarm peers can serve it" until
  Pinata provides. `pin/add` ≠ `dht/provide` (the action never calls provide) — `[verify Kubo
  internals]`.
- **`isRetrievable(pieceCid)`** (`shared/src/filecoin/index.ts:373–375`) is a Synapse SP-retrieval
  probe, pieceCid-keyed — NOT IPFS-gateway retrievability, NOT PDP-proven. "Ready" is ill-defined
  today; the gaps note §5.4 recommends **Pinata-confirmed + DHT-provided** (fast) as the gate,
  PDP (~24 h) as a backstop alert only.

## The instrumentation to build (neutralpress-side, passive observation)

**Trigger:** the ENS record change (`setText`, = t3), detected inside neutralpress after a
publication. neutralpress already does the `evmWrite` and knows `{tx, cid (new root), publication
URL}` — hook the instrumentation there, alongside the existing post-publish `pinCidFromRemote` +
`filecoinUploadBackground`. This is passive: it reads post-publish state, it does not change the
publish path.

**Publication target:** the publication URL neutralpress already has — **take it as a variable, do
NOT hardcode.** Whatever just published is the target. (`s3nl.soul2soul.eth` is one known-live
instance and the natural first run, because it also settles the `.limo` TLS finding — but the code
must take the URL as a parameter.)

### Three parallel listeners, started at t3, polled in a loop, timestamps recorded

**Clean split by design: listener 1 measures the cache; listeners 2/3 measure retrievability of
the new CID. The masked-vs-exposed verdict is the *comparison* of the two (see Output), not baked
into any single listener.**

**1. Cache — when does `.limo` switch from old CID to new CID.** `.limo` caches the contenthash
(~5 min, `max-age=300`), so after t3 it keeps serving the OLD root. Listener 1 measures that cache:
how long the mask holds and when it switches. **Do not diff HTML.** Poll `HEAD` the publication
URL; capture `x-ipfs-path` (the served CID) + `age` + HTTP status. neutralpress has `CID_new`
(action return); capture `CID_old` pre-publish (one HEAD, or the current on-chain contenthash).
Compare CIDs as decoded bytes, not strings (DR-7.6 multibase divergence). The metric listener 1
owns is the **switch point** — the first poll where `x-ipfs-path == CID_new`:
- `x-ipfs-path == CID_old` → still masked (`age` climbing toward 300).
- `x-ipfs-path == CID_new` → **switched** ← the cache measurement.
- HTTP error / no `x-ipfs-path` → fetch-failure (resolved new CID but can't fetch it). This phase
  *is* the reader-experienced exposed window, but its *cause* is retrievability — listeners 2/3's
  job. Listener 1 records it; it doesn't own it.
`age` at t3 predicts the switch: expires ≈ t3 + (300 − age). *[Meas-1.]*
**Optional add (not core to listener 1):** a parallel direct-CCIP probe
(`ccip.transport-union.dev`, uncached, fresh `eth_call` → returns CID_new at ~t3+1s) gives the
uncached resolution floor, so `cache-delay = limo-switch − CCIP-new`. Without it the switch point
is still measured; the floor just isn't decomposed. Add if cheap.
**Path caveat:** the `.limo` form (`<pub>.soul2soul.eth.limo`, 4-label) is the one the static probe
predicts TLS-broken. If listener 1 returns TLS errors, that *is* the finding (path dead); fall back
to direct CCIP / preview gateway (`preview.transport-union.dev`).

**2. Pinata gateway — retrievability.** `HEAD`/`GET` the new root CID on Pinata's gateway
(`gateway.pinata.cloud/ipfs/<cid>`) in a loop until it succeeds. The first-200 timestamp =
Pinata-provided. *[Meas-2; the Pinata-provide unblock point.]* Confirm the exact Pinata gateway
hostname before implementing.

**3. ipfs.io — retrievability.** `HEAD`/`GET` `<cid>` on `https://ipfs.io/ipfs/<cid>` in a loop
until it succeeds. The first-200 timestamp = broad DHT-provided. *[Meas-2 broad-retrievability
proxy; the DHT-propagation signal.]*

### Output — compare timestamps, report in the neutralpress console log

Record: `t3`, `t-cache-switch` (listener 1), `t-pinata` (2), `t-ipfs.io` (3).

The decision-relevant synthesis is the **comparison** of the cache switch (listener 1) vs
retrievability (listeners 2/3), where `t-retrievable = min(t-pinata, t-ipfs.io)`:

- `t-retrievable` **<** `t-cache-switch` → **graceful**: by the time the cache drops the old root,
  the new one is already fetchable → readers go old→new, no errors. The cache is load-bearing but
  working.
- `t-retrievable` **>** `t-cache-switch` → **exposed**: cache switched before the new CID was
  fetchable → readers hit fetch-failure (listener 1's error phase) = actual downtime. The mask
  failed.

That single comparison, over N publishes, is the number that tells you whether the split (gaps
note §5) is urgent-on-fire or urgent-but-tolerable.

### What this maps to in the protocol note

This is **Meas-3 (composition) instantiated** — a real publish with both ends instrumented, using
public-gateway HEAD probes (the curl-only subset) rather than DHT `findprovs` (which needs a probe
node). It does NOT cover: the A/B `routing/provide` comparison (needs a probe node),
`findprovs`/`findpeer` (port-4001 swarm diagnosis), or the client matrix (Meas-4). Those remain the
"stand up a throwaway probe node" follow-up — the highest-value single next step after this
instrumentation ships.

### Why do this first (before the full split)

It produces the one decision-relevant number: **is the dangerous window masked or exposed in
practice for real publishes?** If `t-retrievable < t-cache-switch` consistently (graceful), the
`.limo` cache is load-bearing (fragile but working) and the split is urgent-but-not-on-fire. If
`>` (exposed) or the `.limo` path is TLS-broken, it's on-fire. Either way it converts §8
guesstimates into measured data against the publication that just published — building the split on
measured data rather than guesstimates.

## Open verification items (prioritized)

1. **Verify the `.limo` subdomain TLS finding against `s3nl.soul2soul.eth.limo` specifically.** It
   is a known-live name, so a TLS success/failure here settles the finding definitively (the static
   probe used candidate names that may not exist, but TLS failure is name-existence-independent —
   still, confirm on a real name). The first listener-1 run does this naturally.
2. **`.limo` path is listener 1's core; direct-CCIP is the optional add.** The path caveat is
   already inline in listener 1 (fall back to direct CCIP / preview gateway if `.limo`
   TLS-rejects). No separate decision — act on whatever listener 1 returns.
3. `[verify]` `.limo` contenthash cache TTL — 5 min is confirmed present as `max-age=300`; confirm
   actual *served-stale* behavior on a real flip (listener 1 does this).
4. `[verify]` **First PDP-proof latency vs the 24 h cadence** — sets whether PDP can ever be a
   publish-time gate (likely no). Not blocked by this instrumentation.
5. `[verify]` **Kubo `pin/add` ≠ `dht/provide`** — if so, an explicit `routing/provide` in the
   action is a cheap independent-retrieval win (gaps note §8.6). Needs the probe node to A/B test.
6. `[decide]` **Ready definition** for the eventual durability gate: Pinata-confirmed +
   DHT-provided (fast, recommended) vs PDP-proven (slow). The measurement informs this.
7. `[separate workstream]` CCIP gateway redundancy (gaps note §4) — required for 99.9% regardless
   of the gate.

## Scope guard — what this does NOT need

- **Do not implement the `treeupdate`/`evmupdate` split or the root attestation yet.** That's the
  *solution* (gaps note §5); this handoff is the *measurement* that informs whether/how urgently
  it's needed.
- **Do not touch the `update` action or the contract.** The instrumentation is neutralpress-side
  observation only. (Prof never touches code; this handoff is for whoever picks up the
  implementation.)
- **Do not run `setText` probes on real publications.** The instrumentation measures *real*
  publishes as they happen (passive). If a synthetic triggered publish is needed, use a dedicated
  probe name, not live publications.
- **No new on-chain path→root index, no `contenthash_wrapped` codec change** — out of scope (gaps
  note §5.5).

## Reference

- Problem + estimates: `brain/research/2026-08-08-publish-availability-time-gaps.md` (§5 solution
  space, §8 numbers, §9 revised problem statement).
- Measurement design + live snapshot: `brain/research/2026-08-08-publish-availability-measurement-
  protocol.md` (Meas-1..4; §"Live snapshot" Finding 1 = the `.limo` TLS issue the first run
  verifies).
- System contract: `brain/specs/SPEC-00-system-contract.md` (§3.2 storage tiers, GAP-13 Filecoin
  IPFS gateway not implemented, INV-6/INV-12 root write/read path).
- Related (leaf-level integrity gate, composes with the eventual root attestation):
  `brain/handoffs/handoff-tree-mutation-integrity-gate.md` + SPEC-protocol-actions §A3.
- Code anchors: `protocol/actions/src/update/main.ts:279–302` (root→pin→setText, Kubo-only);
  `neutralpress/src/main.ctrlr.ts:~390–426` (post-publish Pinata + Filecoin — the hook point for
  the instrumentation); `shared/src/filecoin/index.ts:373–375` (`isRetrievable`).
