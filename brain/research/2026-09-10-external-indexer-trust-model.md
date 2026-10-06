# Findings Report — External Indexer Design Space for s2s

**Scope:** read-only research. Grounded in `brain/specs/*`, `brain/threat-model/*`, `brain/whitepaper/*`, and the actual proof/signing code in `shared/src/identity`, `protocol/actions/src`, and `protocol/contracts/contracts`. No code changed, no PR.

---

## 0. One-paragraph thesis (recommended shape, in brief)

The protocol already provides **everything a third party needs to independently verify an index entry without trusting the indexer**: author-level EIP-712 signatures over `S2SPublicContent`, a page-level PKP Data-Integrity-Proof embedded in the HTML, and a public on-chain deal/offer append-log as the source of truth. Therefore the correct design is **not** a binary "trusted vs decentralized" — it is **"anyone-can-index over a verifiable source of truth, with an optional registered/trusted index for convenience, and no privileged write path for the index itself."** The index should be a *derived, auditable view* of on-chain+IPFS state, not a new authority. This is exactly the pattern the protocol applies to its own neutrality (capability open, authority collective) and to its own read path (`cid-mirror` is a working precedent of an external resolver with no protocol authority).

---

## (a) Verifiability / proof inventory — what lets a third party audit an index entry without trusting the indexer

There are **two independent signature layers** plus **one on-chain source of truth** plus **two commit mechanisms**. An indexer's claim about any entry can be checked end-to-end by walking these, none of which require trusting the indexer.

### 1. Author-time EIP-712 signature over `S2SPublicContent` (item-level)
- **Code:** `shared/src/protocol/types.ts` — `S2S_DOMAIN` (`{name:'S2S Content', version:'1', chainId:8453}`), `S2S_TYPES` (`S2SContent` struct with `tagsHash`/`attributesHash` as `bytes32`), `S2SPublicContent`, `S2SProof` (`type:'eip712'`, `signer`, `signature`).
- **Signing:** `shared/src/identity/sign-content.ts :: buildSignedContentItem` — computes `plaintextHash = keccak256(utf8(JCS(body)))`, builds the signing view (`buildSigningView`), sets `objectId = EIP-712 digest of the signing view`, signs.
- **Verification (reusable by any indexer/verifier):** `shared/src/identity/verify-content.ts :: verifyAuthorship` — recomputes `plaintextHash`, recovers the signer from the EIP-712 digest via `recoverAddress`, and asserts it equals `eoaOf(public.author)` (the `did:ethr`→address) **and** `proof.signer`. `verifyPlaintextHash` does the cheap integrity-only check.
- **Key property for an indexer:** the **`objectId` = EIP-712 digest of the public metadata, available pre-upload/pre-CID**. So an indexer can (i) re-derive `objectId` from the indexed `public` fields, (ii) recover the author address from the signature, and (iii) confirm the entry is attributed to the right author — *without* decrypting the body. Every public field is signed; there is no unsigned public field (SUMMARY §4). Determinism is pinned by `specVersion:"1"` + JCS (RFC 8785) (`shared/src/identity/jcs.ts :: jcs/keccakOfJson`).

### 2. Page-time PKP Data-Integrity-Proof embedded in the rendered HTML (page-level)
- **Writing:** `protocol/actions/src/render/metadata.ts :: addAndSignMetadata` — hashes the `<html>…</html>` block (SHA-256), builds a schema.org `Article` JSON-LD, signs `canonicalize(schema)+canonicalize(proofOptions)` with the **PKP** via `Lit.Actions.getPrivateKey` + `ethers SigningKey.signDigest`, embeds `proofValue` as a W3C `DataIntegrityProof` (`ecdsa-secp256k1-2019`, `verificationMethod: did:pkh:eip155:8453:<pkp>`).
- **Independent verification (this is the reference audit routine):** `protocol/actions/src/update/verify.ts :: verifyProvenance(htmlCid, expectedGenesis, pkpEthAddress, gateway)` — cats the HTML from IPFS, extracts the JSON-LD, **separates `proof` from data**, canonicalizes both, recovers the signer, asserts it equals the expected PKP eth address; then recomputes SHA-256 of the HTML body and asserts it equals `schema.encoding.sha256`; then asserts `schema.identifier === expectedGenesis`. Also `verifyRevocable`/`verifyPathAvailable` (deal-aware path integrity).
- **Key property for an indexer:** the proof is **self-contained in the HTML** (works offline; "what you see is what was verified", whitepaper 08 / DR-8.1). A third-party auditor can fetch the page from *any* host (even an untrusted one) and re-run `verifyProvenance` — the signature covers the exact bytes, so tampering is evident. This is the strongest tool for a "don't trust the indexer" model.

