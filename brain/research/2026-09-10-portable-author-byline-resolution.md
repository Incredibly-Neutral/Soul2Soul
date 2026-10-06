# Portable author byline — resolution / naming design study

> Research/design study (read-only). Grounds the RESOLUTION/NAMING mechanism a
> portable byline address (`did:ethr`-backed author identity → index of work)
> would use, against today's ENS/CCIP-Read machinery. Cites exact files +
> functions. Companion to whitepaper 07 (domain resolution), 08 (authenticity),
> and SPEC-contracts-ens.

## 0. Headline

**Everything in today's resolution layer is PER-PUBLICATION. There is no per-author
naming or resolution anywhere in code or specs.** The entire read/write path is keyed on
`node = namehash(<publication subdomain>)`. A portable author byline is therefore almost
entirely **greenfield on the semantics** — but it can **reuse the per-node storage and the
read path** (the L2 records contract is a generic `textRecords[node][key]` store and the
CCIP resolver/gateway are node-agnostic), provided we resolve **who is allowed to write an
author node** (INV-12) and **which key/index it stores** (INV-6 semantics). The one existing
mechanism that already models "re-point a name to a different root" is the `config.domain`
feature in the UPDATE action — a reusable primitive for byline portability.

---

## (a) Today's resolution machinery — all per-publication

### The naming unit is the publication subdomain
Each publication is a subdomain of `soul2soul.eth` (e.g. `alice.soul2soul.eth`), subnode
owned by the **publication Safe** via NameWrapper (L1). Whitepaper `07-domain-resolution.md`
DR-7.1; `SPEC-contracts-ens.md`.

### The four ENS pieces (C3/C4/C5 + gateway)

**C4 — `ENSOpenSubdomainRegistry`** (`protocol/contracts/contracts/ENSOpenSubdomainRegistry.sol`)
- Owns wrapped `soul2soul.eth`; `registerSubdomain(label, owner)` / `registerSubdomainSimple`
  are **free/permissionless** and make `owner` the subnode owner via
  `nameWrapper.setSubnodeOwner`. Labels `a-z0-9-`, ≤63. `reclaimParentDomain` by
  `parentDomainController`.
- **No author concept** — the owner it mints is a publication Safe.

**C3 — `ENSSubdomainRecordsContract`** (`protocol/contracts/contracts/ENSL2nRecords.sol`)
- Deployed once on Base (L2). The published **site root** lives here:
  `textRecords[node]["contenthash_wrapped"]`.
- `setText(node,key,value)` / `setAddress` / `batchSetRecords` are `onlyAuthorized`
  (`authorizedCallers[msg.sender] || msg.sender == owner()`).
- `authorizeCaller(addr,bool)` — **only `owner()` or `protocolAddress`** can grant write
  rights (this is the INV-12 gate).
- `getText(node,key)` / `getRecords` / `getAddress` / `getTextRecordKeys` / `exportState` —
  reads, called by the CCIP gateway.
- **Key point for the byline:** the storage is a **generic per-node key/value table**.
  It is not hard-wired to publications; an author node would use the same contract.

**C5 — `ENSResolverWthCCIP`** (`protocol/contracts/contracts/ENSResolverWithCCIP.sol`,
contract name misspelled)
- L1 wildcard (ENSIP-10) resolver. `resolve(name,data)` → `dnsNameToNodeHash`/`namehash` →
  routes by selector: `contenthash(bytes32)` / `addr` resolve; **generic `text` is STUBBED**
  (hardcoded `"default"` key — a real arbitrary text key is NOT resolvable through C5).
- Every resolved field reverts `OffchainLookup(rpcUrls, encode(C3, getText(node,key)))`;
  the client calls the gateway, which `eth_call`s C3 on Base.
- Wrapped names use `_wrapped`-suffixed keys — origin of the literal `contenthash_wrapped`
  (INV-6). `resolveContenthash`/`resolveContenthashCallback`, `contenthashCallback` do the
  `0xe3 01 <cid>` decode.

**CCIP gateway** (`protocol/ccip_gateway/src/main.ts`)
- `POST /`: decodes the `(address,bytes)` rpcCallData → `eth_call`s `getText` on C3 (Base,
  chainId 8453) → returns `{ data }`. The only off-chain component in the read path.

### How a name resolves to a site root today (the exact trace)

Production read path is **`cid-mirror/src/ens.ts :: resolveEnsToCID`** (mirrors
`protocol/actions/src/libs/ens.factory.ts` + `protocol.factory.ts`):

