# SPEC-contracts-ens

> **Audited against live code:** 2026-08-03.
>
> Protocol-wide naming + resolution + site-root layer. Read **SPEC-00** first. Sibling:
> **[SPEC-publication](SPEC-publication.md)** (the publication, incl. its site tree —
> [storage](publication/SPEC-publication-storage.md) is the caller that writes the root). Owns the read/write path for the
> published site pointer. Follows SPEC-00 §7.
>
> Invariants carried: INV-6 (contenthash codec + read path), INV-12 (PKP authorizedCaller),
> INV-4 (the NameWrapper ownership-walk discovery), and the cross-chain same-address requirement.

## Responsibility

Owns: subdomain issuance, ENS resolution, and the **site-root pointer** (`contenthash_wrapped`)
for *all* publications. Deployed **once** for the protocol (not per publication). Spans **L1**
(registry, resolver) and **L2/Base** (records). High blast radius — controls naming and the root
pointer for every publication. Reusable as a standalone "neutral hosting" primitive.

## Interface to the publication layer (the coupling)

The publication records module hands the actions the **`ens_records`** address (C3). The actions'
PKP must be `authorizedCaller` on C3 (INV-12). Shared conventions: `node = namehash(name)`, key
`contenthash_wrapped` (INV-6).

## Cross-chain identity requirement

A publication's Safe is the ENS subnode owner on **L1** (via NameWrapper) **and** the module host
on **L2** — at the **same address**. Deterministic Safe deployment must hold across both chains, or
resolution (L1) and gating (L2) point at different Safes. Invariant of the deploy path (verify in
SPEC-protocol deploy/rocketh).

---

### C3 — `ENSSubdomainRecordsContract` (`ENSL2nRecords.sol`, Base) = `protocolInfo.ensRecords`

The L2 store the published **site root** lives in: `textRecords[node]["contenthash_wrapped"]`.

| fn | who | note |
|---|---|---|
| `setText(node,key,value)` / `setAddress` / `batchSetRecords` | `onlyAuthorized` (authorizedCallers ∨ owner) | **the PKP writes the root here** |
| `authorizeCaller(addr,bool)` | owner ∨ `protocolAddress` | grants write rights (done by `update-protocol.ts`) |
| `getText(node,key)` / `getRecords` / `getAddress` | view | read by the CCIP gateway |

**INV-12:** the PKP eth address must be an `authorizedCaller` here, *in addition to* the Lit group
permission (INV-8). `update-protocol.ts` performs the grant (`authorizeCaller(pkp.ethAddress,true)`)
in the same Safe batch that writes the action-CID records. Rotating the PKP requires re-running it.
Desync (group-permitted but not authorizedCaller) → publish `setText` reverts `"Not authorized"`.

### C4 — `ENSOpenSubdomainRegistry` (L1)

Owns wrapped `soul2soul.eth`. `registerSubdomain(label, owner)` is **free/permissionless** and makes
`owner` (the publication Safe) the subnode owner via `nameWrapper.setSubnodeOwner`. Labels: `a-z 0-9
-` (no leading/trailing `-`), ≤63 chars. Holds `parentDomainController` (controller Safe), which can
`reclaimParentDomain`. This is what `getProtocolControllerAndModules` walks: `ownerOf(soul2soul.eth)`
→ registry → `parentDomainController()` → controller Safe → its modules (INV-4 discovery).

### C5 — `ENSResolverWthCCIP` (`ENSResolverWithCCIP.sol`, L1) — read path

ENSIP-10 wildcard resolver. `resolve(name,data)` namehashes the DNS name, then for `contenthash`
(and `addr`) reverts `OffchainLookup(rpcUrls, encode(C3, getText(node, key)))`. The client calls the
**`ccip_gateway`**, which `eth_call`s `getText` on C3 (Base) and returns the value; the callback
decodes it. **Wrapped names use `_wrapped`-suffixed keys** — origin of the literal
`contenthash_wrapped` (INV-6).

**Gotchas:** contract name misspelled `ENSResolverWthCCIP`. Generic `text(bytes32,string)` is
**stubbed** (hardcoded `"default"` key); only contenthash/addr resolve correctly. Custom contenthash
codec (no dag-pb byte) → only this resolver + gateway resolve reliably; generic ENS tooling may not.

---

## INV-6 full span (write ↔ read)

`updateEvm` `toHexString(cidV0)` → `evmWrite setText(node,"contenthash_wrapped")` on **C3** with the
**PKP** (needs INV-8 group **and** INV-12 authorizedCaller) → read: client → **C5** `resolve` →
`OffchainLookup` → `ccip_gateway` → `getText` on **C3** → `contenthashToIPFS` decode → IPFS fetch.
`node = namehash(publication)`. Codec custom & unversioned (SPEC-00 Q3 / SPEC-protocol-actions).

## Invariants this component preserves

INV-6 (C3 store + C5 read path + custom codec), INV-12 (PKP authorizedCaller on C3), INV-4 (the
NameWrapper ownership walk), cross-chain same-address.

## Local gotchas / gaps

- C5 contract-name typo; C5 generic `text` stub.
- Custom contenthash codec resolvable only by C5 + `ccip_gateway` (INV-6).
- INV-12 desync (PKP rotated but not re-`authorizeCaller`’d) → publish-time `setText` revert.
- `ccip_gateway` (Docker service, `protocol/ccip_gateway`) is the off-chain half of resolution —
  spec separately when reached; it is the only off-chain trusted component in the read path.

## Safe-to-change vs do-not-touch

- 🟢 fix C5 typo; add resolver record types; gateway perf/caching; add authorized callers via owner.
- 🔴 change the `contenthash_wrapped` key or `_wrapped` suffix convention (INV-6); change the codec
  without updating both `toHexString` and `contenthashToIPFS` and the gateway; loosen
  `onlyAuthorized`; alter Safe-address determinism across chains.

## Test seams

- **C3 (Foundry/Hardhat):** `onlyAuthorized` enforcement; `getText`/`setText` round-trip;
  `authorizeCaller` by owner/protocol only.
- **INV-6 cross-layer (fork):** `toHexString` write → `getText` → `contenthashToIPFS` == original
  CIDv0; resolve through C5 + a local gateway returns the same bytes.
- **INV-12 (fork):** deauthorize the PKP on C3 → `updateEvm` `setText` reverts; prove it is
  *independent* of the Lit group (group-permitted yet unauthorized still fails).
- **INV-4:** deploy registry + controller Safe; assert the ownership walk resolves modules.
