# Portable Byline (CASE 2) — Author Identity / DID surface findings

> Design study. Read-only; no code changed, no PR. Grounds CASE 2 ("a byline the AUTHOR manages
> on its OWN DID") in the actual code + specs. Author = the person; the question is what the
> author "is" and what it already controls on its own DID/Safe/identity, so we can say where a
> portable byline pointer *could* live and what is already there vs greenfield.

## (a) What an author's identity is in s2s today

**Answer: `did:ethr` whose address is a Safe (multisig), not an EOA.** The DID is a *string
convention* — there is no DID document, no resolver, no registry interaction, no Veramo anywhere
in the repo (verified: zero `veramo` refs; zero `EthereumDIDRegistry` refs). `did:ethr` is a
client-side label for "the Safe address".

Grounding:
- Canonical form: `export type DidEthr = `did:ethr:0x${string}`` — `shared/src/protocol/types.ts:37`;
  helpers `toDidEthr(address)` / `eoaOf(did)` at `types.ts:112-119`.
- Whitepaper states it directly: "the author is a **`did:ethr` whose address is a Safe (multisig),
  not an EOA** … there is **no `did:safe` method** — that phrase is shorthand for did:ethr-over-Safe"
  — `brain/whitepaper/00-introduction.md:58-62`, `01-content-authoring.md` (full rationale chain).
- The UI literally builds the string `did:ethr:${author.safe}` for a Copy button —
  `0xobsidian/src/settings.ts:129`.

### How an author address is minted / managed in 0xobsidian

1. **Keypair (EOA).** `OXOUser._generatePK()` → `ethers.Wallet.createRandom()`; EOA derived via
   `__address(privateKey)` — `0xobsidian/src/user/user.ts`. Stored on the object as `eoa` +
   `private_key`. A private key can be imported instead (author modal) —
   `0xobsidian/src/user/author.modal.ts`.
2. **Per-chain 4337 Safe.** `MainController.newAuthor()` → `new OXOUser(...)` →
   `initChains(['ETH_MAINNET','BASE'])` → `PermissionlessSafeService.connectToFreshSafe(salt)` →
   `deploySafe()` — `0xobsidian/src/main.ctrlr.ts`.
   - `PermissionlessSafeService` (`0xobsidian/src/eth/permissionless.safe.service.ts`) builds
     `toSafeSmartAccount({ owners:[signer EOA], threshold:1, version:"1.4.1", saltNonce:
     BigInt(keccak256(toBytes(salt))) })`, then `createSmartAccountClient` with a **Pimlico
     bundler + paymaster** (ERC-4337 v0.7). So on-chain `msg.sender` **is the Safe**, never the EOA.
   - `deploySafe()` = `valueTx(zeroAddress,"0")` — a zero-value user-op that deploys the proxy.
3. **Cross-chain same-address.** The salt is `s2s_${user.eoa}` (no chain in it) —
   `main.ctrlr.ts::initChain` comment: "Salt is derived ONLY from the fresh EOA … so the
   counterfactual Safe address is identical on every chain." This is the load-bearing
   **cross-chain same-address** invariant (SPEC-contracts-ens, DR-7.4): the Safe is the ENS
   subnode owner on L1 *and* the gated identity on L2 at the same address.
4. **Key custody (Track A, done).** `private_key` is encrypted at rest via Electron
   `safeStorage` → on-disk `key_blob` (base64); plaintext only transiently in memory for signing —
   `0xobsidian/src/keystore/keystore.ts` (`SafeStorageKeystore`, `PlaintextKeystore` degraded
   Linux, `UnavailableKeystore`), probe in `keystore/spike.ts`.
5. **Track B (DID-first identity inversion) is OPEN / NOT BUILT.** `RFC-0xobsidian-identity-key-
   custody-1.md` proposes making the DID the durable identity with the key rotatable underneath,
   and settled on `did:ethr` **naming the EOA directly** (`did:ethr:0xKEY`) for rotation. That is
   a proposal; nothing is implemented. Note the conflict with today's live convention
   `did:ethr:<Safe>` — see (d).

## (b) What the author controls ON its own DID / Safe / identity today

**Almost nothing on-chain.** The author's Safe is deployed with **no modules** — `newAuthor()`
only deploys the Safe; no records module, no ENS node, no config store is ever attached in
0xobsidian.

- The author's only "config store" is **local**: Obsidian plugin settings `authors[]` of
  `IOXOUser` `{name, active, eoa, private_key, key_blob?, safe}` —
  `0xobsidian/src/settings.ts` (defaults), `user/user.ts`. Not on-chain, not portable.
- **There is no per-author ENS name, no per-author records, no per-author DID document.** The
  whole ENS/records stack is **publication-scoped**:
  - `ENSOpenSubdomainRegistry.registerSubdomain(label, owner)` (L1) makes the **publication Safe**
    the subnode owner of `*.soul2soul.eth` — `protocol/contracts/contracts/ENSOpenSubdomainRegistry.sol`.
  - `ENSL2nRecords` (C3, Base) stores only `textRecords[node]["contenthash_wrapped"]` (the site
    root), written **only by the PKP** (`onlyAuthorized`, INV-12) —
    `protocol/contracts/contracts/ENSL2nRecords.sol`; `SPEC-contracts-ens.md`.
  - `S2SRecordsModule` (the per-Safe KV config store) is deployed **per publication**, not per
    author — `protocol/contracts/contracts/S2SRecordsModule.sol`; safe-app manages it on the
    *publication* Safe (`safe-app/src/lib/safe-integration.ts`).
- The author's identity is therefore expressed **only as an address that appears in per-publication
  contracts and content**:
  - **Whitelist:** the Safe address is added to the publication module's `whitelisted_authors`
    (V1 `whitelistAuthor`, `S2SPublicationModule.sol`; V2 `S2SPublicationModuleV2.whitelistAuthor`).
    The new-publication modal defaults the author field to `oxo.ctrlr.account['ETH_MAINNET'].address`
    (the Safe) — `neutralpress/src/publication/new.modal.ts:49`, published in `newPublicationSafe`
    (`shared/src/publication/new.ts`, `publication.authors`).
  - **Genesis author:** `genesisAuthor[genesis] = msg.sender` (the Safe) in V2 `_append`; surfaced
    via `Entry.author` in `getDeals`/`getLatest`/`authorOf` — `S2SPublicationModuleV2.sol`. INV-append:
    "On-chain identity is an `address` … the contract stores no did; `did:ethr` is the client-side
    layer that resolves to this address" — `SPEC-00-system-contract.md` (INV-append row).
  - **License/offer:** V1 `licenseAuthors[content_id] = msg.sender` (Safe), `grantLicense` /
    `acceptLicense` — `S2SPublicationModule.sol`.
  - **Content item:** the `author` field of signed content is `toDidEthr(baseAccount.address)` (the
    Safe's did:ethr), signed by the EOA (`proof.signer`) — `neutralpress/src/content/content.ctrlr.ts`
    `publishContent` → `buildSignedContentItem` (`shared/src/identity/sign-content.ts`).
  - **Page provenance:** the embedded proof's author identifier is `propertyID: 'did:ethr'` =
    the content author's did (Safe) — `protocol/actions/src/render/metadata.ts:52`, `render/main.ts:315`.
  - **Gates:** the recovered EOA from the `"lit actions auth"` signature must be `isOwner` of the
    author Safe **and** the Safe must pass `canPublish` — `protocol/actions/src/libs/gates.ts`
    (`canRead`, `canPublish`). This is the enforcement that the Safe is the identity.
    (Note: `shared/src/lit/gates/*.ts` are **empty placeholders** — GAP-4, dead/duplicate copy.)

## (c) Where a portable byline pointer COULD live on the author's own identity

Ranked by how much existing machinery is reused vs greenfield.

### Candidate 1 — Author-controlled `S2SRecordsModule` on the author Safe (strongest fit)
- **What exists:** the exact primitive needed. `S2SRecordsModule` is an **immutable, `onlySafe`**
  KV store (`setRecord`/`setRecords`/`deleteRecord`, readable via `getRecord`/`getRecords`/
  `getAllRecords`, plus key enumeration) — `S2SRecordsModule.sol`. The author Safe already has the
  4337 client and Safe ABIs to `enableModule` (0xobsidian has `genericTx`/`batchGenericTx`;
  neutralpress uses the same pattern to enable modules in `shared/src/publication/new.ts`).
  `S2SRecordsModule` has a `NAME` getter ("S2S Records Module") so it is discoverable by the same
  module-walk as INV-4. Reads are permissionless; writes are gated to the Safe (`msg.sender == safe`).
- **Greenfield:** 0xobsidian never deploys/enables any module on the author Safe today. Deploying +
  enabling a records module and defining the key scheme (e.g. `byline`, `profile`, `publications`)
  is net-new authoring-side work, but reuses a live contract with zero contract changes.
- **Reader discoverability:** a reader follows author → Safe → `getModulesPaginated` → find the
  records module → `getRecords([...])`. No ENS needed. This is the closest thing to "the author
  controls a config store on its own DID" that already exists as a primitive.

### Candidate 2 — Author ENS subnode `<author>.soul2soul.eth` with records
- **What exists:** `ENSOpenSubdomainRegistry.registerSubdomain(label, owner)` is **free and
  permissionless** and makes `owner` the subnode owner via `nameWrapper.setSubnodeOwner`
  (`ENSOpenSubdomainRegistry.sol`); `ENSL2nRecords` stores arbitrary `textRecords[node][key]` (C3).
- **Greenfield / blocking gaps:** (i) today only publication Safes are ever registered; an author
  node would be a new registration (fine, it's permissionless). (ii) **Who writes the record?** C3
  `setText` is `onlyAuthorized` — only the **PKP** (and owner/protocol) can write. The author Safe
  **cannot** write its own records on the shared C3 store. So an author node needs either an
  author-owned records contract wired as the resolver source, or a loosening of C3 (touches
  INV-12's security model — do-not-touch per SPEC-contracts-ens). (iii) The protocol's own wildcard
  resolver `ENSResolverWithCCIP` only resolves `contenthash`/`addr` reliably; **generic `text()` is
  stubbed to a hardcoded `"default"` key** (SPEC-contracts-ens "Gotchas"; `ENSResolverWithCCIP.sol`
  `resolveText`), so a generic byline text record through the protocol resolver would not resolve
  today. (iv) The custom contenthash codec is only resolvable by the project's own resolver+gateway.

### Candidate 3 — `did:ethr` document / EthereumDIDRegistry (the RFC's Track B)
- **What exists:** nothing in code. `RFC-identity-key-custody` Track B is an open proposal: DID as
  durable identity, `did:ethr` via Veramo naming the **EOA** directly for rotation, with the
  EthereumDIDRegistry supporting time-aware rotation. No resolver, no registry call, no Veramo dep.
- **Greenfield entirely.** A byline could live in the DID document (service/attribute), but the
  whole identity-inversion + registry integration + migration story is unbuilt, and it carries the
  author-name conflict in (d).

### Candidate 4 — ENS reverse / public-resolver text records (weakest)
- `shared/src/ens/index.ts::getContractAddressFromEnsName` reads a `contract.address` **text record**
  through the *public* L1 ENS registry/resolver (`ensRegistryABI`/`resolverABI` in
  `shared/src/ens/abi.ts`). It is currently **unreferenced (dead code)**. As written it would not
  resolve s2s names through the protocol's CCIP resolver (which stubs generic text). Only relevant
  if we adopt a standard L1 ENS name for authors with a real resolver — otherwise skip.

## (d) Gaps / open questions / invariants that constrain a byline on the author DID

1. **Author is a Safe, not an EOA (invariant).** Any byline that must be written *by the author*
   must be written through the 4337 Safe (paymaster/bundler), so `msg.sender == Safe`. A record
   store whose writer gate is `onlySafe` (Candidate 1) composes cleanly; anything keyed to the EOA
   would not match what on-chain reads see.
2. **Who writes records — the big one.** The only existing per-node record store (C3, ENS records)
   is **PKP-only** (`onlyAuthorized`, INV-12). The author has no write path there. Either give the
   author its own `onlySafe` records module (Candidate 1 — reuses existing contract, zero protocol
   change) or change C3's authorization (do-not-touch blast radius: SPEC-contracts-ens 🔴).
3. **Naming-convention collision.** Live convention is `did:ethr:<Safe>` (settings.ts, content
   author, provenance). RFC Track B wants `did:ethr:<EOA>` for rotation. A byline anchored to the
   "author DID" must first decide which address the DID names — Safe (today) or EOA (Track B) —
   or the byline and the gating identity drift apart.
4. **Key rotation / revocation (RFC Track B).** Today identity *is* the keypair; Track A only
   encrypts at rest, it does not make identity survive rotation. "Key rotation = swap the Safe's
   signers, not the DID" (whitepaper 01). A portable byline stored on the Safe survives signer
   rotation automatically (the Safe address is stable); a byline stored keyed to the EOA (if Track B
   names the EOA) would break on rotation unless the DID-registry resolution path exists.
5. **Discovery.** There is no global "given an author, find its byline" reader today. Candidate 1
   needs a module-walk; Candidate 2 needs the author node registered + a resolver that returns text;
   Candidate 3 needs a resolver. No `resolveAuthorByline(author)` helper exists anywhere
   (`resolveLatest`/`getHistory` in `shared/src/identity/verify-content.ts` are stubs).
6. **Provenance inconsistency to be aware of.** In `render/main.ts:315-320` the *publisher* `did`
   is built from `signerAddress` (the **EOA**), while the *author* `did` is `body.author` (the
   **Safe**). If a byline becomes the durable author pointer, the provenance emitter should be
   aligned so author-facing identifiers are consistently the Safe's did:ethr.
7. **Cross-chain same-address.** Because the Safe is deterministic across L1/L2, an author records
   module deployed on the author Safe on Base would resolve identically on L1 — a portable byline
   benefits from this, but only if the module address (not just the Safe) is what's stored/pointed to.
8. **Generic ENS `text` resolution is stubbed** (SPEC-contracts-ens Gotcha + `ENSResolverWithCCIP`
   `resolveText` → `"default"` key). Any byline-over-ENS approach that relies on arbitrary text
   record keys through the protocol resolver is blocked until that is built.

## (e) File / function list relied on

**0xobsidian (author identity + custody)**
- `0xobsidian/src/user/user.ts` — `OXOUser`, `_generatePK` (`Wallet.createRandom`), `__address`,
  `setSafeAddress`, `IOXOUser`.
- `0xobsidian/src/main.ctrlr.ts` — `MainController.init`, `initChain` (salt `s2s_${eoa}`),
  `newAuthor` (initChains + `deploySafe`), `toggleAuthor`, `hideAuthor`, `resetAccounts`.
- `0xobsidian/src/eth/permissionless.safe.service.ts` — `connectToFreshSafe`, `connectToExistingSafe`,
  `setSafe`, `deploySafe`, `updateSigner`, `signTypedData`, `asTypedDataSigner`, `batchGenericTx`,
  `genericTx` (4337 + Pimlico paymaster).
- `0xobsidian/src/keystore/keystore.ts`, `spike.ts` — `SafeStorageKeystore`, `PlaintextKeystore`,
  `probeKeystore` (Track A).
- `0xobsidian/src/settings.ts` — `IOxOSettings.authors`, DID string `did:ethr:${author.safe}`
  (line 129), `OxOAuthorsTab`.
- `0xobsidian/src/user/author.modal.ts` — author create (name/optional private key).
- `0xobsidian/src/user/ens.ts` — stub (always null) — no live ENS helper.

**shared (identity + publication)**
- `shared/src/protocol/types.ts` — `DidEthr`, `S2SPublicContent.author`, `S2SProof.signer`,
  `S2S_DOMAIN`/`S2S_TYPES`, `toDidEthr`, `eoaOf`, `S2SProtocolInfo` (ensRegistry, ensRecords).
- `shared/src/identity/sign-content.ts` — `buildSignedContentItem` (author = explicit did:ethr, here
  the Safe).
- `shared/src/identity/verify-content.ts` — `verifyAuthorship` (recovers EOA, checks it's the
  author's address), `resolveLatest`/`getHistory` (**stubs**).
- `shared/src/identity/contract-id.ts` — `toBytes32Id`.
- `shared/src/publication/new.ts` — `newPublicationSafe` (ENS `registerSubdomain`, records module,
  whitelists `publication.authors`), `enableModule` on publication Safe.
- `shared/src/ens/index.ts` + `abi.ts` — `getContractAddressFromEnsName` (**unused**) — public-resolver
  text-record convention.
- `shared/src/protocol/index.ts` — `getProtocolInfo`, `getProtocolControllerAndModules` (INV-4 walk),
  `getRecords`.

**neutralpress (author → content)**
- `neutralpress/src/content/content.ctrlr.ts` — `publishContent` → `toDidEthr(baseAccount.address)`
  (author = Safe did), stores `author` + `genesis` in frontmatter.
- `neutralpress/src/publication/new.modal.ts:49` — default author = `account['ETH_MAINNET'].address`
  (the Safe).
- `neutralpress/src/publication/publish.ts`, `revoke.ts`, `publication.service.ts` (makeOffer/
  acceptOffer/retract/hasDeal over V2).

**protocol (on-chain + gates + provenance)**
- `protocol/actions/src/libs/gates.ts` — `canRead`, `canPublish`, `canReset` (recovered EOA must be
  `isOwner` of author Safe; Safe must pass `canPublish`).
- `protocol/actions/src/render/main.ts` (author/publisher did), `render/metadata.ts`
  (`addAndSignMetadata`, author propertyID `did:ethr`, publisher `did:ethr:safe`, verificationMethod
  `did:pkh:eip155:8453`).
- `protocol/contracts/contracts/S2SPublicationModule.sol` — `whitelistAuthor`, `grantLicense`,
  `licenseAuthors` (V1, `msg.sender` == Safe).
- `protocol/contracts/contracts/S2SPublicationModuleV2.sol` — `_append` (`genesisAuthor[genesis]=
  msg.sender`), `whitelistAuthor`, `Entry.author`, `authorOf`, `hasDeal`.
- `protocol/contracts/contracts/S2SRecordsModule.sol` — `setRecord`/`setRecords`/`getRecords`/
  `getAllRecords`/`getAllKeys`, `onlySafe`, `NAME` — **the reusable per-Safe KV primitive**.
- `protocol/contracts/contracts/ENSOpenSubdomainRegistry.sol` — `registerSubdomain` (permissionless,
  makes any owner the subnode owner).
- `protocol/contracts/contracts/ENSL2nRecords.sol` — `setText`/`getText`, `authorizedCallers`
  (`onlyAuthorized`, PKP-writes-root, INV-12).
- `protocol/contracts/contracts/ENSResolverWithCCIP.sol` — `resolve`/`resolveText` (generic text
  stubbed to `"default"`), `resolveContenthash` (`contenthash_wrapped`).

**Docs/specs**
- `brain/specs/SPEC-0xobsidian.md`, `brain/specs/RFC-0xobsidian-identity-key-custody-1.md`,
  `brain/specs/SPEC-contracts-ens.md`, `brain/specs/SPEC-contracts-publication.md`,
  `brain/specs/SUMMARY-protocol.md` (§1-2), `brain/specs/SPEC-00-system-contract.md` (INV-1, INV-4,
  INV-6, INV-10, INV-12, INV-append, GAP-1, GAP-4), `brain/code-map/MAP.md`,
  `brain/whitepaper/00-introduction.md`, `01-content-authoring.md`, `07-domain-resolution.md`,
  `08-authenticity-provenance.md`, `brain/threat-model/author.md`.
