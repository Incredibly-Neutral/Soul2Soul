# Authoring, as built

**Implementation companion to Polyphony §2 (Authoring).**

> **Type:** a point-in-time reading of the `s2s` prototype against the paper — not a SPEC. The
> authority is Polyphony §2. This document reports what the code does, which technical choice
> produces each behaviour, and where the prototype stops.
>
> **Date:** 2026-10-25. **Basis:** a source read of every path cited here, plus the `brain/`
> decision documents named inline. **Scope:** authoring only — not publication governance, not
> hosting, not the validity of what a publication chooses to admit.
>
> **Two conventions.** Every claim carries a path, a function or a contract line. A claim I could
> not check from the code is marked UNVERIFIED. Where a decision document and the code disagree,
> the code is reported and the document is named as out of date.

## 0. Terms, and the two addresses

| Polyphony | The prototype |
|---|---|
| **Author** | An author account: a Safe on Base. The key beneath it is an ordinary EOA. The record names the account. |
| **Publication** | A publication Safe that owns an ENS name on Ethereum L1, plus one `S2SPublicationModuleV2` on Base for each publication. |
| **Agreement** | A *deal*: membership of a genesis in that module's deal set. The same genesis also carries the version log. |
| **Renderer** | The Lit action `render`, executed by the operator against a PKP. The page it produces is signed by the PKP, not by the author. |
| **Ledger** | Base mainnet, chain id 8453. Names and the publication root live on L1. |

Two addresses matter throughout, and the prototype does not always keep them apart:

- **The Safe** is the author. It is the `msg.sender` of every protocol transaction, the address the
  publication whitelists, and the address written into the signed metadata as
  `did:ethr:<safe>` — `neutralpress/src/content/content.ctrlr.ts:177`.
- **The EOA** is the signing key. It produces the EIP-712 signature on each content item, signs the
  `"lit actions auth"` string that unlocks rendering, and signs the ERC-4337 user operation that the
  Safe executes.

The plugin writes the Safe into the record. The CLI writes the EOA —
`author-cli/src/core/author.ts:135` — so the two clients disagree on what an author is. That single
line is the origin of several failures described below, and it is worth knowing before reading the
guarantees: **the same table holds two different kinds of author row.**

## 1. One publish, from a draft to a version, and then out