1. `node = namehash(ensName)` (`namehash()` in `cid-mirror/src/ens.ts`).
2. Resolve the **records-contract address** (`getProtocolInfo`):
   - L1 mainnet `registry.nameWrapper()` → `nameWrapper.ownerOf(namehash('soul2soul.eth'))`
     → the custom registry → `parentDomainController()` → protocol controller Safe.
   - L2 Base `controller.getModulesPaginated(...)` → `module.NAME() == 'S2S Records Module'`
     → configModule → `getRecords(['ens_records', ...])` → index 1 = `ensRecords` (C3).
   - `RECORDS_CONTRACT` env override skips discovery (still `getText` off that address).
3. On Base: `getText(node, 'contenthash_wrapped')` on C3 (`calldataGetText`, selector
   `0xad428dac`).
4. `decodeContenthashWrapped(value)` (`shared/src/ipfs/contenthash.ts`) → CID → IPFS fetch.

The **browser** path (whitepaper 07, DR-7.2): `pub.soul2soul.eth.limo` → `.limo` resolves on
L1 mainnet → C5 reverts `OffchainLookup` → client calls the CCIP gateway → gateway
`getText(node,'contenthash_wrapped')` on C3 → decoded CID → IPFS gateway serves the page.

### Write path (the publish)
`protocol/actions/src/update/main.ts` (EVU, the only privileged root write):
`toHexString(newRootCid)` (`libs/evm.ts`, = `encodeContenthashWrapped(parseCID(cid))`) →
`evmWrite('L2', pkp, ensRecords, 'setText', [node, 'contenthash_wrapped', encoded], ...)`
→ PKP signs + broadcasts. `node = ethers.utils.namehash(writeDomain)` where
`writeDomain = config.domain ?? publication`.

> Note `shared/src/ens/index.ts :: getContractAddressFromEnsName` reads
> `resolver.text(node,'contract.address')` — a **different, legacy** path returning a
> *contract address*, not a site root. Not part of the contenthash resolution story.

---

## (b) How a per-author byline fits — reuse vs greenfield

### What exists to reuse (near-zero new machinery)
- **The C3 per-node key/value store is generic.** `textRecords[node][key]`, `setText` /
  `getText` / `batchSetRecords` don't care whether `node` is a publication or an author.
  An author node needs no new storage contract.
- **The read path is node-agnostic.** `namehash(author.soul2soul.eth)` → `getText(node,key)`
  (via C5+gateway, or directly like cid-mirror) works for any node — as long as the key is a
  resolvable one (contenthash / addr today; see the text-stub gap below).
- **Subdomain minting is reusable.** `ENSOpenSubdomainRegistry.registerSubdomain(label, owner)`
  is permissionless; an **author Safe** could be the `owner` of `author.soul2soul.eth` exactly
  as a publication Safe owns its subdomain.
- **Author identity already exists and is portable**: the author is a **`did:ethr` whose
  address is a Safe**, not an EOA (`shared/src/protocol/types.ts` `DidEthr`,
  `toDidEthr`/`eoaOf`; whitepaper 08 DR-8.4). That Safe address is what publications whitelist
  (`S2SPublicationModule.sol :: whitelistAuthor`, `grantLicense`, `licenseAuthors`). So the
  byline's owner-of-record is a well-defined, existing identity.

### What is greenfield
- **No author ENS node exists today.** Everything is keyed on `namehash(publication)`; there
  is no author subdomain, no author-level record, no author aggregation of publications.
- **An "index of work" is not expressible with today's single `contenthash_wrapped`**
  (one CID = one site root). Two options:
  1. **Reuse `contenthash_wrapped`**: the author byline points at an *author homepage CID*
     (an IPFS page/JSON listing publications + pointers). Zero new record keys; reuses the
     entire contenthash read path verbatim. Semantic conflation: "author index" is stored
     under the same key as "publication site root".
  2. **A new record key** (e.g. `publications` / `index` / `byline`): a list of publication
     ENS names or a JSON doc. More expressive, but **not resolvable through C5** (generic
     `text` is stubbed to `"default"`) and not covered by the INV-6 codec — would be read
     directly off C3 (cid-mirror style) or require extending C5.
- **Who writes an author node** (see §c — the crux).
- **The index content format itself** (page vs machine-readable JSON; what each publication
  pointer contains) is greenfield.

---

## (c) Portability mechanism + constraints

### The existing re-pointing primitive: `config.domain`
`protocol/actions/src/update/main.ts` already supports writing the root to an **arbitrary
configured domain** rather than the default subdomain:
`writeDomain = config.domain ?? publication`; `node = namehash(writeDomain)`.
`shared/src/publication/types.ts` `S2SPublicationConfig.domain`; surfaced via
`config-builder.ts` (explicit override, or carry from existing config). The write target and
the publication identity are **decoupled** — ownership/discovery stay keyed on `publication`,
only the write node changes. **This is the exact pattern a byline re-point would use**:
rewrite `contenthash_wrapped` at the byline's node when the author joins/leaves a publication,
so the byline follows the author.

