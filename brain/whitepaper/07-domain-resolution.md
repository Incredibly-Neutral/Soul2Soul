---
component: domain-resolution
protocol: soul2soul
number: 7
status: active
last_reconstructed: 2026-07-15
source: reconstructed from joera↔Claude history; the CCIP-Read gateway, custom ENS contracts, L1/L2 split, DNS/gateway concerns
---

# Component 7 — Domain resolution (ENS + CCIP-Read)

> Reconstructed for machine memory. This component is the **naming layer**: how a human-readable
> name resolves to the current content-tree root, and the **CCIP-Read gateway + custom contracts**
> that make L2-stored roots resolvable from L1. It is the **target of Component 5's UPDATE write**.
> Decision entries preserved as discussed. Gaps marked `[GAP]`.

## Functional description

A human-readable naming record that resolves to the **current content-tree root**, giving a
publication a stable address that follows it as the site is rebuilt. In S2S each publication is a
**subdomain of `soul2soul.eth`** (e.g. `alice.soul2soul.eth`); resolving it returns the
`contenthash` (an IPFS CID) that a gateway then serves.

The twist that defines this component: the **site root is stored on L2 (Base)**, but **all ENS
resolution starts on L1 (Ethereum mainnet)** — so a **CCIP-Read** (EIP-3668) offchain-lookup flow
bridges the two, via a **custom gateway** and **custom resolver/records/registry contracts**.

## Minimum guarantee (protocol-level)

- Records must be **affordable** to register/maintain, and **writable only by the protocol key**
  (the PKP) as the result of a verified publish — never by an outside operator.
- Ownership of the name must be **verifiable on-chain** and resistant to seizure by any intermediary.
- The name **resolves to a content hash** (not an IP), and follows the site across rebuilds.

## Reference implementation (custom contracts spanning L1 + L2)

Deployed **once for the protocol** (not per publication). High blast radius — controls naming and
the root pointer for every publication. Reusable as a standalone "neutral hosting" primitive.

- **C3 — `ENSSubdomainRecordsContract` (`ENSL2nRecords.sol`, Base/L2)** = `protocolInfo.ensRecords`.
  The L2 store where the published **site root** lives: `textRecords[node]["contenthash_wrapped"]`.
  - `setText(node,key,value)` / `setAddress` / `batchSetRecords` — **`onlyAuthorized`**
    (authorizedCallers ∨ owner). **The PKP writes the root here.**
  - `authorizeCaller(addr,bool)` — owner ∨ `protocolAddress`; grants write rights.
  - `getText(node,key)` / `getRecords` — view; **read by the CCIP gateway.**
- **C4 — `ENSOpenSubdomainRegistry` (L1)** — owns wrapped `soul2soul.eth`.
  `registerSubdomain(label, owner)` is **free/permissionless** and makes `owner` (the publication
  Safe) the subnode owner via `nameWrapper.setSubnodeOwner`. Labels `a-z 0-9 -`, ≤63 chars. Holds
  `parentDomainController` (controller Safe), which can `reclaimParentDomain`. This is what
  `getProtocolControllerAndModules` walks for discovery (INV-4).
- **C5 — `ENSResolverWithCCIP` (`ENSResolverWithCCIP.sol`, L1)** — the read path. ENSIP-10 wildcard
  resolver. `resolve(name,data)` namehashes the name, then for `contenthash`/`addr` reverts
  `OffchainLookup(rpcUrls, encode(C3, getText(node,key)))`. The client calls the **`ccip_gateway`**,
  which `eth_call`s `getText` on C3 (Base) and returns the value; the callback decodes it.
- **Gateway** — `https://ccip.transport-union.dev/gateway` (a service): accepts the CCIP POST,
  `eth_call`s C3 on Base, returns the contenthash bytes in CCIP-Read format (needs CORS).

## The request flow (browser → IPFS)
```
User → publication.soul2soul.eth.limo
  → .limo gateway does ENS resolution on L1 mainnet
  → L1 resolver (C5) reverts OffchainLookup (CCIP-Read)
  → client/gateway calls the CCIP gateway
  → gateway eth_calls getText(node,"contenthash_wrapped") on C3 (Base/L2)
  → returns contenthash bytes → decoded → ipfs://<cid>
  → .limo fetches from an IPFS gateway → serves page
```

---

## Decision record

### DR-7.1 — Publications are ENS subdomains of `soul2soul.eth`; name follows the site
**When:** 2025 →
**Decision:** Each publication is a subdomain of `soul2soul.eth`, subnode owned by the publication
Safe via NameWrapper (L1). The name resolves to `contenthash_wrapped` and stays stable across
rebuilds.
**Status:** current.

### DR-7.2 — Site root on L2, resolution from L1 → CCIP-Read is mandatory *(load-bearing)*
**When:** 2025-07 → ongoing
**Decision:** The site root lives on **Base (L2)** (cheap writes by the PKP), but **ENS resolution
always begins on L1**. Bridge with **CCIP-Read (EIP-3668)**: an L1 wildcard resolver (C5) defers to
an L2 records contract (C3) via a **custom gateway**.
**Rationale:** L2 for affordable/frequent root updates; L1 because that's where ENS resolution
starts for every client.
**Status:** load-bearing; this is the defining architectural choice of the component.

