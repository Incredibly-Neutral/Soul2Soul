---
name: s2s-filecoin-storage
description: >
  Dual-path storage pipeline: upload to both a remote Kubo IPFS node (instant
  availability) and Filecoin Onchain Cloud (durable storage) with deterministic
  CID matching via the unixfs-v1-2025 profile.
---

# Filecoin + IPFS Dual Storage Pipeline (Soul2Soul)

## Architecture

```
signedJSON ──→ addJson() ──→ Kubo /api/v0/add ──→ IPFS CID (instant gateway)
           ──→ buildCarFromBytes() ──→ uploadToSynapse(CAR) ──→ pieceCid (durable)
           ──→ compare: IPFS CID === rootCid? → [cid-ok] or [cid-mismatch]
```

Both paths receive **identical bytes** (`JSON.stringify(data, null, 2)`), and both use the
**unixfs-v1-2025 profile** (CIDv1, sha2-256, 1 MiB chunks, raw leaves, balanced layout),
so the Root CIDs are guaranteed to match.

**Kubo node must also use this profile** — run once:
```bash
ipfs config profile apply unixfs-v1-2025
```

## Code Locations

| Function | File | Purpose |
|---|---|---|
| `addJson()` | `0xobsidian/src/ipfs/remotekubo.service.ts` | Upload to Kubo, returns IPFS CID |
| `FilecoinController.uploadJson()` | `0xobsidian/src/filecoin/filecoin.ctrlr.ts` | Build CAR + upload to Filecoin SPs |
| `FilecoinController.uploadToKubo()` | `0xobsidian/src/filecoin/filecoin.ctrlr.ts` | Delegates to `addJson()` |
| `publishToPublication()` | `neutralpress/src/main.ctrlr.ts` | Orchestrates dual upload + CID verify |
| `fund-account.ts` | `protocol/scripts/filecoin/fund-account.ts` | Deposit fixed USDFC into Pay contract |

## Key Gotchas

### 1. Transport: use `https.request` not `electron.remote.net.request`

`net.request` (Electron/Chromium stack) **times out** connecting to remote Kubo nodes.
`https.request` (Node.js stack) works. The existing functions `getJsonLike()` and
`getFile()` already use `https.request` — follow their pattern.

### 2. Response chunking: accumulate, parse on `end`

Kubo splits HTTP responses across multiple `data` events. Never `JSON.parse` on the
first `data` event — always:

```ts
const chunks: Buffer[] = [];
response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
response.on("end", () => {
  const body = Buffer.concat(chunks).toString("utf-8");
  const parsed = JSON.parse(body.trim().split("\n").pop());
});
```

### 3. Add a timeout

Networking to remote Kubo can hang. Always wrap in a timeout:

```ts
let settled = false;
const done = (err, result) => { if (settled) return; settled = true; clearTimeout(timer); ... };
const timer = setTimeout(() => done(new Error("timeout")), 30000);
```

### 4. JSON serialisation must be identical

Both paths must use `JSON.stringify(data, null, 2)` (pretty-printed). The `add()`
function in `remotekubo.service.ts` uses compact JSON — do NOT use `add()` for CID
matching. Use `addJson()` which uses pretty-printed format.

## Setting Up a New Payer

1. **Fund the wallet** with FIL (gas) + USDFC (storage) on FEVM mainnet
2. **Generate a session key**: `pnpm filecoin:setup-key` (protocol/)
3. **Deposit lockup**: `pnpm filecoin:fund-account 6` (deposits 6 USDFC)
4. **Verify**: `pnpm filecoin:check-status`

## Maintenance

| Task | When | Cost |
|---|---|---|
| Top up FIL for gas | When wallet < 1 FIL | Per-publish gas: ~0.00023 FIL |
| Renew session key | Before June 2027 | Protocol tx |
| Deposit more USDFC | Rarely | 6 USDFC covers ~9k years of storage |

## Verification

```bash
# Check status
pnpm filecoin:check-status

# Test retrieval from Filecoin
tsx ./scripts/filecoin/retrieve-test.ts <pieceCid>

# Test retrieval from Kubo gateway
curl https://ipfs.transport-union.dev/ipfs/<rootCid>

# Check CID match in publish logs
# Look for: [kubo] uploaded: <cid> then [cid-ok] both paths agree on root CID
```

## Files Changed During Implementation

- `0xobsidian/src/ipfs/remotekubo.service.ts` — added `addJson()` export
- `0xobsidian/src/filecoin/filecoin.ctrlr.ts` — switched to filecoin-pin CAR builder
- `0xobsidian/src/settings.ts` — added `kubo_url` setting
- `neutralpress/src/main.ctrlr.ts` — dual upload + CID comparison in `publishToPublication()`
- `protocol/scripts/filecoin/fund-account.ts` — fixed-amount deposit script
- `protocol/package.json` — added `filecoin:fund-account` script