# Lit Action Registry — Adoption / Usage Analysis (Base 8453)

Date: 2026-09-18
Registry: `0xaaaAA9120fE271F653cfDb6bf400dB93D2DEa7Aa` (EIP-2535 Diamond, custom/deployment-specific Lit deployment on Base — NOT the public Datil network, which runs on chain 175188). Unverified contract; events decoded by Blockscout signature matching.

Data source: Blockscout API v2 (base.blockscout.com) full pagination of the registry's transactions and event logs, incremental-saved to `~/lit-adoption/data/`. Scan span 2026-07-17 → 2026-09-18 (~2 months). Last pass was still draining the final rate-limited pages at write time; totals are ~final.

## Headline: unique users

- **42 total unique sender wallets** over ~5 months (May–Sep 2026) on the registry.
- **~10–11 unique senders active per day** — stable, not growing (unique-by-month: May 11, Jun 26, Jul 21, Aug 17, Sep …).
- Unique senders per activity type (this is the real "how many users" answer):
  - ActionAdded (registered a new action): **1,960 events / 19 unique senders**
  - ActionAddedToGroup: 2,558 / 16
  - ActionRemoved: 331 / 14
  - ActionRemovedFromGroup: 362 / 12
  - PkpAddedToGroup: 1,591 / 11
  - WalletDerivationRegistered: 2,065 / 17
  - UsageApiKeySet: 366 / 18
  - GroupAdded: 224 / 18
  - AccountCreated: 173 / 15

Interpretation: a handful (a dozen–twenty) of distinct wallets drive essentially all on-chain activity. The operator reports ~300 of the ActionAdded as their own; even generously, that leaves < ~1,700 registrations from everyone else combined across fewer than 20 wallets. If more of those wallets are the operator's keys, third-party adoption is near zero.

## Actions (FINAL, complete data)

- ActionAdded (distinct action registered): **1,960**
- ActionAddedToGroup: **2,558**
- ActionRemoved: 331
- ActionRemovedFromGroup: 362
- Total added (add + add-to-group): **4,518**; removed: 693; net added: **~3,825**

2026-09-17 shows 235 remove-events (232 ActionRemoved + 3 ActionRemovedFromGroup) — matches the operator's "removed ~200 actions from group" cleanup; counted separately from adds, so it does not pollute the added count. Add activity is bursty: biggest add-day 2026-09-14 (≈314), then 09-11 (72), 09-03 (80).

## PKPs / accounts (FINAL, complete data)

- PkpAddedToGroup: 1,591 events; **1,525 distinct PKP ids** added to groups (approx. active-PKP count).
- AccountCreated: 173; GroupAdded: 224
- 198 distinct apiKeys; 115 distinct groups.

Note: PKP **mints** live on a separate PKP-NFT contract (unverified, custom deployment, not yet located); distinct PKP ids in the registry is a proxy, not the mint count.

## Volume / trend

- Lifetime registry txs ≥ 20,000 (Blockscout 20k cap = floor). Monthly: May 1,078 → Jun 5,518 → Jul 8,740 (peak) → Aug 3,102 → Sep 1,562. **Declining.**
- Busiest single day 2026-07-28 (1,647 txs); recent: 09-11 216, 09-14 396, 09-17 325, 09-18 13.
- Avg ~167 txs/day across 120 active days.

## Is "20,000 actions / day" believable?

Per operator clarification: the 20,000/day figure refers to **off-chain Lit Action executions**, not on-chain registry transactions — so this analysis does NOT attempt to verify it. On-chain registry volume is a different, smaller signal (see Volume/trend above: hundreds of txs/day at most, and declining). Off-chain action executions emit no per-execution events on this registry, so they are **not measurable from on-chain data**; confirming 20k/day would require node-side metering, PKP-signing event logs, or a usage/metering contract. On-chain data neither confirms nor refutes the off-chain claim.

## Caveats / follow-ups
- Blockscout v2 API caps pagination at 20,000 records per endpoint; both registry txs and logs hit that cap, so all lifetime figures are **floors**, not exact totals. Per-day and unique-sender figures are exact (full-day windows fully paginated, newest-first).
- PKP mint contract + PKP usage-for-decryption/signing (off-chain) not yet measured; both need separate investigation.
- Distinct PKP ids is a floor on active PKPs; real mint count requires the PKPNFT contract.

## Artifacts
- `~/lit-adoption/data/registry_txs.jsonl` — full tx list
- `~/lit-adoption/data/registry_logs_full.jsonl` — full decoded event logs
- `~/lit-adoption/work/bs_paginate_logs.py` / `bs_paginate_incr.py` — paginators