### DR-7.3 — Only the PKP writes the root (INV-12: authorizedCaller)
**When:** 2026-07-02
**Decision:** The site-root write (`setText(node,"contenthash_wrapped",…)` on C3) is `onlyAuthorized`.
**INV-12:** the PKP eth address must be an **`authorizedCaller` on C3**, *in addition to* the Lit
group permission (INV-8). `update-protocol.ts` grants it (`authorizeCaller(pkp.ethAddress,true)`) in
the same Safe batch that writes the action-CID records. **Rotating the PKP requires re-running it.**
Desync (group-permitted but not authorizedCaller) → publish `setText` reverts `"Not authorized"`.
**Status:** load-bearing invariant.

### DR-7.4 — Cross-chain same-address Safe requirement
**When:** 2026-07-02
**Decision:** A publication's Safe is the **ENS subnode owner on L1** (via NameWrapper) **and** the
module host on **L2** — **at the same address**. Deterministic Safe deployment must hold across both
chains, or resolution (L1) and gating (L2) point at different Safes.
**Note:** this is the same **CREATE2 same-address** requirement that Lens Chain (ZKsync) *broke*
(Component 2, superseded) — here on Base/L1 it holds.
**Status:** current; a deploy-path invariant to verify.

### DR-7.5 — `contenthash` encoding & the hex-conversion class of bugs
**When:** 2025-07 → 2025-11
**Facts:** the root is an ENS **contenthash** — `0xe3 01 <cid bytes>` (ipfs-ns). Much debugging time
went into **hex-string → bytes** conversion in the resolver callback and **first-character
truncation** issues (ENS UI expects `abi.encode(bytes)`, drops a char on malformed input). Also a
**UnixFS (dag-pb) vs dag-cbor** choice: **UnixFS preferred for ENS gateway compatibility**.
**Status:** resolved-through-debugging; recorded because the encoding is fragile and regressions here
silently break resolution.

### DR-7.6 — DNS/gateway access: `.limo` / `.link`, and client CCIP support *(concern)*
**When:** 2025-11 → 2025-12
**Concern:** Users reach publications through **DNS gateways** — `publication.soul2soul.eth.limo`
(or `.link`) — because ordinary browsers don't resolve `.eth` natively. Every path (`.limo`, `.link`,
Brave, etc.) **must go through CCIP** to get the CID — there is **no fallback contenthash stored on
mainnet**. Observed failure mode: different clients **decode the same gateway bytes differently**
(one shows `bafybei…`, another `bciq…`), i.e. an **encoding/decoding mismatch**, not a resolution
failure. `.limo`/`.link` worked while a native browser (Brave) showed a wrong CID.
**Status:** a live class of concern — resolution correctness depends on the whole client→gateway→L2
encoding chain agreeing; brittle across clients.

### DR-7.7 — ENSv2 future: gateway becomes less second-class *(watch item)*
**When:** 2026-03-25
**Observation:** Under **ENSv2** on L1, native names avoid CCIP-Read entirely — but **S2S records
live on Base, so CCIP-Read remains the mechanism** for S2S. The improvement: ENSv2's **Universal
Resolver handles gateway orchestration transparently**, so the L2-records pattern becomes a
first-class citizen rather than a workaround; libraries need no changes. The S2S architecture stays
valid; it just normalizes.
**Status:** watch item, not an action; confirms the L2+CCIP design isn't a dead end.

---

## Invariants
- **INV-6** — shared conventions: `node = namehash(name)`, key `contenthash_wrapped`.
- **INV-12** — PKP must be `authorizedCaller` on C3 (in addition to Lit group perm INV-8);
  granted by `update-protocol.ts`; re-run on PKP rotation.
- **INV-4** — protocol discovery walks C4: `ownerOf(soul2soul.eth)` → registry →
  `parentDomainController()` → controller Safe → its modules.

## Open questions / unresolved
- **[concern]** Cross-client decoding consistency (DR-7.6) — ensure every client decodes the
  gateway's contenthash bytes identically; fragile.
- **[GAP]** Whether the gateway (`ccip.transport-union.dev`) has redundancy — it is a single
  service in the resolution path (availability/centralization risk for the read path).
- **[watch]** ENSv2 Universal Resolver rollout (DR-7.7) — may simplify client support over time.

## Cross-references
- **Component 5 (renderer)** — the UPDATE stage's PKP write targets C3's `contenthash_wrapped`;
  that write **is** the publish.
- **Component 4 (governance)** — the publication Safe owns the ENS subnode (L1) and hosts modules
  (L2) at the same address; RecordsModule holds the `ens_records` (C3) pointer.
- **Component 6 (website hosting)** — the CID the name resolves to is the hosted site tree
  (IPFS/Filecoin).
- **Component 2 (schema)** — the same-address CREATE2 requirement here is what Lens Chain broke
  (superseded there).