### 3. On-chain deal/offer append-log as source of truth
- **Code:** `protocol/contracts/contracts/S2SPublicationModuleV2.sol` — `makeOffer` (the single author write: append + place in deal/offer), `acceptOffer` (onlySafe), `retract`, `hasDeal`/`hasOffer`, `getDeals`/`getOffers` (paginated enumeration), `getLatest`, `getVersion`, `getVersionCount`, `authorOf`, `canPublish`, `isGenesis`, and the `_append` gating (`genesisAuthor` set once; subsequent appends require `msg.sender == genesisAuthor || safe`).
- **Key property for an indexer:** the chain **is** the authoritative, ordered, permissioned log of what content is published/licensed for a publication. `Entry { genesis, author, cid, timestamp }` is publicly readable. An indexer that only mirrors `getDeals`/`getOffers`/`getLatest` + cats each `cid` reproduces the canonical corpus, and any divergence between the indexer's view and the on-chain log is independently checkable.

### 4. Commit mechanisms (plaintextHash + content-addressing)
- `plaintextHash` commits the (possibly encrypted) body without exposing it — an indexer can verify a body matches its metadata without decrypting (SUMMARY §4: "secret is not signed — plaintextHash commits the plaintext instead").
- Content-addressing + **CID parity across storage tiers** (INV-13): Kubo `rootCid` is canonical and equal across Kubo/Filecoin/Pinata. The rendered root is anchored by `contenthash_wrapped` on the ENS records contract (INV-6, custom `e301`+CIDv0 codec), written only by the PKP. So "the site as it currently is" is a verifiable on-chain pointer, and the indexer's copy can be checked against it.

**How an indexer's claims get independently audited (the concrete recipe):** for each indexed entry, a verifier recomputes (1) `objectId` from `public` + recovers author from the EIP-712 sig (`verifyAuthorship`), (2) walks `S2SPublicationModuleV2.getLatest(genesis)` to confirm the indexed `cid`/`author`/`timestamp` matches the chain, and (3) cats the page and runs `verifyProvenance` to confirm the PKP page proof. If all three hold, the entry is authentic regardless of whether the indexer is honest. The indexer only adds *discoverability* (it cannot forge provenance).

---

## (b) Concrete decentralization options for the indexer, scored against what exists

**There is currently no indexer anywhere in the codebase or specs** (grep confirms: no `indexer` concept in `brain/*` or any component). This is entirely greenfield — which is itself a finding: the design space is open, and the *source data* the indexer would consume is already public and verifiable.

| Option | What exists today | Greenfield? | Verifiability | Censorship exposure | Score |
|---|---|---|---|---|---|
| **(i) Trusted operator watching contracts** | Nothing indexer-specific; but the protocol *already* runs one trusted off-chain read-path component: the **`ccip_gateway`** (single off-chain resolver, documented `[GAP]` SPOF), and the self-hosted **Kubo node** (`ipfs.transport-union.dev`), plus **Lit** as the neutral publisher. `cid-mirror` is an operator-run external resolver precedent. | Mostly greenfield (an indexer service), but matches an established operator pattern | High (can still be audited via (a) proofs) | Highest single point — the exact "trust a platform" failure the protocol exists to avoid; collides with the neutrality principle | Weakest for neutrality; viable only as a *convenience layer* |
| **(ii) Anyone-can-index (source data is public+verifiable)** | **All the raw material exists and is public:** ENS subdomain registry (`ENSOpenSubdomainRegistry.registerSubdomain` is **free/permissionless** → enumeration surface), the publication module's `getDeals`/`getOffers`/`getLatest` (public views), the ENS records `contenthash_wrapped` root, IPFS (Kubo/Pinata/Filecoin), and the two signature layers in (a). | Greenfield indexer logic; zero new protocol authority needed | **Highest** — every entry independently auditable without trusting any indexer | Best — an index that is just a derived view of public state can be forked/rebuilt by anyone | **Strongest match for the protocol**; the index becomes a commodity |
| **(iii) Indexers pinned/registered on-chain or in records (configModule / ENS records)** | `S2SRecordsModule` (`setRecord`/`getRecords`, all writes `onlySafe`) and `ENSL2nRecords` (`setText`/`getText`, `authorizeCaller`) are the existing "publish a pointer/record" mechanisms; `S2SProtocolInfo` in `shared/src/protocol/types.ts` shows the pattern of publishing protocol-level pointers (gateway, action CIDs, `pkp`) via records. **But nothing currently stores indexer identities.** | Greenfield — would need a new record key (e.g. an `indexer_*` key in the records module) or a new `authorizeCaller`-style grant, and a **governance decision** on who may register an indexer (Safe `onlySafe` = collective authority) | High — registration makes indexers *discoverable* and *revocable*, but registration ≠ authority over content; verifiability still comes from (a) | Medium — registration is a gate, so it's a form of the trusted model; mitigates sybil *discoverability* but reintroduces a gatekeeper | Good *add-on* to (ii) as an optional registry of reputable indexers; not the core model |
| **(iv) Lit / off-chain aggregation** | Lit actions are immutable, CID-pinned, TEE-executed (`getPrivateKey` enclave signing); the existing pattern of "immutable code + permitted key + on-chain gates" (INV-8, Chipotle Group) is directly reusable. **No aggregation action exists today.** | Greenfield — a new Lit action that aggregates/indexes would be built and CID-pinned exactly like prep/render/update | High (if it only *reads* public state and re-emits signed attestations; cannot be more authoritative than the source) | Low-medium — inherits Lit's own residuals (TEE integrity, node independence, `ccip_gateway` SPOF in the read path it would consume) | Attractive for *attestation of aggregates* (e.g. a PKP-signed index root), but the aggregate is still derived, not authoritative |