**The account exists before any work does.** `0xobsidian/src/main.ctrlr.ts:144-159` builds the
account lazily: derive the EOA from the stored private key, compute the counterfactual Safe address
from the salt `s2s_${eoa}`, and connect. The salt contains no chain id on purpose, so the same
address exists on every chain and the Safe can be deployed on Base now and on L1 later. Deployment
is `SafeL2` v1.4.1, singleton `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`, proxy factory
`0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, one owner, threshold 1 —
`0xobsidian/src/eth/permissionless.safe.service.ts:170-204`. If settings already hold a Safe
address, the client reconnects to it by address instead of re-deriving
(`main.ctrlr.ts:157`), which is what makes a key change survivable.

**A publication is a different account.** It is a Safe that owns a name on L1 under
`soul2soul.eth`, with a records module and a publication module installed on its Base address. The
author never touches either: the author's account currently has no modules installed at all.

**Drafting is local and produces an identity before it produces a network request.** Parsing the
markdown and its frontmatter is host code. Then
`shared/src/identity/sign-content.ts:46-105` runs in a fixed order that matters:

1. Canonicalise the body with JCS and hash it — `plaintextHash`
   (`sign-content.ts:48-50`).
2. Build the public metadata, including `plaintextHash`, and derive the signing view.
3. Compute `objectId` as the EIP-712 digest of that view (`:76-80`).
4. Sign the view with the EOA (`:83-87`). `proof.signer` records the EOA; `public.author` records
   whatever the caller passed.
5. Encrypt, or not, and place the result in `body` (`:100-104`).

So the work's identity is a pure function of its public metadata and the hash of its body. The CID
does not exist yet and is not needed. Two consequences are load-bearing: re-publishing identical
content reproduces the same `objectId`, and the object can be offered to a publication before
anybody — including the publication — can read it.

**Encryption is not invoked.** Both hosts pass `noOpEncrypt` into that call —
`content.ctrlr.ts:174`, `author.ts:134` — and `sign-content.ts:104` records
`encryption: encryptFn !== noOpEncrypt`. Every item published today therefore carries
`encryption: false` and a plaintext body, and the plaintext goes to IPFS. This is the largest single
gap in the section, and it is one argument at two call sites.

**Upload is off-chain.** `neutralpress/src/publication/publish.ts:59-67` serialises the item with
`JSON.stringify(signedItem, null, 2)` and posts it to the author's own Kubo node; the two-space
indentation is deliberate, because the Filecoin CAR is built from the same bytes and the Kubo CID
must equal the Filecoin root CID. The Filecoin leg is fire-and-forget, and mirrors to other pinning
providers run after it. No ENS name is resolved and no transaction is sent at this step.

**Append and offer are one transaction.** `publish.ts:74` calls `makeOffer(genesis, cid)` on the
publication module. In `S2SPublicationModuleV2.sol:145-168` that function appends a
`Version{cid, timestamp, tombstone}` to `versions[genesis]` and then sets membership: the
publication Safe and whitelisted authors become a deal, everybody else becomes a pending offer. The
transaction is sent from the author's account on Base. In the plugin it is an ERC-4337 user
operation signed by the EOA, executed by the Safe, with gas paid by a Pimlico paymaster — so the
chain sees the Safe and the bundler sees the operation. In the CLI it is a plain EOA transaction, so
the chain sees the EOA. This is where the two author rows diverge in practice.

**The append is also the authorisation to render.** Nothing else tells the renderer what to render:
the client submits a list of genesis ids plus a signature over the literal string
`"lit actions auth"` (`author.ts:265`), and `protocol/actions/src/prep/main.ts` reads the version log
for those ids and fetches the item at the latest CID. There is no grant transaction, no queue, and
no watcher — `rg` finds no `watchEvent`, `onLogs` or `getLogs` in any of `shared/`, `protocol/actions`,
`author-cli/`, `neutralpress/` or `0xobsidian/`. Rendering is client-driven, which contradicts
`brain/threat-model/author.md`, where it is described as chain-driven; the code wins and the document
is stale.

**The page is signed by the renderer's key.** `protocol/actions/src/render/metadata.ts:45-58` copies
the author's address into the page as `schema.author.identifier.value` with
`propertyID: 'did:ethr'`; `:105-107` hashes the HTML body into `schema.encoding.sha256`; and the
whole JSON-LD object is signed with the PKP. `protocol/actions/src/update/verify.ts:47-90` verifies exactly three
things: the recovered address is the expected PKP, the HTML hash matches, and the identifier is the
expected genesis. The author's EIP-712 signature is **not** in the page and is **not** checked by the
renderer.

**A revision reuses the genesis.** The plugin reads `genesis` from frontmatter
(`content.ctrlr.ts:148-151`) and returns the item with that id; the CLI reads it from the same place
(`author.ts:127`). A second `makeOffer` against the same genesis appends version 2. The contract
requires the caller to be the genesis author or the publication Safe
(`S2SPublicationModuleV2.sol:347-360`), so a revision sent from the wrong account reverts rather
than silently forking. Nothing on the contract side can detect a revision that arrives with a *new*
genesis instead: it looks exactly like a new work, and the client's frontmatter is the only place
that distinction lives.

**Ending an agreement is one call and no consequence.** `retract(genesis)`
(`S2SPublicationModuleV2.sol:182-196`) is asymmetric on purpose. Called by the genesis author, it
removes the id from the deal and offer sets unconditionally. Called by the publication Safe, it
demotes a deal to an offer instead of ending it — the publication cannot delete an author's
withdrawal, and the author cannot be forced back in. What does not happen: the site is not rebuilt.
The renderer recomputes revocation when it renders a page, using `isRevokedByDealState`
(`protocol/actions/src/render/main.ts:42, 243`), but only for the ids in the request — a cascade
destination such as the home page is never checked — and only when someone asks it to render.

**Rotation is two half-flows with nothing joining them.** The Safe is a real Safe 1.4.1; the ABI for
`swapOwner`, `addOwnerWithThreshold`, `removeOwner` and `changeThreshold` is present in
`shared/src/contracts/safe_implementation.ts`, and the Safe's own events record every change
permanently. But no code in the repository calls any of them for an author account: the only
`addOwnerWithThreshold` writer is `shared/src/publication/new.ts:209`, which builds publication
Safes. On-chain rotation today happens in Safe{Wallet}, outside the prototype. The other half is
local: `updateSigner` (`permissionless.safe.service.ts:108-111`) swaps the key in memory, and
because settings hold the Safe address, the client keeps its identity. The two halves are not
checked against each other. Rotate on-chain without telling the client and every user operation
fails validation; tell the client without rotating on-chain and the same thing happens. And because
CLI-published works record the EOA as their genesis author, a rotation strands their append and
retract rights entirely — the new key is a stranger to those rows.

## 2. The nine guarantees

Each entry states how the prototype does it, why it was done that way and what was rejected, what
the status is, and where to check. Statuses are met, partly met, or not yet, with the gap named.

### 2.1 Write and revise offline; publish separately

**How.** Signing reads no network: canonicalisation, hashing, the EIP-712 digest and the signature
are all local (`sign-content.ts:46-105`). `upload` puts bytes on Kubo and Filecoin and returns
nothing else; the CLI exposes it precisely so a draft can be stored long before it is offered.
Publication is a separate, later, explicit act: `makeOffer` in the plugin, `propose` in the binary.
Local preview runs the same render action on Bun, so what the author checks is what the renderer
will produce.

**Why this way.** The rejected alternative was the ordinary one: a draft lives in the application
and publishing is a state change on the server. That was rejected because it makes the host the
owner of the author's unpublished work, and because the protocol's own object — a signed item — is
sufficient without one. `brain/specs/SPEC-hosts.md` AD-1 and AD-2 record the consequent rule: hosts
own their interfaces, shared holds pure functions and injected dependencies, and no host imports
another's internals. The price is stated there too: nothing validates the object's semantics, so a
host can produce a well-formed item with the wrong meaning — which is exactly what happened with
the author field.

**Status: met.**

**Where.** `shared/src/identity/sign-content.ts:46-105`; `author-cli/src/core/author.ts:118-150`
(the upload/propose split); `neutralpress/src/publication/publish.ts:59-67`.

### 2.2 Work is encrypted to the author's account and readable only under an agreement

**How the design works.** The body would be a Lit ciphertext sealed to a PKP whose key is generated
inside a TEE and never leaves it (`shared/src/lit/lit.service.ts:300`,
`shared/src/lit/actions/encrypt.ts`). The ciphertext lives on IPFS and Filecoin. The record holds
only the CID. Access is not a stored permission: `protocol/actions/src/libs/decrypt.ts:4-30` calls
`canRead` before decrypting, and `protocol/actions/src/libs/gates.ts:14-40` resolves it as three
chain reads — the author's Safe is admitted to this publication
(`canPublish`, `S2SPublicationModuleV2.sol:280-284`, address membership only), the presenting signer
is an owner of the author's Safe (`isOwner`), and the genesis has a deal (`hasDeal`). The decrypt
call itself runs inside the Lit action, so the keyholder is the enclave, not the operator.

**Why this way.** Two alternatives were rejected. A publication-held key would let the publication
read everything it hosts, which is the thing the guarantee forbids. A stored access-control list
would make some server the arbiter of who may read, and would have to be kept in sync with the deal
set — two sources of truth for one fact. The chain read has the opposite property: it is evaluated at
the moment of decryption, from the same state the agreement lives in.

The threshold question is separate and the answer changed under the prototype. Lit's current
version derives a single key inside one enclave and has no t-of-n recombination, so "no single party
holds the key" is not implementable on this stack. The plan recorded in `brain/` is a Phala/dstack
enclave with the renderer key generated inside it plus an operator recovery secret. That plan has no
code: `rg -i "phala|dstack"` matches only two review notes under `brain/reviews/`.

**Status: not met.** Both hosts pass `noOpEncrypt` (`content.ctrlr.ts:174`, `author.ts:134`), so
nothing published is encrypted and every body is in the clear on IPFS. Beyond the missing call,
there is a second unanswered question that only shows up if you turn encryption on: the renderer's
gate checks `isOwner(authorSafe, signerAddress)` where `signerAddress` is recovered from the
client-supplied `"lit actions auth"` signature (`render/main.ts:104`). That signature is an author
secret presented per render, not a standing grant to the operator, so an encrypted item renders only
while the author is present to authorise it. That may be the right behaviour, but it is a design
decision that has never been exercised: no test renders an encrypted item outside a mock
(`render/availability.test.ts`).

**Where.** `sign-content.ts:100-104`; `lit.service.ts:300`; `libs/decrypt.ts:4-30`;
`libs/gates.ts:14-40`; `render/data.ctrlr.ts:112-131`; `S2SPublicationModuleV2.sol:280-284`.

### 2.3 End any agreement alone, and the site is rebuilt without the work

**How.** `retract` is one transaction from the author's account. Membership is set membership, so
the withdrawal is a removal, not a flag: the id leaves the deal set and the offer set, and the
event records which caller did it (`S2SPublicationModuleV2.sol:182-196`). The publication cannot
undo it — its own call can only demote a deal to an offer. Revocation is then a *derived* fact, not
a stored one: the renderer asks whether the id is still a deal before placing it
(`render/main.ts:42, 212-250`), so a re-render of any page that carries the work drops it.

**Why this way.** V1 had licence objects with `grantLicense`, `acceptLicense` and `revokeLicense`.
V2 collapsed them into sets (`brain/specs/SPEC-contracts-publication.md`, INV-2/3/4/10), because a
licence object needs a lifecycle and the only lifecycle anyone needed was membership. A revocation
registry was rejected for the same reason: it would be a second place that can disagree with the
deal set.

**Status: partly met.** The withdrawal half is exact and unilateral. The consequence half is not
built. Nothing watches `Retracted`, so no render is triggered by the withdrawal; `remove[]` in the
prep action is populated only for slug changes, not for revoked ids
(`brain/handoffs/handoff-prep-ripples-from-revoke.md` is the unbuilt plan); and the revoked check is
conservative in three ways — it only covers ids in the current request, it skips ids with no known
path, and it fails open when the RPC call fails (`render/main.ts:212-250`). An author can end an
agreement today; the site will still show the work until someone renders the page again.

**Where.** `S2SPublicationModuleV2.sol:182-196`; `render/main.ts:42, 243`; absence of any log
subscriber anywhere in the repository.

### 2.4 Revise and reissue; every version is signed and recorded

**How.** `versions[genesis]` is append-only and ordered, and each entry carries the CID and the block
timestamp (`S2SPublicationModuleV2.sol:347-371`). `getLatest`, `getVersion`, `getVersionCount` and
`authorOf` expose it publicly with no permission. The genesis id never changes: `genesisAuthor` is
written once on the first append. The signature that binds a version is inside the version — the
signed item sits at the CID the log points to — so recording and signing are one act.

**Why this way.** A mutable pointer (an ENS contenthash, a row that gets overwritten) was rejected
because authorship claims need the sequence, and because a pointer gives whoever holds it the power
to rewrite history. `SPEC-00-system-contract.md` records this as INV-append.

**Status: partly met.** Recorded: yes, with a real limit — `Version` has no author and no signature
field, so a version's authenticity depends on the item at that CID remaining fetchable. Signed: the
bytes are signed, but nothing verifies the signature at read time, and the one function that would
is both uncalled and wrong. `verifyAuthorship` (`shared/src/identity/verify-content.ts:33-80`)
compares the recovered EOA to `eoaOf(item.public.author)` (`:65`), and `eoaOf` is the string after
`did:ethr:` (`shared/src/protocol/types.ts:122-124`). For a plugin-published item that string is the
Safe, while the signature recovers to the EOA, so the function returns false for every item the
plugin publishes. It has no call sites — the comment at `verify-content.ts:17` says "called by
decryptors before rendering", and that call does not exist. Genesis resolution is the client's
frontmatter, in both hosts, and is correct today; `resolveLatest` and `getHistory` are still stubs
that log "append-log contract pending" (`verify-content.ts:124-141`) although the log has existed
since V2.

**Where.** `S2SPublicationModuleV2.sol:40-55, 250-278, 347-371`;
`content.ctrlr.ts:148-151, 185`; `author.ts:127`; `verify-content.ts:33-80, 124-141`;
`types.ts:122-124`.

### 2.5 Rotate keys without losing the account, the history, or the reputation

**How.** Identity is the account address, and the address cannot change. Keys are entries in a set
the Safe owns, so a rotation is `swapOwner` on the account and nothing else: every past
`genesisAuthor`, every `Appended` event and every page's `did:ethr` value still points at an address
that still controls the same account. The client is built for this — settings store the Safe address,
so a new key reconnects to the same account rather than deriving a new one
(`0xobsidian/src/main.ctrlr.ts:157`, `permissionless.safe.service.ts:186-204`).

**Why this way.** The rejected alternative is a name registry that carries key history: a `did:ethr`
with an `EthereumDIDRegistry` entry, or a Veramo-style document. That was the original plan
(`brain/specs/RFC-0xobsidian-identity-key-custody-1.md:62, 88` proposes a DID whose controller can be
rotated), and it was reversed in `brain/handoffs/handoff-owner-history-module.md` §2: the account is
the identity, no DID document is issued, and `did:ethr:<safe>` survives only as a string convention
in metadata. The reason recorded there is that a registry adds a contract whose word you must accept
for something the ledger already answers — ownership of an account — and that a registry can be
abandoned, upgraded or lied about, while the account cannot.

**Status: partly met.** Address stability is real and is the strongest part of the design. Four
things are missing. There is no in-app rotation path; only the ABI is present. There is no
`isOwnerAt` reader, so a verifier cannot say who controlled the account when version *n* was
written — the facts are on chain as the Safe's `AddedOwner`/`RemovedOwner`/`ChangedThreshold`
events, but nothing in `s2s` reads them. Threshold is 1 with one owner, so there is no recovery: a
lost key means a lost account. And because CLI-published works record the EOA as the genesis author,
rotating the key strands them: appends and retracts from the new key revert `OnlySafe`
(`S2SPublicationModuleV2.sol:354-355`), because the contract compares addresses and knows nothing
about owners.

**Where.** `permissionless.safe.service.ts:108-111, 170-204`; `main.ctrlr.ts:144-159`;
`shared/src/contracts/safe_implementation.ts` (ABI only); `handoff-owner-history-module.md` §2, §4,
§6; `prototype-soul2soul.md:70-78` (recovery shortfall).

### 2.6 Pseudonymous; the protocol never holds a legal name

**How.** There is no name field. `S2SPublicContent` (`shared/src/protocol/types.ts`) carries an
address, metadata and a body hash; no schema in the repository has a `name`, `email` or `author.name`
field that reaches the record. The plugin holds a local label in `user.name` and never publishes it.
Transactions reach the chain from the Safe via a bundler, so the author's IP is not on the
identity-bearing write.

**Why this way.** An optional display name was rejected. A field that exists gets filled, and a
filled name field is one a publication can require. The design position is recorded in
`brain/threat-model/author.md`: the author is a pseudonym, not an anonym, and the only link the
design tries to break is IP → pseudonym → person.

**Status: met**, with the residuals named in the threat model rather than hidden: the address is
public forever; the bundler can recover the EOA that signed the user operation and link it to the
Safe; and any fiat funding of the account is a leak, which is out of protocol scope by decision.

**Where.** `shared/src/protocol/types.ts`; `brain/threat-model/author.md` §"What the protocol actually
guarantees"; `permissionless.safe.service.ts` (user-operation path).

### 2.7 Receive their share directly at a linked wallet

**How.** There is no mechanism. No contract in `protocol/contracts/contracts/` is payable, has a
split, a withdrawal or a fee field; `rg -i "payable|revenue|royalt|splitBps|withdraw\("` over the
protocol contracts and `shared/src` returns nothing outside generated ABIs. No content item has a
payment field, and no page metadata carries a payout address.

**Why.** This is a deferral shared with the paper, not a divergence: `brain/whitepaper/v2.md:36`
describes the disclosure gate as "described in this paper and not yet built". Payment needs a
disclosure gate that can price a read, and that gate does not exist on either side.

**Status: not met.** Nothing to check, which is the check.

**Where.** absence in `protocol/contracts/contracts/*.sol`; `brain/whitepaper/v2.md:36`.

### 2.8 No exclusivity; the same work can be offered elsewhere

**How.** Nothing in the system reads another publication's state. A publication's whitelist, deal set
and version log are its own storage in its own module
(`S2SPublicationModuleV2.sol:297-315`; `brain/research/2026-09-10-deals-ledger-convergence.md`), and
the author's account is not registered anywhere a publication could query for a list of its other
agreements. The same bytes may sit at two modules under two ids; the protocol has no notion of a work
being "taken".

**Why this way.** An exclusivity clause enforced by the protocol was rejected as unenforceable in the
direction that matters: a publication that wants exclusivity can ask for it in a contract between
people, and the ledger cannot see that contract. Putting exclusivity in the module would mean the
module reading state it does not own.

**Status: partly met.** Non-exclusivity is real — there is nothing to enforce. "Anywhere" is not.
A work's *first* append requires `canPublish(author)` (`S2SPublicationModuleV2.sol:351-353`), so a
new work cannot enter a publication as a pending offer; the documented "anyone becomes an offer"
branch is unreachable for new content, as
`brain/research/2026-09-10-deals-ledger-convergence.md` records. An author publishes where they have
been admitted. Second, `publication` is inside the signed metadata, so submitting the same draft to
two publications produces two different `objectId` values and therefore two geneses; sameness is
provable through `plaintextHash`, but "one work, many publications" is not representable as one row.
That is not an exclusivity violation, and it does mean the two copies cannot be read as one work by
anything that keys on genesis.

**Where.** `S2SPublicationModuleV2.sol:145-168, 280-284, 297-315, 351-353`;
`brain/research/2026-09-10-deals-ledger-convergence.md`.

### 2.9 A public, author-curated list of works and agreements

**How today.** Only enumeration. `getDeals(offset, limit)` and `getOffers(offset, limit)` page a
global list per publication, and `authorOf(genesis)` answers one id at a time
(`S2SPublicationModuleV2.sol:217-278`). There is no author → works index anywhere, on chain or off:
an author's own history is reconstructible only by scanning every publication's events and filtering
by address.

**Why this way (and what was rejected).** A hosted profile or a DID document was rejected because it
reintroduces a party that must be trusted to keep the list. The chosen shape is an author-owned
records store: `S2SRecordsModule` is an immutable key-value store writable only by its owner Safe and
readable by anyone, so an author who installs one on her own account can publish her own list from
her own account (`brain/research/2026-09-10-author-owned-bylines-scoping.md:88-97, 129, 340-343`).
That research also establishes what is missing: the installation batch, the schema for the list, the
resolver that reads it, and a decision about who pays. None of it is built, and the author's account
has no modules installed today.

**Status: not met.** The ledger facts are public and permanent; the author's own list does not exist.

**Where.** `S2SPublicationModuleV2.sol:217-278`; `S2SRecordsModule.sol`;
`brain/research/2026-09-10-author-owned-bylines-scoping.md`.

## 3. Conformance

| # | Guarantee | Status | Evidence |
|---|---|---|---|
| 1 | Write and revise offline; publish separately | **met** | local signing and hashing (`sign-content.ts:46-105`); `upload` performs no chain call (`author.ts:118-150`) |
| 2 | Encrypted to the author's account; readable only under agreement | **partly** | gate and ciphertext branch complete (`gates.ts:14-40`, `data.ctrlr.ts:112-131`); `noOpEncrypt` at both call sites (`content.ctrlr.ts:174`, `author.ts:134`) |
| 3 | End any agreement alone; site rebuilt without the work | **partly** | author-only withdrawal (`S2SPublicationModuleV2.sol:182-196`); no subscriber, no ripple, revoked check covers requested ids only (`render/main.ts:212-250`) |
| 4 | Revise and reissue; every version signed and recorded | **partly** | append-only log (`S2SPublicationModuleV2.sol:347-371`); `verifyAuthorship` uncalled and returns false for Safe-authored items (`verify-content.ts:65`); history readers are stubs |
| 5 | Rotate keys without losing account, history, reputation | **partly** | address-stable identity (`main.ctrlr.ts:144-159`); no in-app rotation, no `isOwnerAt`, threshold 1, CLI rows name the EOA |
| 6 | Pseudonymous; no legal name in the record | **met** | no name field in `S2SPublicContent`; `brain/threat-model/author.md` |
| 7 | Receive their share at a linked wallet | **not yet** | no payable, split or link mechanism in any protocol contract |
| 8 | No exclusivity; the same work can be offered elsewhere | **partly** | per-publication state only; first append needs admission (`:351-353`) |
| 9 | Public, author-curated list of works and agreements | **not yet** | global enumeration only (`:217-278`); author store unbuilt |

Score on the 0–3 mechanism rubric used in
`brain/audits/polyphony-authoring-compliance-2026-10-25.md` (3 enforced end to end, 2 one unenforced
hop, 1 piece exists but cannot be relied on, 0 no mechanism): **15 of 27**. In plain terms, the
prototype **meets 2 of the 9 guarantees outright** (1, 6), meets 2 with one unenforced hop each (4, 5),
has 4 that are partial (2, 3, 8, 9), and 1 that is absent (7).

One score is revised from the earlier audit: guarantee 8 moves from 3 to 2, because the admission
gate on a work's first append makes "publish anywhere" mean "publish at any publication that has
admitted you".

## 4. Divergences and debts

Ordered by how much of a guarantee each one costs.

**D1 — Encryption is not wired.** `noOpEncrypt` at `content.ctrlr.ts:174` and `author.ts:134`; the
renderer's decrypt branch is therefore dead and `encryption` is false on every published item. This
alone costs guarantee 2. *Remediation:* pass a Lit `encrypt` function at both call sites, then render
one encrypted item end to end and assert the plaintext never appears at the gateway. It is one
function and two arguments, plus the gate question below.

**D2 — The decrypt gate asks the renderer to be the author.** `canRead` requires the presenting
signer to be an owner of the author's Safe (`gates.ts:29-33`), and the signature the renderer holds
is the author-supplied `"lit actions auth"` string (`render/main.ts:104`). So an encrypted item
renders only while the author supplies that signature. Nothing is wrong with this if it is intended —
it is a strong property — but it has never been exercised, and it is not how `data.ctrlr.ts:112-131`
reads to someone expecting operator-side decryption. *Remediation:* decide explicitly whether the
renderer may decrypt without a live author signature; write the answer into the threat model; if the
answer is yes, the gate needs a second branch, and that branch needs a design, not a patch.

**D3 — Two kinds of author row.** The plugin names the Safe (`content.ctrlr.ts:177`), the CLI names
the EOA (`author.ts:135`). Consequences: `verifyAuthorship` can pass only for CLI items; a CLI row's
append and retract rights die with the key; `retract` from the other client reverts; a page's byline
shows an address that may be a Safe or a key with nothing marking which. *Remediation:* one rule —
the account is the author, always — and a migration note for existing EOA rows. This is a one-line
change in the CLI and a decision about old data.

**D4 — `verifyAuthorship` cannot pass for a Safe-authored item, and nobody calls it anyway.** It
compares a recovered ECDSA signer against the address in the `did:ethr` string
(`verify-content.ts:65`), which is the Safe for plugin items. *Remediation:* accept either the owner
signature or an EIP-1271 `isValidSignature` answer from the named account, then call it from the
render path — or delete it and stop claiming the property.

**D5 — Genesis resolution lives in frontmatter.** Correct in both hosts today
(`content.ctrlr.ts:148-151`, `author.ts:127`), and unrecoverable if the frontmatter is lost: the
contract cannot tell a revision from a new work, because a self-genesis offer is a valid new work.
This is what produced the duplicate rows in `handoff-safe-app-duplicate-deals.md`; the write path has
since been fixed, the historical rows have not been repaired, and nothing prevents the class of bug.
*Remediation:* `resolveLatest`/`getHistory` against the existing log, so a client can ask the chain
"is there already a work with this `plaintextHash`?" instead of trusting a file.

**D6 — Ending an agreement has no consequence.** No subscriber to `Retracted`, `remove[]` populated
only for slug changes, revoked check scoped to requested ids and failing open
(`render/main.ts:212-250`). *Remediation:* the plan in
`brain/handoffs/handoff-prep-ripples-from-revoke.md` — populate `remove[]` from revoked ids and
trigger the re-render from the withdrawal event.

**D7 — Rotation has no in-app path and no ownership history reader.** Only the Safe ABI is present;
`swapOwner` is a Safe{Wallet} operation. The ownership facts are on chain in the Safe's events and
nothing reads them, so no verifier can ask "who controlled this account when this version was
written". Threshold 1 with one owner means no recovery. *Remediation:* an owner-history projection
(the §6 fork in `handoff-owner-history-module.md`), a rotation command, and a second owner or a
guardian before anyone is told the account is safe to depend on.

**D8 — A new work cannot arrive as a pending offer.** `_append` reverts `OnlySafe` unless the caller
passes `canPublish` (`S2SPublicationModuleV2.sol:351-353`), so the "anyone → offer" branch in the
docstring and in `SPEC-contracts-publication.md` is dead for new content. The research note
recommends keeping the gate; the documentation should then stop describing open submission.
*Remediation:* decide, then make the docstring, the SPEC and the code say the same thing.

**D9 — No author-side list.** Guarantee 9. Greenfield: module install on the author's account, a
schema, a resolver, and who pays for the writes. `S2SRecordsModule` already has the right shape
(immutable, `onlySafe` writes, permissionless reads) and needs no new contract code.

**D10 — One operator, one key, one vendor.** Lit key generation is inside a single enclave with no
threshold; the renderer is run by one company; the Phala/dstack plan has no code. Multi-operator
rendering is the stated next step and is not started. *Remediation:* the TEE work, then a second
operator running the same action against the same chain state.

**D11 — Documentation drift, code wins.** Three instances found while checking claims: the render
path is client-driven, not chain-driven (`brain/threat-model/author.md`); Lit group id and PKP in
`brain/specs/SPEC-00-system-contract.md:83-84` (group 14, PKP `0xddc4…b414`) do not match the config
the deployment script reads (`protocol/scripts/lit/config.json`: group id 1, PKP
`0x0522b95938c3a18988bf71da2f964f8a52ae4004`), and the spec's path `scripts/lit/config.json` does not
exist; and `SPEC-hosts.md` AD-1 lists the neutralpress ETH actor as the "deployer EOA" when the
transaction is sent from the Safe through the bundler. Each is a one-line correction.

**D12 — The Neovim client is a spec, not code.** `brain/specs/SPEC-nvim-s2s.md` and
`handoff-nvim-plugin-wrapper.md` (2026-10-22) record a design for a thin wrapper over the `s2s`
binary; "nothing built yet" is the handoff's own status. It inherits the CLI's EOA identity and
therefore D3.

## 5. Inventory, read from the code

### 5.1 Contracts

| Contract | Chain | Role in authoring |
|---|---|---|
| `S2SPublicationModuleV2` | Base | the agreement record and version log; `makeOffer` (append + membership), `acceptOffer` (publication only), `retract`, `hasDeal`, `hasOffer`, `getLatest`, `getVersion`, `getVersionCount`, `authorOf`, `getDeals`, `getOffers` |
| `S2SPublicationModuleV2Factory` | Base | deploys modules per publication; called at publication creation, never by an author |
| `S2SRecordsModule` | Base | immutable `onlySafe` key-value store; holds protocol config and, if an author installs one, would hold the author's own list |
| Safe 1.4.1 (singleton `0x29fc…C762`, proxy factory `0x4e1D…ec67`) | Base | the author account |
| ENS + `ENSOpenSubdomainRegistry` + `ENSL2nRecords` | L1 | publication names and records; not touched by authoring |

`MAX_WHITELISTED_AUTHORS = 100`, `MAX_WHITELISTED_DEVS = 20`. Both are module upgradeable (UUPS);
whitelists live per publication and are read by `makeOffer` only — never by `acceptOffer` or
`retract`.

### 5.2 The author account

- Type: ERC-4337 Safe smart account; owners `[eoa]`, threshold 1; `SafeL2` v1.4.1; EntryPoint 0.7.
- Address: counterfactual from `keccak256("s2s_" + eoa)` as `saltNonce`, no chain id in the salt, so
  the address is identical on every chain (`0xobsidian/src/main.ctrlr.ts:151-159`).
- Deployed: on Base at first use (`deploySafe`, `permissionless.safe.service.ts:146`); L1 deployment
  is deferred to publication creation.
- Modules: none. No ENS node. No records store.
- Funding: gas is paid by a Pimlico paymaster in the plugin; the CLI signs as the EOA and pays its
  own gas.

### 5.3 What is signed, by whom, and where it is checked

| Artifact | Signed by | Covers | Checked by | Checked where |
|---|---|---|---|---|
| `S2SContentItem` (EIP-712, domain + `S2S_TYPES`) | the EOA | public metadata incl. `plaintextHash` (`tagsHash`/`attributesHash` as bytes32); not the ciphertext | nobody in production; `verifyAuthorship` exists and has no call sites | `shared/src/identity/verify-content.ts:33-80` |
| `"lit actions auth"` (personal message over a fixed string) | the EOA | nothing but the string | `extractSignerAddress` then `isOwner(authorSafe, …)` inside the Lit gate | `render/main.ts:104`, `gates.ts:14-40` |
| `makeOffer` / `retract` transaction | the EOA (user operation) or the EOA directly | `genesis`, `cid`, chain id, nonce | the chain, `msg.sender` | Base |
| Rendered page (JSON-LD `proof`, Data Integrity) | the PKP | the whole schema object incl. `schema.author.identifier` and `schema.encoding.sha256` | `verifyProvenance` | `protocol/actions/src/update/verify.ts:47-90` |

Two facts follow. The author's signature never appears in the page, so a reader who does not run
`verifyAuthorship` themselves is trusting the renderer's copy of the author's address. And the
`"lit actions auth"` string is a bearer token: it is not bound to a genesis, a publication or a time,
so a captured signature stays valid until the key leaves the account's owner set.

### 5.4 Encryption stack and access condition

- Client: `shared/src/lit/lit.service.ts` — `encrypt(key, pkpId, message)` and `decrypt(...)` post a
  compact action to `/lit_action` (prod base `api.chipotle.litprotocol.com/core/v1`).
- Action: `shared/src/lit/actions/encrypt.ts` — `Lit.Actions.Encrypt({ pkpId, message })`.
- Group: `s2s`, bound to one PKP, with permitted action CIDs `encrypt, prep, render, update,
  maintain-cache, repoint-archive` (`protocol/scripts/lit/config.json`). The group's `usage_key`
  authorises execution; `LIT_ACCOUNT_KEY` is the admin credential.
- Key custody: generated inside a Lit TEE enclave, never exported; no threshold scheme on this stack.
- Access condition: `canPublish(authorSafe) ∧ isOwner(signer) ∧ hasDeal(genesis)`, three chain reads
  at decrypt time (`libs/gates.ts`), evaluated inside the action.
- Live status: never invoked by an authoring client.

### 5.5 Storage

- Item bytes: the author's own Kubo node (`/api/v0/add`), then Filecoin through `filecoin-pin` with
  a CAR built from the same serialised bytes, then mirrors through `backupToProviders`. Serialisation
  is `JSON.stringify(item, null, 2)`; the indentation is load-bearing for CID parity.
- Record: the CID as a string in `Version.cid`; no payload on chain.
- Site: rendered HTML on IPFS, referenced from the publication's ENS records on L1.

### 5.6 The agreement record

`genesisAuthor[genesis]: address` (write-once), `versions[genesis]: Version[]` with
`Version{string cid; uint256 timestamp; bool tombstone}`, `latestIndex[genesis]`, and two set
structures `dealList/dealPos/dealAt/_isDeal` and `offerList/…/_isOffer`. Events: `Appended`,
`OfferMade`, `OfferAccepted`, `DealStruck`, `Retracted(genesis, by, keptAsOffer)`. `tombstone` is
written `false` and never set true — there is no delete, only withdrawal from a set.

### 5.7 Payment

Absent. No payable function, no split, no fee, no payout field, no payment in page metadata.

### 5.8 Clients and the shared interface

| Client | Authors by | Sends transactions as | State |
|---|---|---|---|
| `neutralpress` / `0xobsidian` (Obsidian plugin) | the Safe | the Safe, via 4337 user operation signed by the EOA | shipping |
| `author-cli` (`s2s`) | the EOA | the EOA directly | shipping |
| `safe-app` (browser, inside the Safe UI) | — | proposes transactions to the publication Safe | publication administration (init, whitelist, config); author flows are AD-3 design, not built |
| `nvim-s2s` | — | wraps the CLI binary | spec only |

The shared interface is data, not an API: `buildSignedContentItem` / `verifyAuthorship`, the
`S2SContentItem` type with its EIP-712 domain and types, `TxRunner` (`EoaRunner`, `SafeRunner`),
`S2SIPFSMethods`, and the protocol resolvers. Hosts write their own adapters
(`SPEC-hosts.md` AD-1, AD-2); nothing imports another host's internals.

### 5.9 Decision documents and what each rejected

| Document | Decision | Alternative rejected |
|---|---|---|
| `handoffs/handoff-owner-history-module.md` §2 | identity is the account; no DID document | `did:ethr` with a rotating controller and a registry |
| `specs/RFC-0xobsidian-identity-key-custody-1.md:62, 88` | (superseded) DID-named EOA then DID-named Safe | the proposal the handoff reverses |
| `specs/SPEC-hosts.md` AD-1/AD-2 | three hosts, one shared core of pure functions | a single host abstraction that reuses everything |
| `specs/SPEC-00-system-contract.md` INV-append, INV-10 | append-only version log; genesis author is the account that wrote first | a mutable pointer or a licence object |
| `specs/SPEC-contracts-publication.md` | V2 set membership replaces V1 licence lifecycle | `grantLicense` / `acceptLicense` / `revokeLicense` |
| `research/2026-09-10-deals-ledger-convergence.md` | whitelists stay per publication; keep the admission gate | a global author registry; open submission |
| `research/2026-09-10-author-owned-bylines-scoping.md` | author-owned records store on the author's account | hosted profile or DID document |
| `research/2026-09-10-portable-byline-convergence.md` | three independent proofs: item signature, page proof, chain row | one canonical byline service |
| `threat-model/author.md` | pseudonym, not anonym; name fields excluded | optional display name |
| `whitepaper/v2.md:36` | payment deferred with the disclosure gate | building payment before the gate |

## 6. Not verified

- Chain state. Nothing here was read from Base or L1; contract behaviour is read from source.
- Which Lit group is live. The deployment config says id 1 and PKP `0x0522…4004`; the SPEC says 14 and
  `0xddc4…b414`. The record the renderer actually reads is the on-chain `S2SRecordsModule` written by
  `protocol/scripts/lit/update-protocol.ts`, which I did not query.
- Whether the operator's renderer is invoked with an author-supplied signature in production. The
  code path requires one; whether the deployed runner supplies a fresh one per job is outside this
  repository.
- Whether any encrypted item has ever been published. Everything in the code says no; an on-chain
  scan for `encryption: true` items would settle it.
- Which of the historical duplicate-genesis rows remain on chain, and whether they were ever
  repaired. `handoff-safe-app-duplicate-deals.md` documents the symptom from 2026-07-22; the current
  write path fixes the cause.