### Constraints / invariants
- **INV-6 (contenthash codec + `_wrapped` key + `0xe3 01` envelope):** `contenthash_wrapped`
  is semantically a *site root* (one CID). Reusing it for an author index works mechanically
  (same codec/read path) but overloads the key's meaning. A distinct author key avoids that
  but is greenfield and needs its own read plumbing.
- **INV-12 (PKP authorizedCaller — who writes records):** `setText` on C3 requires
  `authorizedCallers[msg.sender] || owner()`. Today the **only** authorized caller is the PKP,
  granted by `update-protocol.ts` (`authorizeCaller(pkp.ethAddress, true)`) — and
  `authorizeCaller` is itself restricted to `owner()`/`protocolAddress`
  (`ENSL2nRecords.sol`). DR-7.3's guarantee is *"only the PKP writes the root, as the result
  of a verified publish — never by an outside operator."* This is the central design fork:
  - **Author-managed byline (portable in the strong sense):** the author's own key must be
    able to re-point the byline. Either (i) grant the author Safe (or its key) as an
    `authorizedCaller` — which relaxes DR-7.3's "only the PKP" guarantee; or (ii) route the
    author's write through the neutral PKP action gated on author ownership (protocol-consistent
    with how the PKP publishes today, but requires a new action/`setRecord` path).
  - **Publication-managed byline:** the publication writes the author node under its publish —
    trivial given today's write path, but **the byline stays hostage to the publication**,
    defeating portability. This is precisely the failure the design must avoid.
- **INV-4 / discovery is publication-keyed.** `getProtocolControllerAndModules` /
  `getDomainOwnerAndModules` / `cid-mirror getProtocolInfo` walk the *publication* Safe's
  modules to find the records contract. Author discovery would need a parallel walk
  (author node owner → records) — analogous but new.
- **Cross-chain same-address requirement (DR-7.4):** publications assume the Safe is the L1
  subnode owner *and* the L2 module host at the **same address** (deterministic Safe deploy).
  An author byline inherits the same requirement for the author Safe (L1 node owner / L2
  writer); must be verified for author Safes specifically (they may not be deployed
  deterministically today the way publication Safes are).
- **Author ≠ single key:** author identity is a Safe; who among the Safe's signers may
  re-point the byline needs a policy (all signers? an author-specific capability?).

---

## (d) End-to-end reader path (each hop mapped)

Goal: reader follows author byline → resolve → read index of work → go to each publication.

| # | Hop | Existing machinery | New/greenfield |
|---|-----|--------------------|----------------|
| 1 | Reader holds portable byline `author.soul2soul.eth` | Author identity = `did:ethr` over Safe (`shared/src/protocol/types.ts`); subdomain mintable via `ENSOpenSubdomainRegistry.registerSubdomain` | The **author subdomain itself** (no author node exists today) |
| 2 | Resolve the byline node | `namehash()` (`cid-mirror/src/ens.ts`); `C3.getText` (`ENSL2nRecords.sol`); `C5.resolve/contenthash` + gateway (`ENSResolverWithCCIP.sol`, `ccip_gateway/src/main.ts`) — all node-agnostic | Resolver must expose the **index key** (today only contenthash/addr resolve; generic `text` stubbed) OR read C3 directly cid-mirror-style |
| 3 | Resolve → index of work | `decodeContenthashWrapped` (`shared/src/ipfs/contenthash.ts`) → CID → IPFS fetch (website hosting, Component 6) | The **index content** (page/JSON listing publications + pointers); possibly a new record key |
| 4 | Go to each publication to read | **Fully existing today**: `namehash(pub)` → `getText(node,'contenthash_wrapped')` → CID → serve (cid-mirror `resolveEnsToCID`, `.limo`/CCIP browser path) | None |
| 5 | Verify it's really the author's work | Page-level PKP-signed JSON-LD provenance: `author` = `did:ethr`, `publisher` = ENS+Safe, proof = Data Integrity Proof (whitepaper 08; render `metadata.ts`) | **GAP-1**: provenance author is currently HARDCODED placeholders in the render action — the byline↔did:ethr↔page-proof link is not yet wired from real data |

Net: hops 2 (partial), 3, 5 are the greenfield surface. Hops 1 (identity) and 4 (per-publication
read) are already real.

---

## (e) Gaps / open questions

1. **No per-author naming exists** — the entire layer is publication-keyed. Confirmed: no
   `author.*.eth`, no byline, no author subdomain in code or specs (only conceptual byline
   discussion in whitepaper reading-room notes).
2. **Write authority (INV-12 / DR-7.3) is the load-bearing design decision.** Author-managed
   portability requires the author to re-point the byline, which today only the PKP can do.
   Options: grant author as `authorizedCaller` (relaxes "only PKP"), or route through a new
   neutral PKP action gated on author ownership (keeps the neutrality invariant). A
   publication-managed byline is trivial but not portable.