**Key architectural lever for (ii)/(iii)/(iv):** the protocol's own record stores are the natural home for *discoverability pointers* (where an index lives), not for the *content* of the index. This mirrors how the protocol separates content (content-addressed, no single host alters bytes) from naming (fragile, censorable) — publication.md's naming-layer analysis. The index should be treated like **naming**: a fragile, replaceable convenience over durable, verifiable content.

---

## (c) Relevant invariants / gaps / threats

**Invariants from SPEC-00 that an indexer must respect (or be checked against):**
- **INV-1** — auth string is exactly `"lit actions auth"`; relevant only if the indexer reuses the gate-recovery path.
- **INV-append / INV-3** — the append-log is append-only, gated to `genesisAuthor || safe`; an indexer can rely on `authorOf(genesis)`/`getLatest` as stable author attribution (no forgeable version history).
- **INV-2 / INV-10** — *who can write what*: records module is `onlySafe`; publication module whitelist/`acceptOffer`/upgrade are `onlySafe`, `makeOffer` is **permissionless**, `retract` is `safe ∨ genesisAuthor`; ENS records `setText` is `onlyAuthorized` (PKP writes root). **This is the crux for "who can write the index":** there is currently **no privileged indexer write path**, and creating one would mean loosening `onlySafe`/`onlyAuthorized` — explicitly a 🔴 do-not-touch (SPEC-contracts-publication, SPEC-contracts-ens). The clean design keeps the index **read-only w.r.t. the protocol**.
- **INV-5 / GAP-2** — provenance canonicalization must replicate `metadata.ts` **byte-for-byte**; note GAP-2: `canonicalize` sorts **top-level keys only** (nested not canonicalized). **Any external verifier/indexer that re-hashes must copy this quirk exactly**, or signatures fail — a real trap for a third-party auditor.
- **INV-6** — `contenthash_wrapped` uses a **custom, unversioned** codec (`e301`+base58 CIDv0); only the project's own CCIP resolver/gateway decodes it. An indexer reading the site root must use the protocol's own `contenthashToIPFS`, not generic ENS tooling.
- **INV-12** — PKP must be `authorizedCaller` on the records contract; an indexer auditing the root must resolve the PKP address correctly (`pkp_ethAddress`; `pkp_tokenId`/`pkp_publicKey` are vestigial per GAP-11).
- **INV-7 / GAP-6** — preview HTML is intentionally **unsigned** (Bun shim skips signing). **An indexer must not ingest preview pages as if they carried provenance** — a present-but-unverifiable proof is a known hazard (OPEN-TASK-2). Only production/Lit-rendered pages carry valid proofs.

**Gaps directly relevant to an indexer:**
- **GAP-1 (tail c)** — `resolveLatest`/`getHistory` in `shared/src/identity/verify-content.ts` are still **stubs** ("append-log contract pending") even though `S2SPublicationModuleV2` is deployed. An indexer that wants full version history has to read the contract directly; the client-side history API is unimplemented.
- **GAP-1 (b)** — render metadata `contentCid` uses a `body.cid || body.id` fallback (genesis signed only implicitly); indexers keyed on `objectId`/genesis should be aware the page-level `schema.identifier` is the genesis/job id.
- **GAP-2** (canonicalization trap, above), **GAP-13** (no Filecoin hot-storage gateway for HTML), **GAP-14** (contenthash codec duplicated across 4 files — indexer should use the planned shared helper).

**Threat-model items an indexer inherits (from `threat-model/protocol.md` + `publication.md`):**
- **Censorship of the index vs of the content.** The protocol is *stoppable by design* at the naming layer; the **index is naming-like and therefore exactly as censorable as the name**. The content survives (content-addressed) even if a single index is blocked. This is the strongest argument for (ii) anyone-can-index / forkable: no single index should be the only way to find content.
- **Sybil / false-index risk.** Because provenance is independently verifiable, a malicious indexer can at worst **withhold** or **omit** entries, or add **duplicate/noise** — it cannot fabricate authentic entries (it lacks the EIP-712 author key and the PKP). So the failure mode is availability/completeness, not integrity. Mitigations: cross-index reconciliation, and optionally (iii) a registered set of reputable indexers.
- **Compellable relays** (RPC, gateway, IPFS host) are a shared residual — an indexer is another compellable relay; the design should not make any one of them indispensable.
- **Single points in the read path** the indexer depends on: `ccip_gateway` (documented `[GAP]` SPOF), self-hosted Kubo, Pinata, Base/Coinbase sequencer. An indexer inherits these as inputs; it should treat them as swappable.
- **Single vs multiple indexers:** the threat model's "no single owner" and "capability open, authority collective" logic points to **no single indexer being authoritative** — the index is a derived view, so multiple/forkable indices are the natural state, matching the protocol's fork-as-escape-hatch posture.

---

## (d) Recommended shape — "trusted vs decentralized (or both)"

**Recommendation: both, but with a strict ordering of authority — "anyone-can-index over a verifiable source of truth (core), with an optional registered/convenience index (surface), and never a privileged indexer write path."**

- **Core (must-have):** the index is a **derived, auditable view** of `S2SPublicationModuleV2` (deals/offers/versions) + IPFS + the two signature layers. Anyone can run one (option ii). This is cheap to build because all the proof machinery in (a) already exists — the indexer is a **reader**, exactly like the renderer's own `module.factory` reads. It requires **zero new protocol authority** and cannot violate INV-10 (no loosening of `onlySafe`/`onlyAuthorized`).
- **Surface (optional convenience):** a small set of **registered indexers** discoverable via the records module / ENS records (option iii) — e.g. an `indexer_*` record or an authorized-caller-style grant — gated by the **Safe collective authority** (consistent with "authority collective"). Registration solves *discoverability* and *sybil-lite* for users who want a default, without making the registry authoritative over content. The registry is revocable via the existing `onlySafe` governance path.
- **Not recommended as the core:** a single trusted operator (i) as the *only* index — it recreates the "trust a platform" failure the protocol exists to avoid and collides with the neutrality claim; and a Lit-aggregation index (iv) as more than an optional signed-attestation layer, since the aggregate can't exceed the verifiability of the public source.

**Where the index data should live, per the protocol's neutrality principle:** the protocol's own frame — *"capability open, authority collective"* and *"content-addressed (durable/unalterable) vs naming (fragile)"* — implies the index **should not be a new on-chain authority**. Put index *discoverability* pointers in the records/ENS layer (fragile, replaceable, like naming), and put index *payload* on content-addressed IPFS (durable, forkable). This keeps the protocol's neutrality intact: **the index is a convenience that can be forked/replaced without touching the guarantees, and no single index has privileged access to truth.** This is precisely how `cid-mirror` already behaves — an external resolver over the same public records with zero protocol authority.

---

## (e) Gaps / open questions