3. **`contenthash_wrapped` is a single-root site pointer (INV-6).** An author *index* is a
   different object. Decide: reuse the key (index-as-site-root, zero plumbing) vs a new key
   (cleaner semantics, needs a resolver extension because generic `text` is stubbed to
   `"default"` in `ENSResolverWithCCIP.sol`).
4. **Cross-chain same-address for author Safes (DR-7.4)** is assumed for publications but must
   be verified for author Safes (L1 node owner / L2 writer at one address).
5. **Author-node discovery** — a walk keyed on the author (parallel to INV-4's publication
   walk) doesn't exist.
6. **Index content format** is greenfield: page vs machine-readable JSON; what each
   publication pointer carries (ENS, title, latest CID); whether the index is re-rendered by
   the neutral action or maintained directly.
7. **GAP-1 (whitepaper 08):** provenance author `did:ethr` is hardcoded placeholders in the
   render action — the authenticity link the byline depends on isn't wired to real author data.
8. **Read-path brittleness inherited:** cross-client CCIP decode consistency (DR-7.6) and
   single-gateway availability (DR-7.7 / `gateway-keepalive-state.md`) apply to any new
   author-resolution leg.

---

## (f) File / function list relied on

**Contracts (`protocol/contracts/contracts/`)**
- `ENSL2nRecords.sol` → `ENSSubdomainRecordsContract` (C3): `setText`, `getText`,
  `batchSetRecords`, `authorizeCaller`, `getRecords`, `getAddress`, `getTextRecordKeys`,
  `exportState`, `onlyAuthorized`/`onlyProtocol` modifiers.
- `ENSOpenSubdomainRegistry.sol` → `ENSOpenSubdomainRegistry` (C4): `registerSubdomain`,
  `registerSubdomainSimple`, `reclaimParentDomain`, `isSubdomainAvailable`.
- `ENSResolverWithCCIP.sol` → `ENSResolverWthCCIP` (C5): `resolve`, `contenthash`, `text`,
  `addr`, `resolveContenthash`/`resolveContenthashCallback`, `contenthashCallback`,
  `dnsNameToNodeHash`/`namehash`, `supportsInterface`.
- `S2SRecordsModule.sol`: `setRecord`/`setRecords`/`getRecords`/`getAllRecords` (KV config
  module — distinct from C3).
- `S2SPublicationModule.sol` (+ `S2SPublicationModuleV2.sol`): `whitelistAuthor`,
  `grantLicense`, `licenseAuthors`, `makeOffer`, `canPublish` (author-relationship record).

**Action libs (`protocol/actions/src/`)**
- `libs/evm.ts`: `evmWrite`, `evmRead`, `toHexString`.
- `libs/ens.factory.ts`: `getProtocolControllerAndModules`, `getDomainOwnerAndModules`.
- `libs/protocol.factory.ts`: `getProtocolInfo`.
- `libs/ipfs.factory.ts`: `contenthashToIPFS` (INV-6 read).
- `update/main.ts`: `writeDomain`/`config.domain`, `setText(contenthash_wrapped)` (the publish
  write + existing re-point primitive).

**Shared (`shared/src/`)**
- `ipfs/contenthash.ts`: `encodeContenthashWrapped`, `decodeContenthashWrapped`, `parseCID`,
  `toPreviewLabel`.
- `ens/index.ts`: `getContractAddressFromEnsName` (legacy `contract.address` path — not the
  site-root path).
- `protocol/types.ts`: `DidEthr`, `toDidEthr`, `eoaOf` (portable author identity).
- `publication/types.ts`: `S2SPublicationConfig.domain`.

**Gateway / read path**
- `protocol/ccip_gateway/src/main.ts`: `POST /` gateway (eth_call C3, returns `{data}`).
- `cid-mirror/src/ens.ts`: `resolveEnsToCID`, `getProtocolInfo`, `getProtocolController`,
  `getConfigModule`, `getRecordsContract`, `namehash`, `extractEnsName`.
- `cid-mirror/src/ipfs/contenthash.ts` (vendored codec).

**Specs**
- `brain/specs/SPEC-contracts-ens.md` (C3/C4/C5, INV-6/INV-12/INV-4, cross-chain same-address).
- `brain/specs/SPEC-00-system-contract.md` (INV-4, INV-6, INV-8, INV-12 definitions; GAP-14).
- `brain/whitepaper/07-domain-resolution.md` (DR-7.1→7.7, request flow, invariants).
- `brain/whitepaper/08-authenticity-provenance.md` (did:ethr author, PKP-signed page proof,
  GAP-1/GAP-2).
- `brain/specs/SUMMARY-protocol.md` (two-record-stores distinction: S2SRecordsModule vs C3).
- `brain/code-map/MAP.md` (component index).