1. **GAP-1 tail:** `resolveLatest`/`getHistory` are stubs — an indexer must read `S2SPublicationModuleV2` directly. Should these be wired as the canonical client-side history API for indexers/auditors?
2. **GAP-2 canonicalization trap:** the top-level-only sort in `metadata.ts` must be replicated byte-for-byte by any verifier. Should an *independent* verifier (external to the action) be published so indexers/auditors have a canonical audit routine (mirroring `update/verify.ts::verifyProvenance`)? This is the single highest-value piece of greenfield code.
3. **No indexer discovery mechanism exists** — is an `indexer_*` record key + Safe-gated registration desirable, or is pure anyone-can-index sufficient? Decision point on sybil-vs-neutrality trade.
4. **Preview-vs-prod provenance:** OPEN-TASK-2 (unsigned preview) must be resolved before any indexer ingests preview output; how does an indexer know a page is a valid production render (via on-chain root + PKP proof) vs a preview artifact?
5. **Enumeration surface:** `ENSOpenSubdomainRegistry.registerSubdomain` is permissionless, but there is no on-chain registry enumerating *publications* or *deals across publications* (deal enumeration is per-module, `getDeals` on each publication's module). How does an indexer discover the full set of publications (walk ENS subdomains? a protocol records list?) — greenfield.
6. **INV-6 codec fragility:** indexers reading site roots must use the custom `contenthashToIPFS`; GAP-14 consolidation (a shared helper) would de-risk third-party ingestion.
7. **Trust model for aggregates:** if a Lit action produces a PKP-signed index *root* (option iv), what is the trust value of that attestation vs re-deriving from source — and does it need its own `authorizeCaller`/group wiring (INV-8/INV-12 patterns)?

---

## (f) Files / functions relied on (grounding)

**Specs / threat model / whitepaper:**
- `brain/specs/SPEC-00-system-contract.md` — trust domains §2, publish pipeline §3, invariants (INV-1..13), gaps (GAP-1..15), INV-append, OPEN-TASK-1/2.
- `brain/specs/SUMMARY-protocol.md` — §1–4 (data model, `S2SContentItem`, EIP-712, `objectId`, `plaintextHash`), §2 (two record stores).
- `brain/specs/SPEC-contracts-publication.md` — permissions matrix, `makeOffer`/`acceptOffer`/`retract`, INV-3, `onlySafe` vs permissionless.
- `brain/specs/SPEC-contracts-ens.md` — C3/C4/C5, INV-6/INV-12, `authorizeCaller`, `ccip_gateway` SPOF.
- `brain/threat-model/README.md`, `author.md`, `publication.md`, `protocol.md` — scoping, naming-vs-content, stoppable-by-design, compellable relays, fork-as-escape-hatch.
- `brain/whitepaper/08-authenticity-provenance.md` (DR-8.1..8.7, self-verifying HTML, JSON-LD DataIntegrityProof), `section7-verification.md`.

**Proof/signing code:**
- `shared/src/identity/sign-content.ts` — `buildSignedContentItem`, `computeObjectId`, `noOpEncrypt`.
- `shared/src/identity/verify-content.ts` — `verifyAuthorship`, `verifyPlaintextHash`, `resolveLatest`/`getHistory` (stubs).
- `shared/src/identity/signing-view.ts` — `buildSigningView`; `jcs.ts` — `jcs`, `keccakOfJson`; `contract-id.ts` — `toBytes32Id`.
- `shared/src/protocol/types.ts` — `S2S_DOMAIN`, `S2S_TYPES`, `S2SPublicContent`, `S2SProof`, `S2SContentItem`, `S2SProtocolInfo`, `DidEthr`, `eoaOf`, `toDidEthr`.
- `protocol/actions/src/render/metadata.ts` — `addAndSignMetadata` (PKP page provenance).
- `protocol/actions/src/update/verify.ts` — `verifyProvenance`, `verifyRevocable`, `verifyPathAvailable`, `readGenesisAtMfsPath`, `sanitizeRemovePath`.
- `protocol/actions/src/libs/gates.ts` — `canRead`, `canPublish`, `canReset`, `extractSignerAddress`.
- `protocol/actions/src/libs/module.factory.ts` — `getLatestEntry`, `getDeals`, `fetchByQuery`, S2SContentItem adapter.
- `protocol/actions/src/libs/evm.ts` — `evmRead`, `evmWrite`, `toHexString`.
- `protocol/contracts/contracts/S2SPublicationModuleV2.sol` — `makeOffer`, `acceptOffer`, `retract`, `hasDeal`/`hasOffer`, `getDeals`/`getOffers`, `getLatest`, `getVersion`, `authorOf`, `canPublish`, `_append` (genesisAuthor gate).
- `protocol/contracts/contracts/S2SRecordsModule.sol` — `setRecord`, `getRecords`, `getAllRecords` (all `onlySafe`).
- `protocol/contracts/contracts/ENSL2nRecords.sol` — `setText`, `getText`, `authorizeCaller`, `authorizedCallers`, `exportState`.
- `protocol/contracts/contracts/ENSOpenSubdomainRegistry.sol` — `registerSubdomain` (permissionless).
- **Precedent:** `cid-mirror/` — existing external resolver/mirror over the same public records (zero protocol authority), the closest existing analog to a third-party indexer.

**Bottom line:** the protocol's invariants and proof machinery make a **decentralized, anyone-can-index model not only possible but the natural fit** — the index is a derived, independently-auditable view of public state, with a registered/convenience layer as an optional, Safe-governed surface, and **no privileged indexer write path** (which would violate INV-10 and the neutrality principle).
