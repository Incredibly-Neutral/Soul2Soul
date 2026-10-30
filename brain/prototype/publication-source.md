# The publication in the s2s prototype

*Companion to §3 of the Polyphony white paper. This is a component text, not a design text: the object being described is the thing a reader can point at on Base today. Everything below was read out of the repository at `85e9671`, and where a document in `brain/` and the tree disagree, the tree is quoted and the disagreement is named.*

Ten words, used consistently from here on.

- **publication** — the account that owns an ENS subname and a set of admitted works. Its owners are **holders**. It is never called a press in this text.
- **press** — the Lit action plus the PKP that performs decryption, and the page-rendering action that runs beside it. Sealed code, open source: the action bundle is public, the key material is not.
- **renderer** — the build function half of the press: template → HTML → tree.
- **agreement** — a work the publication has admitted. On-chain it is a *deal*.
- **pending offer** — a work proposed to the publication and not yet admitted. On-chain it is an *offer*.
- **manuscript** — the author's stored object: a signed public envelope plus a body.
- **page** — one rendered HTML document at one path in the tree.
- **colophon** — the provenance block the renderer writes into each page.
- **trust** — the grant or foundation that funds the publication, in the legal sense; when the word appears next to a mechanism it means a party the mechanism makes assumptions about, and the clause says what those assumptions are.
- **admit / decline** — accept an offer / refuse it. Both are Safe transactions.

Nothing in this text restates the white paper's argument. The claim being made here is narrower: *this is what the code does when you press the buttons.*

Two things are worth saying once about maturity. The paths described below are the paths the shipped hosts call; encryption is implemented on both sides and switched off in practice, and the Filecoin leg is wired but silent when no storage session is configured. Everything else that is designed and not built sits in **Roadmap** at the end, next to what it would unlock.

## Where this text follows the code over the outline

The 29 October outline (one index card per section) was written before the current contract pair; four of its sentences are wrong in ways that matter, and one is wrong in a way that flatters the system. They are listed here once so the sections can be read without hedging.

| The outline says | The tree says |
|---|---|
| The author is a Safe multisig with two modules. | The author's Safe carries no purpose-built modules at all. `S2SRecordsModule` and `S2SPublicationModuleV2` are enabled on the **publication** Safe (the author doc in this directory already says so; the outline did not get updated). The only module type an author Safe has is the ERC-4337 module its host installs. |
| Reviewers read a pending offer. | There is no reviewer role, on-chain or in the app. A pending offer is readable only because its body is uploaded **in the clear** and fetched from a public gateway. The decryption gate (`canRead`) requires `hasDeal`, so if the item were encrypted nobody — holder included — could read it through the press. See §3. |
| Whitelists for authors, reviewers and developers. | Two lists exist: authors (max 100) and developers (max 20). A reviewer is a holder or a developer; nothing names the role. See §4. |
| The publication updates its own site root. | The publication never writes its own root. The root is written by the protocol's PKP, which is an authorized caller on one protocol-wide ENS records contract. The publication Safe has no write path to it. See §7. |
| Five-fold redundancy, with manuscripts. | Up to five copies exist, and only on the author-side publish path: the Kubo pin, a Filebase pin, a Pinata pin, and two Filecoin copies from a retrying uplink. A render from the admin app is mirrored nowhere. See §8. |

Two smaller ones, corrected where they occur: custom post types are a free string, not a registry (§5), and the starter's mapping contains a `filters` key at template level that no code reads (§5).

---

## 1. The account

### 1.1 Two ways a publication comes into existence

There are two, and they produce the same object by different routes.

**The CLI/plugin route** (`shared/src/publication/new.ts`, `newPublicationSafe`) builds a publication from a name and an owner list. It deploys a Safe with a salt derived from the publication's name — `'publication_safe_' + publication.name` — through `connectToFreshSafe(salt)`, once on L1 and once on L2. Same salt, same factory, same address: `publicationAddress1 === publicationAddress2`. From that moment the publication is one account that lives on two chains, which is what lets it own an ENS name on Ethereum and hold modules on Base without a bridge.

Then, in order:

1. `registerSubdomain` on L1, through the ENS registry or the NameWrapper depending on whether the parent is wrapped, with the twin Safe as the new owner. This is deliberately its own step. A Safe transaction is single-chain; the ENS registry has no code on Base; so the subname registration cannot be batched with anything that happens on Base. `isParentWrapped` also decides *which* of the two registration paths is authoritative — `ens.setSubnodeOwner` on the registry or `NameWrapper.setSubnodeOwner` — and the owner read afterwards has to follow the same branch. Read the wrong one and a successful registration reports back as a name the publication does not control, which is a desync that looks like a permissions bug.
2. `createModule` on the records factory, on L2 — a plain `CREATE` of `S2SRecordsModule(safe)`.
3. `createModule(safe, authors, [])` on the publication factory, on L2 — a plain `CREATE` of an `ERC1967Proxy` pointing at `latestImplementation`, initialised with the Safe address, the author list and an empty developer list.
4. `verifyModulesEnabled` — poll `isModuleEnabled` up to 20 times at 5 s.
5. `setRecordsWithRetry` — one `setRecords` call writing all five keys at once (`name`, `config`, `repo`, `branch`, `feed`), retried three times three seconds apart. `config` may legitimately be empty here; the config is usually built later from the admin app (§6).
6. For each additional owner: `addOwnerWithThreshold(owner, 1)`, batched on **both** chains, then `verifyOwnersAdded` on both.
7. `removeInitialSigner` — `removeOwner(prevOwner, initialSigner, owners.length)` on both chains, with `prevOwner` computed from the owner array and three retries.

Step 7 is the one that fixes the shape of the account: the threshold is set to the remaining owner count, so a publication created this way ends up **N-of-N**. Every later decision needs every holder. A five-holder publication whose fifth holder loses a phone cannot admit anything, cannot render, cannot change its config. The admin app has no owner-management screen at all — it reads `owners` and `threshold` from `safe.getInfo()` and never proposes `addOwner`, `removeOwner` or `changeThreshold` — so widening a stuck publication means leaving the app for Safe{Wallet}'s own settings, and the account is N-of-N until someone does.

**The admin-app route** (`safe-app/src/lib/publication-init.ts`) takes a Safe you already have and makes it a publication. Two proposals, and the reason there are two rather than one is worth stating, because it is the difference between "predict the address" and "read the address":

- **Batch 1**, on Base: `[recordsFactory.createModule(safe), publicationFactory.createModule(safe, authors, [])]`. Both factories deploy with plain `CREATE`, so the module addresses are the hash of the factory's nonce — unknowable in advance without a nonce race. The app therefore **proposes the creations and then reads the addresses back out of the `ModuleCreated` logs**, taking the *last* matching log per factory (the factories are non-idempotent; on a re-init the previous run's log is still inside the 10 000-block lookback, and the newest one is the module you just made). Both events index `safe` in topic 1 and the module in topic 2, which is how the log is matched to this Safe.
- **Batch 2 (merged)**, on Base: `[enableModule(records), enableModule(publication), setRecord("name", name), setRecord("repo", repo)?, setRecord("branch", branch)?]`. Merging enable with the name record is not cosmetic: `setRecord` is `onlySafe` on the records module and does not require the module to be *enabled*, so the whole finalisation is one MultiSend, and the state "modules enabled, name never recorded" — the reload-into-a-half-initialised-publication dead end of the earlier three-proposal flow — is not reachable. `enableModule` is idempotent, so re-proposing the batch during recovery is harmless.
There is no third proposal: an earlier three-step flow that proposed the name record separately was merged into batch 2, because the intermediate state — modules enabled, name never proposed — is a dead end that looks like a fresh publication on reload.

`Safe.enableModule` is `onlySelf` and does not check that the target has code. That is the whole reason for the log walk: the Safe will happily enable `0x0`, and the app's only defence is that it found a real `ModuleCreated`.

The two batches are two Safe executions total. Init is `async` on the human: after batch 2 the app polls `isModuleEnabled` every 2 s for up to **10 minutes** waiting for somebody to execute the queue entry, and if that expires the flow reports failure while the proposal is still sitting in the queue, executable later.

### 1.2 The two modules

Both are found by asking `NAME()` of every module the Safe lists. That is the discovery protocol: a module that does not answer `NAME()` is skipped, and the two strings are constants on the contracts.

| | `S2SRecordsModule` | `S2SPublicationModuleV2` |
|---|---|---|
| `NAME()` | `"S2S Records Module"` | `"S2S Publication Module V2"` |
| `VERSION()` | `"1.1.0"` | — |
| Shape | `mapping(string => string) records`, `string[] recordKeys`, `mapping(string => uint256) keyIndex`, `mapping(string => bool) keyExists`; `address public immutable safe` | `address public safe` (storage, not immutable); one append-only version log per genesis; enumerable deal and offer sets |
| Upgradeable | No. The contract has no proxy, no implementation slot, no initialiser. | Yes. `Initializable` + `UUPSUpgradeable`, behind an `ERC1967Proxy`. |
| Writes, and who may call | `setRecord`, `setRecords`, `deleteRecord` — all `onlySafe`, i.e. `msg.sender == safe`. Nobody else, ever. | `makeOffer(genesis, cid)` — anyone the module lets through, see §4. `acceptOffer(genesis)` — `onlySafe`. `retract(genesis)` — the genesis author (full withdrawal) or the Safe (demote or reject); anybody else reverts `NotAuthorized()`. Whitelist add/remove — `onlySafe`. `upgradeToAndCall` — `onlySafe`. |
| Reads | `getRecord`, `getRecords`, `recordExists`, `getAllKeys`, `getAllRecords`, `getRecordCount`, `getKeyAtIndex`, `supportsInterface` | `hasDeal`, `hasOffer`, `authorOf`, `canPublish`, `getDeals(offset,limit)`, `getOffers(offset,limit)`, `getWhitelistedAuthors`, `getWhitelistedDevs`, `NAME` |
| Limits | None on key or value length; `EmptyKey` on `""`; `KeyNotFound` on deleting a key that was never written; `ArrayLengthMismatch` on unequal batch arrays | `MAX_WHITELISTED_AUTHORS = 100`, `MAX_WHITELISTED_DEVS = 20`; `ZeroHash`, `EmptyCid`, `OnlySafe` |

The asymmetry between the two is a fact about the design, not an accident of implementation: the records module is immutable because it holds strings and a mutable one would be a backdoor into the publication's identity; the publication module is upgradeable because the agreement format is still moving. §1.5 says what that costs.

The records module holds one string-to-string map per publication. The keys actually written by the shipped hosts are `name` (the ENS label, canonical), `repo` (GitHub URL), `branch`, `config` (the CID of the publication's config DAG), and `feed`. `feed` is legacy: `s2s-records-tab` hides it from the editor (`HIDDEN_RECORD_KEYS = new Set(['feed'])`) but still reads it, and the config builder no longer consumes it. Keys are not namespaced and not schema-checked, so a publication can write `foo` and nothing will complain; the app's editor is the only thing that keeps the set tidy.

### 1.3 The version log, because everything else is a pointer into it

`S2SPublicationModuleV2` stores one log per genesis:

```solidity
struct Version { string cid; uint256 timestamp; bool tombstone; }
mapping(bytes32 => Version[]) private versions;
mapping(bytes32 => uint256)  private latestIndex;   // 1-based; 0 = no versions
mapping(bytes32 => address)  private genesisAuthor;
```

`makeOffer(bytes32 genesis, string cid)` is the single author-side write and does three things in order: append a version to the log, decide whether this author is entitled to an immediate deal, and update the deal/offer sets accordingly.

The entitlement test is the line that defines the whole role model:

```solidity
bool entitled = msg.sender == safe || _inArray(whitelisted_authors, msg.sender);
```

— `msg.sender == safe` or *author* list membership. Note what is absent: `canPublish()`, which is the union of the Safe, the authors and the developers. A developer therefore passes `_append`'s permission check and lands in the *offer* branch. That is §4's subject.

`_append` reverts with `ZeroHash()` on a zero genesis, `EmptyCid()` on an empty string, and `OnlySafe()` when the genesis is new and `canPublish(msg.sender)` is false, or when the genesis is old and the sender is neither the Safe nor `authorOf(genesis)`. So: a developer can *edit* an existing work if they are also its genesis author, and can publish new ones only as offers.

The deal and offer sets are enumerable, swap-pop:

```solidity
mapping(bytes32 => bool)    private _isDeal;
mapping(bytes32 => uint256) private dealPos;   // index + 1
bytes32[] private dealList;
```

with the same triple for offers, and `getDeals(offset, limit)` / `getOffers(offset, limit)` returning `Entry[]` — `{ genesis, cid, author, timestamp }` — read from the log at `latestIndex[genesis]`. `hasDeal(genesis)` and `hasOffer(genesis)` read the bools, not the list, so a set-membership answer is one slot read. `authorOf(genesis)` is `genesisAuthor[genesis]`, set on the first append and never moved.

That structure has a consequence the renderer leans on: the deal set has **no ordering guarantee**. Swap-pop means the last entry replaces the removed one, so `getDeals` order changes whenever something is declined. Pages are ordered by `position`, not by deal order, which is why nobody notices.

`tombstone` is in the struct and is written `false` on every append; no function in the contract ever sets it to `true`. Three readers in `shared/src/cid-view` and the action's ABI binding carry it anyway. It is a field waiting for a feature (Roadmap item 10).

### 1.4 A decision is a Safe transaction

Nothing about admitting a work is special at the transaction level. `acceptOffer(genesis)` is a normal call on a normal contract, and it can only be made by the module's `safe`. Admission is one-sided; withdrawal is not:

```solidity
function acceptOffer(bytes32 genesis) external onlySafe { ... }

function retract(bytes32 genesis) external {
    if (msg.sender == genesisAuthor[genesis]) { … }   // full withdrawal: deal and/or offer removed
    else if (msg.sender == safe)             { … }   // demote deal → offer, or reject an offer
    else revert NotAuthorized();
}
```

So a publication can *decline* an offer and can *demote* a deal, but it cannot delete a work from the log: only the genesis author's own withdrawal does that, and even that leaves the version log intact.

So the mechanics are Safe mechanics. The admin app encodes the call and hands it to `txs.send`:

```
to:    <publication module address>       // from the contract wrapper's `target`, never from safeInfo
value: "0"
data:  acceptOffer(0x<genesis>)
```

The SDK queues a Safe transaction and returns immediately with a queue URL the console prints: `https://app.safe.global/transactions/queue?safe=<chainId>:<safeAddress>`. The app then shows "Transaction pending approval" and does nothing else — it does not poll the queue, and a decision made in another tab is invisible until the page reloads.

The holders sign the Safe transaction hash in Safe{Wallet} with their own keys. When the threshold is reached, whoever executes pays the gas. The publication's own account never holds a key and never signs anything.

For a publication at N-of-N, this means every admit, every decline, every whitelist change, every config update and every upgrade is a full-house signature. The prototype is honest about this: it optimises for "the publication is a real multisig" and not for "a publication can act quickly".

### 1.5 Upgradeability, and who can point the factory somewhere else

`S2SPublicationModuleV2` is a UUPS implementation behind a per-publication `ERC1967Proxy`. The upgrade path is:

```solidity
function _authorizeUpgrade(address) internal view override {
    if (msg.sender != safe) revert OnlySafe();
}
```

— i.e. only the publication's own Safe can upgrade its module, and that is a Safe transaction like any other, at N-of-N. That is the good half of the story.

The bad half is the factory:

```solidity
function createModule(address safe, address[] calldata _authors, address[] calldata _devs) external returns (address) { ... }
function setImplementation(address _implementation) external { ... }
```

Neither has an access modifier. Any address can deploy a module for any Safe (harmless — the Safe must still `enableModule` it, and the module's `safe` is whatever the caller passed), and **any address can replace `latestImplementation`**. That only affects *future* publications; existing proxies hold their implementation slot and only their Safe can move it.

So the upgradeability surface is: per publication, the holders; across the protocol, nobody. A publication created tomorrow morning trusts that whoever called `setImplementation` last did so in good faith, because its proxy will be initialised against that implementation and the app discovers modules by `NAME()` alone — a hostile implementation can answer `"S2S Publication Module V2"` and be adopted. Removing upgradeability is the first item in **Roadmap** for exactly this reason: it turns "trust the factory operator and every future implementation" into "trust the bytecode you can read".

One more edge in the same area: the app never checks `module.safe() == this Safe`. A module bound to a different Safe is adopted as this publication's module because `NAME()` matches, and then every write reverts `OnlySafe`. Not exploitable — a broken wiring, not a stolen key — but it means "the app shows a module" is not evidence that the module belongs to the account.

### 1.6 Tearing down

`buildDeletePublicationBatch` is the inverse of init, and it is a demonstration of what is and is not an account here:

```
[disableModule(prev, laterModule), disableModule(prev, earlierModule), deleteRecord("name")]
```

in **descending** list order, because `disableModule(prevModule, module)` needs the previous module in the Safe's linked list and disabling the earlier one first would orphan the later one's `prev`. `prev` is read from the module list the app fetched, with `0x000…001` as the sentinel for the first entry. `deleteRecord("name")` is appended only when a records module is known and the caller has not suppressed it — the records module reverts `KeyNotFound` if the key was never written, and an atomic MultiSend that reverts on estimate is a batch the Safe UI refuses (GS013).

What teardown does **not** do: destroy a contract, free a name, or move a byte of content. The module deployments stay on-chain, orphaned; the ENS subname stays owned by the Safe; the site root stays pinned. It is "this Safe is no longer a publication", not "this publication is gone". Re-initialising deploys fresh modules, because both factories are non-idempotent — which is also why re-init after a reset works at all.

---

## 2. The admin app inside the Safe

### 2.1 What it is

`safe-app/` is a static bundle of vanilla Web Components, each a `LitElement` with a shadow root and adopted stylesheets, opened as a Safe App from `app.safe.global` for the publication's Safe. It has three dependencies that matter:

- `@safe-global/safe-apps-sdk` and `safe-apps-provider`, constructed with `allowedDomains: [/app\.safe\.global$/]`. That regex is a *framing* restriction — the app refuses to initialise when it is not embedded by the Safe UI — not an authentication mechanism. It holds no key.
- ethers v6, picked up off `window.ethers`, for every read.
- the shared `@s2s/soul2soul-shared` protocol surface, for module ABIs, `toBytes32Id`, the renderer entry point and the CID views.

The app's only write primitive is `txs.send`. Every button in it either (a) encodes a call and proposes it to the Safe queue, or (b) signs an off-chain message for the press. There is no third thing.

The whole UI is gated on one boolean, `initFlowRunning`, which is true from the moment the app starts an init until the modules it created are actually enabled — including the ten-minute wait for a human to execute the proposal. While it is true the tabs do not render and the init flow (§1.1) owns the screen. The test for "is this a publication" is looser: `hasModules = hasPublicationModule() || hasRecordsModule()`, because an interrupted init leaves one module enabled and the app should still be able to finish the job.

### 2.2 The tabs

| Tab | Component | Reads | Writes |
|---|---|---|---|
| Agreements and offers | `s2s-deals-tab` | `getDeals`/`getOffers` (paged, via `getAllDealsAndOffers`), then one gateway fetch per item by CID | `acceptOffer`, `retract`; `render` invocation |
| Authors and developers | `s2s-whitelist-tab` | `getWhitelistedAuthors`, `getWhitelistedDevs` | `whitelistAuthor`/`removeWhitelistedAuthor`, `whitelistDev`/`removeWhitelistedDev` |
| Config | `s2s-records-tab` | every record except `feed` | `setRecord`, `deleteRecord`; drives the config build |
| Storage | `s2s-storage-tab` | CID inventory, retrievability probes | `heal` |
| Website tree | `s2s-website-tree-tab` | the ENS root, then the IPFS DAG | `render` with `reset: true` (no Safe tx) |

Plus the init flow, which is not a tab.

### 2.3 Agreements and offers

Two tables. The columns are fixed in the component:

```
offers: ID / Title, Author (safe), Post type, Created, Tags, Status
deals:  ID / Title, Author (safe), Post type, Creation Date, Modified Date, Tags
```

with chip filters for author (rendered as a pet-name) and post type, per-column sort, and one row action each: **Accept** and **Refuse** on an offer, **Revoke** on a deal. A "Sync" button re-reads the module, a `s2s-check` field takes a genesis id and asks `hasDeal`, and a **Bulk Render** button with a *preview* toggle does §7.

Loading is two-phase. Phase one is the module: `getDeals(0, n)` and `getOffers(0, n)` give `{ genesis, cid, author, timestamp }` — the on-chain truth, nothing more. Phase two is per item, and it is a plain gateway read against a **hardcoded** host:

```js
const content = await fetchFromIPFS('https://ipfs.transport-union.dev', l.cid);
l.title = l.encryption ? '-' : JSON.parse(content.body).title;
l.author = content.public.author;
l.postType = content.public.postType;
l.tags = content.public.tags;
```

Each row is wrapped in its own `try/catch`, so a gateway hiccup leaves a row present but blank rather than failing the table. The table you see is therefore *the module's set joined to whatever the gateway served*, and every `title` in it is unsigned body content parsed without checking the item's `proof`, which travels in the same fetched JSON and is never examined here.

The two row actions are asymmetric on purpose, and the asymmetry is the contract's:

- **Accept** → `acceptOffer(genesis)` → `onlySafe` → the offer leaves the offer set, enters the deal set, `DealStruck` is emitted.
- **Refuse** (on an offer) → `retract(genesis)` → the genesis leaves the offer set; the version log keeps the version; the CID stays where it is. This is the one place the Safe reaches into the offer set without `acceptOffer`, and it is the publication's only "no".
- **Revoke** (on a deal) → `retract(genesis)` → because the caller is the Safe, the deal is *demoted*: removed from the deal set, added back to the offer set. `hasDeal` flips false. Nothing is deleted.

That last one has a consequence that belongs in this section rather than in a footnote. Revoking a deal from the admin app changes the chain and stops there. The site is a tree of previously rendered pages; no code removes a path unless a render is told to. The renderer can only derive a removal from a job it was handed — the author-side revoke in `neutralpress` does this by re-rendering the retracted id so the action marks the job `revoked` and the orchestrator turns it into a `files/rm` (§7). The admin app's Revoke proposes no render at all, and the next Bulk Render will not even mention the id, because the app's own `store.deals` no longer contains it after a Sync. So: **a page stays live until someone renders its id under a state that says remove it**. Today the only host that does that is the author's. This is a gap, and it is on the Roadmap.

### 2.4 What a holder signs

Two different things, which are easy to conflate:

1. **A Safe transaction.** For Accept, Refuse, Revoke, whitelist changes, record writes, module enable/disable, upgrades. The app encodes it, `txs.send` queues it, and each holder confirms the Safe transaction hash in Safe{Wallet} with their own wallet. Threshold reached → executor pays gas.
2. **An off-chain message, the literal string `lit actions auth`.** Sent for every render (`signWithSigner('lit actions auth')`), signed with `signer.signMessage` through the Safe Apps provider, and shipped to the press as a signature. The action recovers the signer with `extractSignerAddress(ethers.utils.hashMessage('lit actions auth'), signature)` and then requires that address to be a Safe owner (§3). This signature authorises nothing on-chain and costs nothing; it is the press's proof that a holder asked for the build.

A render is therefore *not* a Safe transaction, and the two authorities are checked in different places: the Safe's threshold for state changes, one owner's signature for computation.

### 2.5 Config edits

`s2s-records-tab` is a key/value editor over the records module with one key hidden (`feed`) and one key that is not a string at all: `config`. Writing `config` is not a text field — it runs the config build (§6), which is a multi-step GitHub read, an IPFS upload, then a single `setRecord('config', <cid>)` proposal.

Aliases get their own flow: the tab reads the current config DAG, appends the new domain to `config.aliases`, and re-uploads. Optionally — and **off by default** — it checks that the new domain's ENS resolution points back at the same publication before allowing the add (`DOMAIN_VALIDATION_CONFIG.enforceOwnership`), which is the only place in the app where a name is verified against a Safe.

### 2.6 Reset

A separate control proposes `buildDeletePublicationBatch` (§1.6): disable both modules, delete the `name` record. It is a Safe transaction, so it needs the full threshold. It does not unpin, unrender, or unregister the ENS subname. After it, `hasModules` is false and the app offers init again.

---

## 3. Review

### 3.1 What reviewing a pending offer is today

There is no review screen, no reviewer role and no review record. A pending offer appears in the offers table, and the material behind it is fetched by CID from the public gateway in the same loop that fills in the table (§2.3). For an unencrypted item that is the whole of it:

| You see | Where it comes from |
|---|---|
| title | `JSON.parse(body).title` — unsigned body, public gateway |
| author | `public.author` — a `did:ethr` string, signed |
| post type, tags, locale, position, createdAt | `public.*` — signed |
| the manuscript itself | `JSON.parse(body).content`, media type from `public.mediaType` |
| "pending" | the module's `_isOffer[genesis]`, via the offer set |

Three properties of that table are worth separating, because they read as one thing and are three:

- **Nothing is decrypted.** The press is not involved in review at all. No Lit action runs, no PKP is used, no gate is consulted. If the body is encrypted, the table shows `-` for the title and the row is unreadable — the app's code path for `encryption === true` is `l.title = '-'`, full stop.
- **Nothing is verified.** `public.proof` travels into the row and is not checked. The signature over the envelope is verified by the renderer's integrity pass (§7), not by the admin app, so a forged `public.author` in an *offer* is invisible to whoever is reviewing it.
- **Nothing is recorded.** Admit or refuse are the only signals that leave the app. No "reviewed by", no timestamp, no note. A holder who reads an offer and says nothing leaves no trace, and the author has no channel to receive "we read it and we're thinking" or "we read it and passed".

### 3.2 Why the gate makes an encrypted offer unreadable by everyone

This is the sharp edge, and it should be stated in the plainest possible terms because a reviewer of the grant will ask.

`canRead` — the function the decrypt action calls before it asks the PKP for anything — is a conjunction of three on-chain reads:

```ts
const [cp, isOwner, isDeal] = await Promise.all([
  evmRead("L2", publicationModule, [...], "canPublish", [safeAddress], rpcs),
  evmRead("L2", safeAddress,        [...], "isOwner",    [signerAddress], rpcs),
  evmRead("L2", publicationModule, [...], "hasDeal",    [genesis], rpcs),
]);
return cp && isOwner && isDeal;
```

The third term is `hasDeal`. A pending offer is by definition *not* a deal. So for an encrypted item:

- the author can read it (they hold the plaintext);
- the holders cannot, through the press;
- a developer cannot;
- nobody can.

And nothing in the action set ever calls `hasOffer` — the predicate exists on the contract and is read by the admin app to draw a table, and by nothing in the rendering path. There is no second gate, no "review mode", no partial reveal.

The prototype's answer to this is the one it actually ships: **offers are published in the clear.** `encryption: true` is implemented end to end on both sides — the author doc's `BUILT, UNEXERCISED` — and turned off in practice precisely because turning it on would break review. The plaintext offer is therefore *available* rather than *authorised*: readable by anyone who knows the CID, which includes anyone who watched the `OfferMade` event.

Stated as a trust clause: **review today is a decision to look, not a right to look.** The publication's confidentiality in the pre-decision window is zero, and the mechanism that would create it (a reviewer gate that admits `hasOffer`) does not exist. It is Roadmap item 3.

### 3.3 Decline

`retract(genesis)` from an offer, signed by the Safe:

- removes the genesis from the offer set (`_isOffer` false, swap-pop out of `offerList`, `OfferRetracted`);
- leaves the version log untouched — `versions[genesis]` still holds the CID, `latestIndex` still points at it, `genesisAuthor` still holds the author;
- leaves the bytes where they are. Nothing in the decline path unpins, and the author's host pinned them for its own reasons.

So a declined offer is indistinguishable on-chain from an offer that was never made, except that the log has a version and the author is known. The author is not told. There is no notification channel anywhere in the system — no event the author's host subscribes to, no inbox, no relay. Their next `makeOffer` on the same genesis creates a fresh offer entry and re-emits `OfferMade` with a later timestamp; nothing remembers that this is the second time.

Two consequences that a publication should know before it starts declining:

- Declining is not retracting a publication. If the work was ever a deal and the page was rendered, the page is still in the tree (§2.3) until a render removes it, and a declined *offer* never had a page to begin with.
- Declining is not confidential. The CID was public when the offer was made and stays public afterwards; a decline hides the publication's interest, not the text.

### 3.4 What review would need

Not a redesign, three additions: a reviewer set on the module (or a `hasOffer`-admitting branch of `canRead` for addresses the Safe names), a way to render or preview an offer *without* admitting it (the renderer's job list is derived from `getDeals`, so an offer has no path through it), and one durable record of the decision so that "declined" is a state rather than an absence. All three are in **Roadmap**; none of them is started.

---

## 4. The lists

### 4.1 Two lists, not three

```solidity
uint256 public constant MAX_WHITELISTED_AUTHORS = 100;
uint256 public constant MAX_WHITELISTED_DEVS    = 20;

address[] private whitelisted_authors;
address[] private whitelisted_devs;
```

Nothing else. There is no reviewer list, no editor list, no "contributor" list. A reviewer is either a **holder** (an owner of the publication Safe, which passes `hasDeal`-side checks by virtue of `isOwner`) or a **developer** (who can decrypt everything but cannot admit anything) — and in the pre-decision window, as §3 says, neither can read an encrypted offer.

Both lists are plain arrays with swap-pop removal, so the order is not stable and `getWhitelistedAuthors()` is not sorted. The app sorts nothing either; the whitelist tab renders the array as returned.

### 4.2 The functions

| Call | Who | Effect |
|---|---|---|
| `whitelistAuthor(address)` | Safe only | push if absent, emit `AuthorWhitelisted`. Reverts `InvalidAuthorAddress` on `address(0)`, `MaxAuthorsReached` at 100. Note the cap is checked *before* the duplicate check, so re-adding an existing author when the list is full reverts. |
| `removeWhitelistedAuthor(address)` | Safe only | swap-pop, emit `AuthorRemovedFromWhitelist`. **Silent** if the address is not in the list — no revert, no event. |
| `whitelistDev(address)` | Safe only | same shape, cap 20, `DevWhitelisted`. |
| `removeWhitelistedDev(address)` | Safe only | same shape, `DevRemovedFromWhitelist`, silent if absent. |
| `isWhitelistedAuthor`, `isWhitelistedDev` | anyone | boolean, one array scan |
| `getWhitelistedAuthors`, `getWhitelistedDevs` | anyone | the array |
| `canPublish(address)` | anyone | `addr == safe \|\| in devs \|\| in authors` — two scans, the hot path |

`canPublish` is the most important read in the system, because it is the first term of the decryption gate (§3.2) and the admission rule for a new genesis (§1.3). Everything else about the lists is bookkeeping.

### 4.3 What each role may do

**Author.** `makeOffer` on a new genesis lands as a **deal** immediately — the author is their own admission authority within the publication. They can append again to the same genesis at any time (an edit), and the deal survives the edit.

Reading through the press is where the role gets less flattering than it sounds. `canRead` asks for two different things about two different addresses: `canPublish(authorSafe)` — *this Safe is entitled to publish here* — and `isOwner(signer)` — *this human is a holder of the publication*. An author who is not also a holder therefore cannot decrypt their own admitted work through the press; they need a holder to run the render, and the holder's signature is what the gate actually verifies. In the common deployment the author is a holder, so the two collapse and nobody notices. Where they diverge, the press is a publication-level service, and the author is a client of it.

**Developer.** `canPublish` is true, so a developer's signature is accepted by `_append` and by `canRead` — they can decrypt everything the publication has ever admitted. But `makeOffer`'s entitlement test reads `whitelisted_authors`, not `canPublish`, so their new work becomes a **pending offer** and needs a holder to accept it. A developer is, exactly, *an author who cannot admit themselves*. The role exists so that the people who build and operate the publication's site can render and debug it without being able to put a page live.

The subtlety: a developer who *is* the genesis author of an existing work can keep editing it (§1.3's second branch of `_append`), and those edits are appended to a deal, which means they are live. So "developer" gates the first admission, not subsequent ones. Concretely, a developer who submits one piece and has it admitted has full publishing rights over that piece from then on.

**Holder.** Everything, through the Safe: admit, decline, revoke, whitelist, records, upgrade, reset. Holders are not in `canPublish` *as holders*; the Safe address is, and the Safe can call `makeOffer` directly, which lands as a deal. So a publication can publish under its own name without any author being involved — the Safe is a first-class author of its own account.

**Reviewer.** Not a role. See §3.

### 4.4 Removing someone, and what it does not remove

`removeWhitelistedAuthor` is a removal of permission, not of history:

- Works already admitted stay admitted. The deal set is not touched.
- The removed author can still append to genoses they authored, because `_append`'s edit branch checks `authorOf(genesis) == msg.sender`, not the whitelist.
- They can no longer start a new genesis: `canPublish` is false for them, so a new genesis reverts `OnlySafe`.
- They lose decryption, because `canRead`'s first term is `canPublish(authorSafe)`. A de-listed author cannot read the publication's other works through the press — even though they can still edit their own, which they can read because they have the plaintext.

That last line is the honest shape of the revocation: it withdraws the *service*, not the *access* to what they already had. Nothing in the prototype rotates a key on removal, and there is nothing to rotate — each item is encrypted to the press, not to a reader set. Removing an author is therefore a statement about future work, and a reviewer should read it that way.

### 4.5 The cap as a design statement

100 authors, 20 developers, both enforced by a revert and both scanned linearly on every gate check. Neither number is architectural — they are a gas-bounded guess. What they imply is that a publication is a bounded institution, not a platform: at 100 authors every gate read costs a hundred comparisons on the hot path, and the per-publication module design means a thousand-author publication would need a different contract, not a bigger constant.

Trust clause: **the author list is the read set.** Adding an author hands that address the plaintext of everything the publication has ever admitted, because the gate is a list membership and not a per-item grant. Removing them does not take it back.

---

## 5. The look

### 5.1 All of it is a GitHub repository

A publication's appearance is a repo with a fixed layout, and the press never edits it:

```
mapping.json            # postType → template, collections, ripples
templates/              # *.handlebars, plus templates/partials/*
assets/                 # css/js/etc., copied to /assets in the tree
scss/                   # source for assets/css/main.css, ignored by the press
fixtures/               # local render samples, ignored by the press
scripts/render-dev.ts   # local render without the chain
```

`website-starter` is the reference repo (a separate repository at `dde6b0f`, 29 Oct 2026). Its `mapping.json` in full:

```json
{
  "templateConfig": [
    {
      "reference": "home",
      "file": "home.handlebars",
      "path": "/",
      "collections": [
        { "slug": "chapters", "filters": [{ "postType": "chapter" }], "sortBy": "position" }
      ]
    },
    {
      "reference": "chapter",
      "file": "chapter.handlebars",
      "path": "/{slug}/",
      "collections": [
        { "slug": "chapters", "filters": [{ "postType": "chapter" }], "sortBy": "position" }
      ]
    }
  ],
  "ripples": []
}
```

Three things in that file are load-bearing and one is dead.

**`reference` is the mapping key.** It is matched against `body.postType` by exact string equality — `getTaskConfig` filters `config.mapping.templateConfig` for `m.reference === body.postType`. There is no registry, no schema, no validation that a post type has a template. A `postType` with no matching reference produces no page at all, silently: `prep` pushes a job only `if (templateConfig && templateConfig.file != null)`, so the item stays a valid deal, and it still appears in collections (which do not consult templates). A ripple whose destination references a missing `reference` throws instead, because `prep` has to resolve the destination's config to build a page for it. That is the asymmetry: an orphan *item* is invisible, an orphan *ripple* is fatal.

So "custom post types" means what it says and no more: a string in `public.postType`, chosen by the author, matched against a JSON key in a repo the publication controls. Adding a post type is editing a repo, not registering anything.

**`path` is the URL, with one substitution.** `createPath(body, templateConfig, localePaths)`:

```
path == null                    → "/"
prefix  = localePaths[body.locale] ?? localePaths.default ?? ""
result  = prefix + path, with "{slug}" replaced by body.slug
```

and `{slug}` is replaced **only when the item is not encrypted** (`!body.encryption`) — an encrypted item's slug is not available to the renderer's path builder, so a collection path template on an encrypted item renders literally. `localePaths` is optional in the config; the starter does not set it.

**`collections` are computed at render time from the deal set plus the archive.** A collection has a `slug`, optional `filters`, optional `sortBy`. Filters are exact matches, with array membership allowed on the item side (`Array.isArray(itemVal) ? itemVal.includes(value) : itemVal === value`), ANDed across predicates and across keys. `sortBy` is one of `position` (numeric), `creationDate`, `modifiedDate`, `title`, or absent — anything else falls through to title-alphabetical, and missing or unparseable values sort **last**. The starter's collection is `chapters`, filtered to `postType: chapter`, sorted by `position`. Because both templates declare the same collection, the home page and every chapter page see the same list; a nav partial iterates it.

**`ripples` are the dead-or-alive hinge of the whole look.** A ripple is `{ origins: [postType], destination, reference, query?, filters?, trigger_filters? }` and it says: *when a page of one of these types is built, also rebuild a page at this other path*. The starter has none — two page types, one collection, a nav partial, and no page that has to react to something else being published. Adding a ripple is the first thing a real publication does. Firing is decided by `rippleFiresForBody`:

```
fires  ⟺  ripple.origins includes body.postType
       ∧  every predicate in ripple.trigger_filters matches body
```

with `trigger_filters` a list of `{ key: value }` objects, each of which must match in full (`body[key] === value` for all entries). Absent or empty `trigger_filters` means "fires on origin alone". `filters` is the *destination-side* filter — which items the destination page should include — and is not consulted by the gate at all. That split is easy to get wrong when writing a mapping, and the runtime will not tell you: a `trigger_filters` typo makes the ripple fire on everything, and a `filters` typo makes the destination page render an empty list.

Ripples fire **only when a single item is rendered** (`contentIds.length === 1`). A bulk render of fifteen items does not ripple fifteen times; it renders the fifteen items and lets the update copy-forward the rest of the tree, so a home page assembled from a collection is refreshed by the collection's own render, not by the ripple, when the render is a bulk one. This is a real difference between "publish one piece" and "rebuild the site", and it is not documented anywhere except in the code and the author doc.

**The dead key.** `templateConfig[].filters` exists in the type and in some mappings, and nothing reads it. `grep` across `protocol/actions` and `shared` finds `collection.filters` and `rippleConfig.filters`, never `templateConfig.filters`. It is Roadmap's job to kill it or implement it; today it is a field that looks like it selects which items a template handles and does not.

### 5.2 Templates

Handlebars, and only Handlebars' built-ins. There is no helper injection and no custom helper registry — the renderer RFC explicitly retired the idea, and `handlebars.factory` compiles with defaults.

`fetchTemplateBundle(config, templateConfig, gateway)` does three things:

1. `dag/get` the config's `templateCid`, which returns an array of `{ path, cid }` entries — one per file in `templates/`, uploaded by the config builder (§6).
2. Find the entry whose path ends with `/<file>.handlebars` or `/<file>`, and `cat` it.
3. Collect every entry whose path contains `partials/` and ends `.handlebars` as the partial set.

Partials are not registered with Handlebars. They are **textually substituted** before compilation, by regex, up to ten levels of nesting:

```js
const regex = new RegExp(`{{\\s*>\\s*${name}\\s*}}`, "g");
```

so `{{> docs-head}}` is replaced by the source of `templates/partials/docs-head.handlebars`, recursively, and then the assembled string is compiled once. A partial's name is its filename without `.handlebars`. Two consequences: a partial cannot take arguments (`{{> docs-head title="x"}}` leaves the argument in the substituted text as a Handlebars expression evaluated in the *caller's* context, which is usually what you want but is not Handlebars' partial-with-context semantics), and a partial that is never referenced is uploaded and paid for but never read.

Templates are stored **newline-stripped**. The config builder does `content = content.replace(/\n/g, '')` before adding each file to IPFS. HTML survives this; JavaScript line comments inside a template do not, and neither does a `//` comment in an inline script tag. Templates are also quote-stripped at render time by a few regexes (`^"`, `"$`, after `>`, before `<`) which exist to repair pasted HTML and will mangle `alt=""` in edge positions. These are the kind of details a publisher discovers once, expensively.

### 5.3 CSS

SCSS under `scss/` is compiled **locally, by the publisher**, into `assets/css/main.css` (`npm run sass`) and committed. The press does no compilation: `AssetsBuilder` copies `assets/` into the tree at `/assets`, and `ALWAYS_SYNC_FROM_GITHUB = new Set(['js','css'])` means those two directories are re-read from GitHub on every config update even when an unchanged CID would have been reused.

Templates reference the stylesheet with a root-absolute path (`/assets/css/main.css` in the starter), which works because each published page is served from its own origin — `https://<cid>.preview.transport-union.dev` for a preview, `https://<name>.link` for the DNSLink view. `insertStylesheetLink` also supports a build-time hook that replaces the literal `insert_stylesheet.css` with `https://<gateway>/ipfs/<cid>?filename=styles.css`, which is how a single-file template can pull a stylesheet from IPFS without a repo at all.

### 5.4 What a template receives

`initTemplateData` hands the template a flattened object per item, built by `toBody`:

```
id            genesis, as a hex string — the job identity
cid           the item's storage CID (not the genesis)
objectId      EIP-712 digest of the public envelope
plaintextHash keccak256 of the canonical secret JSON
specVersion, mediaType, proof
author        did:ethr:0x… (a string, not an address)
locale, parent, position, postType, publication, base
creationDate, modifiedDate   both = String(public.createdAt)
tags[]
attributes{}  public, signed, queryable
title, slug, content, custom   from the (possibly decrypted) body
encrypted     boolean
```

The distinction between `attributes` and `custom` matters for the look and is easy to miss: `attributes` is part of the **signed public envelope** — visible to anyone with the CID, searchable, in the clear even for an encrypted item — while `custom` is inside the body and is secret when the item is encrypted. A template that shows a byline from `attributes.author_name` leaks nothing; a template that shows `custom.author_name` is fine when the item is in the clear and renders nothing when it is not.

Plus, per render, `collections` assembled from the deal set: the renderer fetches the bodies for the collection's filtered deals (via the archive snapshot, falling back to per-item fetches), filters, sorts, and injects each collection under its `slug` so a template can iterate `{{#each chapters}}`. Collection items are the same flattened shape, decrypted where the item is encrypted and the press is allowed to.

There is no pagination, no tag index, no search. A collection is as long as the deal set.

### 5.5 What runs on the content before the template sees it

Two things happen to `templateData.content` between the decrypted body and the template, and only one of them is a template feature.

**The content-transform stage.** `render/data.ctrlr.ts` passes the body's content through `transformContent(…)` (`render/content-transforms.ts`) — a pure `string → string` stage that runs on the **decrypted plaintext**, before any template logic, and writes only into the rendered output. Stored content stays raw: the transform is never baked into the item, so changing a transform and re-rendering is enough to change the look, and re-publishing is not required.

The built-in transform is called `sections`, and it is the one an author actually types:

```
<!-- section class="aside">            →  <section class="aside">
…                                     →  …
<!-- /section>                        →  </section>
```

The space after `<!--` is optional, and both `-->` and `>` closer forms are accepted on both tags. Only `section` is handled; everything else passes through untouched. The stage is a registered table with `sections` as its default — the *seam* for more transforms, which matters for the next paragraph.

**Why it is not a Handlebars helper.** A helper fires when a template writes `{{sections …}}`. The directive lives in the *markdown body*, so no template ever calls it and a helper can never see it: `sections` existed as a mustache helper first and never fired once, because it had zero call sites. The transform stage fixes that structurally — it does not depend on a template author remembering anything.

**And why a publication cannot ship its own transform or helper.** This is a designed limit, not a missing feature, and it is the sharpest edge in the whole "the look" story. Publication-supplied code in the render path was investigated and abandoned in August 2026, for three independent reasons:

- `new Function` and `eval` are CSP-blocked inside the Lit signing enclave ("Code generation from strings disallowed for this context"), so a helper cannot be *compiled* from source at render time.
- Dynamic `import()` is rejected by Lit's own bundler ("Failed to bundle CDN imports: scanning entry for literal dynamic imports"), so a helper cannot be *loaded* either.
- Render actions are immutable and content-addressed, and the PKP signs only if the executed CID is in the permitted set — so the action text cannot be assembled per render or per publication.

The one workaround that would keep helper code inside the enclave is a **render action built per publication**, and that was explicitly rejected: the shared immutable render action stands. So the seam stays inline — transforms and helpers ship with the press, not with the repo.

**What that leaves a template author with.** The engine implements three block forms — `if`, `each`, `with`, each accepting subexpressions — plus a fixed set of inline helpers registered in `renderer/handlebars-helpers.ts` (30 of them: `extract_images`, `markdown`, `limit`, `slice`, `or`, `ifIn`, `unlessIn`, `explode`, `sluggify`, `stripHTML`, `formatDate`, `formatDateAsMonthYear`, `unique_years`, `filter_by_year`, `index_of`, `prevNext`, `json`, `log`, `concat`, and a few more). `(eq a b)` works only inside `{{#if (eq …)}}` — it is special-cased, not a general helper. Any other `{{#name}}…{{/name}}` is **silently skipped**: no error, no output, the section disappears. `{{#each (prevNext collections.chapters position)}}` is the pattern the starter uses for circular previous/next navigation, and it works because `prevNext` is a built-in.

For a publication, this means the look is *templates, CSS and thirty functions* — not a plugin system. A site whose design needs a helper that does not exist needs a new press release, not a config change. The starter's own template-design notes say as much to whoever is writing templates.

---

## 6. Updating the publication's config from GitHub

### 6.1 What a config is

One JSON object, one CID, one record. The type:

```ts
interface S2SPublicationConfig {
  assetsCid: string;
  contract: string;          // the publication module address
  dataGateway: string;       // the gateway the renderer will use
  mapping: { templateConfig: S2STemplateConfig[]; ripples: S2SRipple[] };
  name: string;              // the ENS label
  templateCid: string;       // the templates DAG
  localePaths?: Record<string, string>;
  domain?: string;           // legacy single write-target
  aliases?: string[];        // additional ENS names to keep pointed at the root
}
```

That is the entire definition of how a publication looks and where its pages go. An earlier revision also carried a `helpersCid` — a pointer to publication-supplied helper code — and it was dropped along with the helper-injection path it existed for (§5.5). A config written before that change still parses; the field is simply ignored. It contains no titles, no content, no HTML — those are in the tree. It is a *recipe plus pointers*: `templateCid` and `assetsCid` are content addresses, `mapping` is the inlined mapping file, and `aliases` is a list of names whose `contenthash_wrapped` should be kept equal to the canonical node's.

It is stored as a string in the records module under the key `config`, and read in two places: `render/config.ctrl.ts` (`getConfig` — if no CID was passed, `getRecord('config')` on L2, then `cat` and `JSON.parse`) and `s2s-records-tab` (which needs the current object in order to add an alias).

### 6.2 The build, step by step

`ConfigBuilder.buildConfig(github_account, repo, branch, publicationName, contractAddress, assetsCid, existingConfigCid?, domain?, aliases?)`. The order matters:

1. **Load the existing config** by CID from Kubo, if one was given. This is how aliases and `localePaths` survive a rebuild — they are carried forward from the old object, not re-derived from GitHub.
2. **Assets.** `AssetsBuilder.buildAssets` syncs `assets/` into MFS under a stable path, restoring unchanged directories from IPFS by reading the previous `assetsCid`'s child map rather than re-downloading them, and always re-reading `js/` and `css/` from GitHub. The result is an `assetsCid`.
3. **Templates.** Walk `templates/` recursively through the GitHub contents API, fetch each file, strip newlines, add each to Kubo, and then `dagPut` a **dag-json array** of `{ path, cid, body, link: { '/': cid } }`. The `link` field is a real IPLD link, not a string — `dagPut` is what makes `templateCid` a DAG node whose children are the template blobs, and it is what lets the action do one `dag/get` and get the whole bundle (§5.2). The array embeds each template's **source text** as well as its CID, so the config duplicates the templates.
4. **Mapping.** `getLatestCommitSHA(owner, repo, branch)`, then `raw.githubusercontent.com/<owner>/<repo>/<sha>/mapping.json`. The mapping is fetched at a **pinned commit**, deliberately: a rebuild while someone is editing the mapping should produce a config that agrees with itself.
5. **Mirrors.** The final config is uploaded to Filebase and Pinata as well as Kubo — identical bytes, therefore the same CID, so the mirrors are copies rather than variants. The templates DAG cannot be re-uploaded that way (re-uploading its JSON would produce a *different* CID), so it is mirrored by recursive **pin-by-CID**: the pinning service pulls the blocks from the Kubo node. Both are fire-and-forget; neither can fail the update.
6. **Assemble** `finalConfig` and `add` it to Kubo. The awaited primary is Kubo; **its** CID is the one that goes on-chain.
7. **Record it**: one Safe proposal, `setRecord('config', <cid>)`.

Alias resolution has a precedence chain worth stating because it is the only place where the config is *stateful*: explicit `aliases` override → explicit `domain` override (treated as `[domain]`) → carried-forward `aliases` → carried-forward legacy `domain` **promoted** to `aliases`. An empty array clears every write-target. A legacy config with only `domain` is silently migrated to the alias model on the next rebuild, so the format heals itself but never goes back.

### 6.3 What reaches the ledger, and who signs it

The on-chain effect of a config update is exactly one string changing in one mapping on Base:

```
records.setRecord("config", "bafy…")
```

`msg.sender` must be the publication Safe. So the flow is: a holder presses Update in the app → the browser tab itself walks GitHub, uploads to Kubo and dag-puts the templates → one `setRecord` proposal → the holders confirm → the Safe executes. Nothing on L1 is touched. The ENS record is **not** written by a config update; only a render writes the root (§7), so a config change with no render changes the site in no observable way.

The CLI/plugin route does the same thing through `TxRunner.genericTx`, with a permissionless Safe service instead of the Safe App SDK — same call, same required signer set.

### 6.4 What a repository change does and does not do

- **Nothing is automatic.** There is no webhook, no polling, no CI. A push changes the repo and nothing else. The publication's config is a photograph of the repo at the moment somebody pressed Update.
- **A rebuild without changes produces the same CID** — content addressing means the second Update is a no-op in bytes, though it still costs a Safe transaction.
- **A rebuild with changes produces a new `config` CID and nothing else.** The pages do not update until a render runs. A publication that changes its stylesheet and does not render has changed nothing a reader can see.
- **The mapping and the templates are pinned at different points in time.** The mapping is read at the commit SHA resolved *after* the template walk; each template file is read through the contents API's `download_url`, which resolves at listing time. A commit landing between step 3 and step 4 can therefore produce a config whose `mapping` describes a `file` that the `templateCid` does not contain — and the failure is at render time (`template file not found`), on the page that uses it, not at update time. The window is milliseconds to seconds and depends on how fast the template walk is; it is a real hole, small, and it is on the Roadmap as "pin one commit per build".
- **Assets and templates are rebuilt on every config update**, even if only an alias changed, so an alias edit re-uploads the whole template set. Because of content addressing that is cheap in storage and not cheap in time.

---

## 7. Bulk render and preview

### 7.1 The button

`s2s-deals-tab`'s toolbar has **Bulk Render** and a **preview** toggle. One button, two behaviours, one entry point:

```ts
const signature  = await this.safeIntegration.signWithSigner('lit actions auth');
const genesisIds = preview
  ? store.deals.filter((d) => d.encryption == false).map((d) => d.genesis)
  : store.deals.map((d) => d.genesis);
const res = await renderwithLitActions(
  preview, this.lit, signature, import.meta.env.VITE_LIT_USAGE_KEY,
  protocolInfo, undefined, store.safeInfo?.safeAddress || '', publication,
  genesisIds, configCid, rpcs, undefined, undefined, undefined, `Bearer ${kuboToken}`,
);
console.log(res);
```

Which is worth reading closely for what it says about the app:

- **The list of items is `store.deals`** — the admin app's own cache, refreshed by Sync. A render is "whatever the app last read", not "whatever the module holds". Stale cache, stale site.
- **Preview silently drops encrypted items.** `filter((d) => d.encryption == false)`. Decryption happens inside the Lit action (`Lit.Actions.Decrypt`), and a preview does not run inside the enclave (§7.3), so an encrypted item would simply fail to decrypt; filtering first turns that certain failure into a smaller render instead of a run full of errors.
- **`authorSafeAddress` is the publication's own address.** The press runs as the publication, signed by a holder, over the publication's items.
- **The RPC endpoints are the app's** (`getRpcUrl(1)`, `getRpcUrl(8453)`), one per chain, single source of truth in `lib/evm.ts`, keyless build falling back to public RPCs.
- **The Kubo token is the app's own** (`VITE_KUBO_TOKEN`, shipped as `Bearer <token>`). The 15th positional argument exists because the render action writes to MFS to compute CIDs, and the gateway in front of Kubo is gated.
- **The return value is printed.** `console.log(res)`, and that is all: the app does not set the new root, does not refresh the header, does not show the new CID. The header's root is updated by re-reading `contenthash_wrapped` (§7.4), which happens on load or when the tree tab syncs — so after a successful render, the visible state of the app is *unchanged* until you reload or press Sync in the tree tab.

### 7.2 What happens inside

`renderwithLitActions` is a five-stage sequence and each stage is a separate press invocation.

1. **prep** — for each genesis, `fetchById` reads the module entry, fetches the item by CID from the gateway, converts it to a body, and runs the item-integrity check. A body that fails integrity is skipped with a reason in the availability list rather than aborting the run. Slug changes are detected here (`getOldSlug` vs the new slug) and become `remove` entries with `replacedBy`, so a renamed page removes the old path in the same update that writes the new one. Then `getTaskConfig` picks the template by `postType` and expands ripples (§5.1). Output: a list of jobs, each with `{ id, templateConfig, path }`.
2. **render**, once per job, in parallel — decrypt if needed, assemble template data, build collections, compile Handlebars, sign and inject the colophon, upload the HTML, return `{ job, path, cid }`. A job whose deal has been retracted comes back `revoked: true` with an empty HTML and its path preserved.
3. **Job classification.** Active jobs (path, not revoked) go to the writer. Revoked jobs and prep's slug-change removals go to `allRemove`. If *every* job failed and there is nothing to remove, the sequence throws with the per-job failures instead of calling update with nothing to do.
4. **update** — the tree surgery and the ENS write (§7.4).
5. **maintain-cache**, fired in parallel with update when any render reported cache drift.

Retries are deliberately absent: `RENDER_RETRY_ATTEMPTS = 1`, so a failed live render fails the run, and the per-session budget is 50 HTTP requests with a deterministic fast-fail when it is exhausted. Both are operator decisions from October 2026 — a retry inside a render was masking a real outage and doubling its cost.

### 7.3 Preview is not a dry run

Preview and publish run the **same** action code, the same template, the same tree surgery, and produce a **real CID** that is really pinned. Three things differ.

**Where it runs.** A non-preview call fetches the action bundle from a gateway and executes it in the Lit network. A preview call posts to `S2S_RUNNER_URL` (default `https://run.transport-union.dev/run`) with a 10-second timeout. So a preview is executed by the protocol's runner service, outside the enclave, with the caller's Kubo bearer in hand. That is why it can be fast and why it proves nothing: **a preview is not evidence about the sealed path.** Its HTML is not verified by the update action's provenance gate either — that gate runs on the way in, and preview skips the write.

**Whether the roots are written.** The update action's record write is guarded by `if (!preview)`. A preview performs the full MFS copy-forward, the file writes, the `files/stat`, the `pin/add`, and then stops. The ENS subname still points at yesterday's root.

**What it leaves behind.** A preview root is pinned in the publication's Kubo, has no ENS pointer, is not mirrored anywhere, and is reachable only at `https://<cidv1>.preview.transport-union.dev` if you know the CID. Since the app prints the result to the console and nothing else, the practical way to see a preview is to read the CID out of devtools. Preview roots accumulate.

Two honest consequences: previewing is *free of commitment but not free of state* (each preview is a new pinned root nobody will ever collect), and the preview path's trust boundary is not the press's — a preview runs on the operator's runner, so it is exactly as private as that runner is.

### 7.4 The ENS update

The update action is the only thing in the system that moves a publication's root. In order:

1. Read `contenthash_wrapped` from the canonical node (the ENS name from `records.name`) — and the `aliases` tracking record, a JSON array of names whose roots are being kept in sync.
2. Create a temp MFS directory `/temp-<Date.now()>`. Unless `reset`, copy the previous root into it (`files/cp`), so the tree is **copy-forward**: anything not touched survives.
3. For each active job: `files/rm` the path, then `files/cp` the rendered HTML to `<path>/index.html`. For each removal: `files/rm <path>` recursively.
4. Replace `/assets` with the config's `assetsCid` (removed first, then copied with `parents=true&flush=false`), so a stylesheet change is atomic with the page that uses it.
5. `files/stat` the temp tree → the new root CID. `pin/add` it.
6. If this was a publish, **one** transaction:

```solidity
batchSetRecords(
  nodes,                                   // canonical node + every alias + removed aliases
  addrs,                                   // address records — zero address, unused here
  [["contenthash_wrapped"], …],
  [["0xe301…", …], …]                      // "" for a removed alias, plus the aliases JSON
)
```

against the protocol's `ENSL2nRecords` contract on Base, where `msg.sender` must be an authorized caller. It is not the publication. It is the **PKP** — the press's own key — which the protocol's setup script authorized with `authorizeCaller(pkp, true)`. The publication's holders authorized the render; they did not authorize the write, and they cannot perform it: the publication Safe is not on the authorized list, and adding it would require the records contract's owner.

7. Clean up the temp path in a `finally`, whatever happened.

Two mechanical details that are load-bearing. The whole ENS write is **one** transaction because `libs/evm.ts` had a nonce race when several writes were issued in a row; batching removed it. And clearing an alias writes `""` to its `contenthash_wrapped` rather than skipping it, because a skipped alias would keep pointing at an old root forever — a silently stale mirror.

The contenthash itself is EIP-1577: `0xe3` (ipfs-ns) + `0x01` (CIDv1) + the raw CID bytes. The client strips the six leading hex characters (`onchainHash.slice(6)`) before decoding, which is why the app's root display and the tree tab both work from a `0x`-prefixed string that is not a CID.

What a reader sees after this transaction: `https://<name>.link` serves the new root, `https://<name>.limo` too, and the app's header shows `https://<cidv1>.preview.transport-union.dev` for the same root on the next load.

### 7.5 The three links, and the one that is a trap

`shared/src/authoring/links.ts` is the single place the hosts build URLs, so the CLI, the Obsidian plugin and the admin app agree:

- `ensLink(name, path)` → `https://<name>.link<path>` — the DNSLink view of production. The root is served at the domain, so a path maps directly.
- `previewLink(cid, path)` → `https://<cidv1-base>.preview.transport-union.dev<path>` — one immutable door per render. Because the subdomain *is* the CID, an old preview link keeps working forever, which is either a feature (a stable review link) or a leak (a page you unpublished is still at its old preview URL, if the root is still pinned).
- `ipfsLink(cid, path)` → `https://ipfs.transport-union.dev/ipfs/<cid><path>` — the raw path gateway, used for the manuscript rather than the site.

Both site links go through `pagePathFor(path, cid)`, which strips a leading `/ipfs/<cid>` segment **only when the CID's multihash digest matches the root's** — because the subdomain and DNSLink gateways serve the site root at the domain, and a `/ipfs/<cid>` prefix would 404. A render path that happens to carry a different CID's prefix is left alone. This is the kind of detail that produces "the preview is broken" bug reports when it is wrong, which is why it is a shared function with a comment rather than three template strings. What nobody is told: that it happened. The only trace is a `TextChanged(node, "contenthash_wrapped", …)` event per written node, and nothing subscribes to it — no webhook, no indexer, no notification to the authors whose pages just changed.

---

## 8. Where the site is

### 8.1 One tree, one node

A publication's site is not a directory of files that belongs to the publication. It is the MFS tree under a root CID, inside **one Kubo node**, the one named by the `data_gateway` protocol record. Every publication on the deployment shares it:

```
/  (root CID, the one in contenthash_wrapped)
├── index.html                    from the `path: "/"` template
├── <slug>/index.html             from `path: "/{slug}/"` templates
├── assets/css/main.css           copied wholesale from the repo
├── assets/js/…
└── …                             whatever previous renders left behind
```

There is no per-publication node, no per-publication credential, and no publication-owned storage configuration anywhere in the codebase. The renderer's writes go to that node with the token the caller supplies (the admin app's `VITE_KUBO_TOKEN`, the author host's equivalent), and the reads of the tree go to the same node through `protocolInfo.gateway` or `config.dataGateway`.

Trust clause, stated once and plainly: **the publication's pages are hosted by the operator.** A publication that leaves can take its CIDs and its ENS name; it cannot take the tree's hosting, because the hosting was never its own. `cid-mirror` (§8.5) exists partly in anticipation of this, and per-publication storage is Roadmap item 8.

### 8.2 How many copies, and of what

Redundancy is not a property of the publication's configuration; it is a property of which host published the bytes. There are three distinct paths, and they behave differently:

| Path | Kubo pin | Filebase | Pinata | Filecoin | Copies |
|---|---|---|---|---|---|
| Author-side publish (`neutralpress`, `renderCalls`) | yes | yes | yes | yes, ≥2 | up to 5 |
| Admin-app Bulk Render (`s2s-deals-tab` → `renderwithLitActions`) | yes | no | no | no | 1 |
| Preview (either host) | yes | no | no | no | 1 |

The publish path calls `backupToProviders(cid, …)`, which is a `Promise.allSettled` over `['filebase','pinata']` plus a Filecoin leg and returns `{ filebase, pinata, filecoin }` where filecoin is one of `'skipped' | 'ok' | 'mismatch' | 'failed'`. It never throws into the caller: a mirror failure is logged and the publish succeeds with fewer copies. The Filecoin leg is wrapped in `runFilecoinLeg` with a 120-second timeout precisely because a hung uplink used to be invisible — the site was "fine" while nothing landed.

So "five-fold" is a **best case on one path**, not a property of the system. The Filecoin leg itself only counts as durable when its own retry loop has committed two copies across provider pairs; `healToFilecoin` treats "fewer than two copies" as a failure and returns `{ copyCount: 0 }` rather than pretending. And the admin app — the surface a publication actually uses — mirrors nothing at all.

The manuscripts have the same shape from the author's side (the author's node plus the same providers, on the author's publish path), which is what makes "the page and the manuscript are equally redundant" approximately true *when both went through the author host*, and false when the page was rendered from the app.

### 8.3 What a preview root is worth

Nothing, as infrastructure. A preview root is pinned once in a shared node, referenced by no ENS record and no alias, and unmirrored. If the node is rebuilt, preview roots are the first thing to disappear, and nothing will notice, because nothing points at them. The only artefact a preview leaves that a publication might want is the HTML, which it can also see by rendering again.

### 8.4 How a publication checks its own availability

Two tabs, one shared library.

**Website tree** (`s2s-website-tree-tab`). Reads `contenthash_wrapped` from the publication's canonical node, decodes EIP-1577 (stripping the six-hex prefix), and walks the DAG through the Kubo gateway with `ls`, bounded at depth 12 and 5 000 entries (`shared/src/cid-view/tree.ts`), rendering a collapsible tree. Its footer shows the `content_cache_<publication>` pointer, so the archive snapshot the renderer uses for collections is visible.

The tab's **Sync** is the interesting part: it keeps the previous snapshot in memory and diffs. A path that disappeared is a retraction; a path that disappeared *and* a path that appeared in the same diff is a slug rename; both are shown as such rather than as an anonymous tree change. It answers "what changed on my site", not "is my site up".

**Storage** (`s2s-storage-tab` over `shared/src/cid-view`). Builds the publication's CID inventory — the config CIDs, the deal CIDs (with an incremental collector and a per-deal fingerprint so a large publication does not re-read the log), and the tree's files — and then asks a *separate* service whether each CID is retrievable:

```
POST https://ipfs-check.transport-union.dev/batch
```

against a list of providers, streamed back as NDJSON. Each probe resolves to one of `'ok' | 'no-providers' | 'inconclusive' | 'not-served' | 'failed'`, and the classification is deliberately conservative in one specific way: **an unreachable checker or provider is `inconclusive`, never "no copies"**. A publication that has just lost its network must not be told it has lost its content.

**Heal.** For anything that is not `ok`, `healCid` re-pins the CID from the remote Kubo node across `kubo`, `pinata`, `filebase`, `filecoin` (`HEAL_PROVIDERS`), fail-open, per-provider error records, concurrency 2 by default. Healing is a repair of *copies*, not a re-publish: it takes the CID that exists and asks other providers to hold it. It cannot resurrect bytes that the source node no longer has — which is why the tree tab and the storage tab are read together: the tree tells you what should exist, the probes tell you what anyone but the operator can still serve.

### 8.5 Serving from somewhere else

`cid-mirror/` is the location-addressed fallback and the first piece of infrastructure that could let a publication be served by somebody other than the operator. It is a small standalone service:

- resolves an ENS name (or accepts a bare CID) → `contenthash_wrapped` → walks the DAG → downloads every leaf into `webcontent/`;
- swaps the directory atomically, so a refresh is never half-served;
- exposes `GET /healthz`, `GET /api/status`, `POST /api/refresh`;
- is documented as an RFC rather than a spec, with the nginx wiring and the "this is a copy, not a read" caveat stated in it.

It turns "your site is a CID in my node" into "your site is a directory any web server can serve", which is a different trust story: a mirror can lie to its own visitors — it is a copy, and a copy can be stale or doctored — but it cannot trap the name, because the ENS record still points at the CID and anyone can resolve that elsewhere.

---

## Roadmap

Each item is one thing, with what it would unlock. Nothing here is started.

1. **Remove upgradeability from the publication module.** Replace `Initializable + UUPSUpgradeable` behind an `ERC1967Proxy` with an immutable module per publication, and delete `setImplementation` (or gate it behind a timelocked owner with the implementation history it already records). It unlocks: "the code you can read is the code that runs", the disappearance of the factory-operator trust edge in §1.5, and a migration story that is "deploy a new module and re-enable it" instead of "hope the proxy's implementation slot is honest". It costs: no more bug fixes to a live publication except by module replacement — which is the point.

2. **Access control on both factories.** `createModule` on either factory and `setImplementation` on the publication factory are unauthenticated (§1.5). It unlocks: a claim that the deployment's shape is not whoever-called-last's, and that a publication created tomorrow used the implementation its creators meant. Cheapest possible version: `setImplementation` behind the same `onlySafe`-style guard the contracts already use, plus an event-only `createModule`.

3. **A reviewer role with a pre-decision read gate.** A third list (or a `hasOffer` branch in `canRead` for addresses the Safe names), plus a render path that builds an offer without admitting it. It unlocks: encrypted offers that the publication can actually read (§3.2), which is the whole confidentiality story for a work in review; and it is a prerequisite for any workflow where unreviewed material must not be public.

4. **A decision record.** A per-genesis `{ declined, by, at }` or an equivalent written on admit/decline, and a notification the author's host can consume. It unlocks: "declined" as a state rather than an absence (§3.3), a reviewer's ability to leave a reason, and an author who is told something instead of inferring silence.

5. **Admin-side retraction that ripples.** Make the app's Revoke also re-render the retracted id so the update action removes the path (§2.3). It unlocks: a page that actually goes away when a publication revokes it — today only the author's revoke flow does this, which means the publication cannot unpublish on its own.

6. **Mirroring on every render path.** Call `backupToProviders` on the admin app's publish render (or move all renders through one host). It unlocks: the "five copies" claim being true for pages published by a publication that has never touched the author hosts (§8.2), instead of true only for the author path.

7. **One commit per config build.** Resolve the commit once and read `mapping.json`, `templates/` and `assets/` from that SHA (§6.4). It unlocks: a config that always agrees with itself, and the removal of a render-time failure mode nobody can reproduce on demand.

8. **Per-publication storage.** A publication-owned gateway or credential (a `data_gateway` per publication rather than one protocol-wide), and an ENS root the publication can write itself — the latter needs `authorizeCaller(safe, true)` on the records contract, which today only the protocol owner and the PKP hold. It unlocks: leaving with your site, and a world where the operator is one host among several instead of the host.

9. **Kill or implement `templateConfig.filters`.** It is in the type, in mappings, and read by nothing (§5.1). It unlocks: a mapping where the difference between "which items this template renders" and "which items this page lists" is expressible without a ripple, or at least a config format with no dead keys.

10. **Decide the tombstone.** `Version.tombstone` is written `false` forever and read by three consumers (§1.3). It unlocks: a real "this work was retracted and must not be re-admitted" record — the difference between a deal that ended and a work the publication has actively refused.

11. **Encryption on by default, once 3 and 4 exist.** Everything is implemented on both sides and switched off in practice (§3.2). It unlocks: the confidentiality the design claims for the pre-decision window, at the cost of making review depend on the reviewer gate being right.

---

## References

Paths are relative to the repository root at `85e9671`. Line numbers are the ones that carry the quoted behaviour; they move.

**Contracts** — `protocol/contracts/contracts/`

- `S2SPublicationModuleV2.sol`: constants `100`/`20` (~36–37); `initialize` (~111–127); `_authorizeUpgrade` (~129–131); `makeOffer` (~145–167); `acceptOffer` (~170–175); `retract` (~182–201); `hasDeal` (~207); `getDeals`/`getOffers` (~217–245); `getLatest`, `getVersion`, `getVersionCount`, `isGenesis`, `authorOf` (~248–275); `canPublish` (~280–285); whitelist management (~297–343); `_append` (~347–367); `Version` struct with `tombstone` (~44) and its only write `tombstone: false` (~362).
- `S2SPublicationModuleV2Factory.sol`: `createModule` (~23–38), `setImplementation` (~45–49), `implementationHistory`, `safeModules`.
- `S2SRecordsModule.sol`: `NAME`/`VERSION` (~59–60); `onlySafe` (~68–71); `setRecord` (~82), `setRecords` (~101), `deleteRecord` (~127); reads (~155–215); `S2SRecordsModuleFactory.createModule` (plain `CREATE`, ~246–250).
- `ENSL2nRecords.sol`: `TextChanged` (~75), `batchSetRecords` (~112–120), `authorizeCaller` (~132), `setProtocolAddress` (~140).
- `ENSResolverWithCCIP.sol`: `contenthash_wrapped` resolution and the CCIP-read path.

**Publication assembly** — `shared/src/publication/`

- `new.ts`: `newPublicationSafe` (~83); salt and twin-Safe connect (~87–94); `setRecordsWithRetry` call (~203); owners on both chains (~205–219); `verifyModulesEnabled` (~228), `setRecordsWithRetry` (~275), `removeInitialSigner` (~358).
- `config-builder.ts`: `buildConfig` (~136); newline strip (~174); templates `dagPut` and the `link` field (~200–208); Filebase/Pinata pins (~214–232); mapping at commit SHA (~234–238); alias precedence (~260–312); `finalConfig` (~315); mirror uploads and the awaited Kubo add (~330–350).
- `assets-builder.ts`: `ALWAYS_SYNC_FROM_GITHUB` (~11), `buildAssets` (~126), directory restore from the previous DAG (~205–243).
- `tx-runner.ts`: `TxRunner` interface, `CHAIN_L1`/`CHAIN_L2`.
- `shared/src/authoring/links.ts`: `previewLink` (~47), `ensLink` (~63), `pagePathFor` (~28).
- `shared/src/ipfs/contenthash.ts`: `toPreviewLabel` (~262), `decodeRootCid`, EIP-1577 encode/decode.
- `shared/src/ipfs/index.ts`: `backupToProviders` (~186–245).

**The press** — `protocol/actions/src/`

- `libs/gates.ts`: `extractSignerAddress` (6), `canRead` (10–37), `canPublish` (39), `canReset` (65).
- `libs/decrypt.ts`: `decryptRaw` (28), `Lit.Actions.Decrypt` (45), `rawFromDecryptor` (54–65).
- `libs/module.factory.ts`: `toBody` (333–370), `verifyDecryptedBody` (verdicts), `Version` binding with `tombstone` (50, 619–625).
- `prep/main.ts`: `main` (45), `getTaskConfig` (~97), job push (~100), ripple gate (~109), ripple destination resolution (~123–135).
- `prep/ripple-gate.ts`: `rippleFiresForBody`.
- `render/main.ts`: `main` (136), archive pointer `content_cache_<publication>` (~188), `initTemplateData` (~252), revoke check (~295), collections (~345), `renderHTML` (~442), `addAndSignMetadata` (~493), upload (~498), `maintainCachePending` (~506).
- `render/config.ctrl.ts`: `getConfig`, `getTaskConfig`.
- `render/data.ctrlr.ts`: `createPath` (31–45), `buildTemplateData` (~241), `filterCollection` (344), `sortCollection` (376).
- `renderer/html.ctrlr.ts`: `fetchTemplateBundle` (16–78), `renderHTMLFromSource` (88).
- `renderer/handlebars.factory.ts`: `replacePartials` (636–670), `fetchPartialsSourceMap` (680).
- `update/main.ts`: `main` (87), `batchSetRecords` ABI (24), `prevEncoded` (161), `mfsPath` (191), copy-forward (198), `pin/add` (412), preview guard (417), the single batched write (439–470).

**The sequence** — `shared/src/rendering/sequence.ts`

- `renderwithLitActions` (151); per-action success/failure envelopes (~250–260); availability logging (~285); `maintainCachePending` (~296); active vs revoked jobs (~303–320); render-failure guard (~330–348); EVM update input (~355); maintain-cache fan-out (~377); return envelope (~434–450).

**The app** — `safe-app/src/`

- `lib/safe-integration.ts`: `initialize` (67–170), `proposeBatch` (194), `fetchSafeModules` (262), `adoptModules` (293), `requireRecordsModule` (346), `setRecord` (361), `makeOffer` (407), `acceptOffer` (421), `retract` (434), `hasDeal` (447), `signWithSigner` (672).
- `lib/publication-init.ts`: `DEFAULT_ENABLE_TIMEOUT_MS = 600_000` (~112); encoders (~140–180); `buildCreateModuleBatch` (~196), `buildEnableModuleBatch` (~222), `buildNameRecordBatch` (~238), `buildFinalizeBatch` (~265), `buildDeletePublicationBatch` (~300), log matching (~345–380).
- `lib/ens-registration.ts`: the L1/twin-Safe comment block, NameWrapper branch.
- `lib/cid-view/heal.ts`: `healToFilecoin`.
- `components/s2s-app.ts`: module gate, `contenthash_wrapped` read, preview link (~1523).
- `components/s2s-deals-tab.ts`: `OFFER_COLUMNS`/`DEAL_COLUMNS` (33–63), `loadDeals` (150–210), `runDealCheck` (~212), `acceptOffer` (~222), `retract`, `bulkRender` (325–372), row renderers (376–415).
- `components/s2s-records-tab.ts`: `HIDDEN_RECORD_KEYS`, config update path (~430–470).
- `components/s2s-whitelist-tab.ts`: the two lists.
- `components/s2s-website-tree-tab.ts`: root read, tree walk, snapshot diff, reset.

**Availability** — `shared/src/`

- `cid-view/tree.ts`: `MAX_DEPTH = 12`, `MAX_ENTRIES = 5000` (25–26), `walkNode` (83–110).
- `cid-view/ipfs-check-client.ts`: endpoint constant, `POST /batch`, NDJSON streaming, `CheckState` mapping.
- `cid-view/coordinator.ts`, `config.ts`, `deals.ts` (`dealFingerprint`, `deriveDealCidSnapshot`).
- `heal/heal.ts`: `HEAL_PROVIDERS` (22), `healCid` (79–180).

**Hosts and the mirror**

- `neutralpress/src/render/render.helper.ts`: `renderCalls`, publish-only mirroring, max 4-way.
- `neutralpress/src/publication/revoke.ts`: `retract` first, then a re-render that yields a removal.
- `0xobsidian/src/filecoin/filecoin.ctrlr.ts`: `uploadTree`, provider-pair retries, ≥2 copies.
- `cid-mirror/`: `README.md`, `brain/specs/RFC-cid-mirror.md`.
- `~/code/website-starter` at `dde6b0f`: `mapping.json`, `templates/`, `templates/partials/`, `assets/css/main.css`, `scss/`, `scripts/render-dev.ts`.

**Documents consulted (and where they lose to the code)**

- `brain/prototype/author-manuscript.md` — the author half; its `BUILT, UNEXERCISED` status vocabulary is used once in this text and its module placement agrees with the tree.
- `brain/prototype/02-authoring.md` — authoring pipeline, superseded in places by `protocol/actions`.
- `brain/specs/SPEC-contracts-publication.md`, `SPEC-contracts-ens.md`, `SPEC-safe-app.md`, `SPEC-00-system-contract.md`, `SPEC-protocol-actions.md`, `SPEC-website-starter.md`.
- `brain/specs/RFC-cid-mirror.md`, `RFC-gateway-keepalive-warmup.md` — the mirror, and the warm-up that was never built.
- `brain/specs/RFC-content-transforms.md` — the `sections` transform, and the three barriers that killed publication-supplied helpers (§5.5).
- `brain/specs/RFC-ens-alias-multiwrite.md`, `RFC-prep-ripples-from-revoke.md`, `RFC-reset-tree-button.md` — the three RFCs whose behaviour *is* in the tree: aliases (§6.2), ripples from a revoke (§7.2), the tree reset (§2.6).
- `brain/specs/RFC-website-starter-agent-kit.md` — the dev render kit behind `website-starter/scripts/render-dev.ts` (§5).
- `brain/specs/RFC-0xobsidian-identity-key-custody-1.md` — author identity and key custody; out of scope here, belongs to the author text.
- `brain/docs-conventions.md` — why this text is a component text and not a spec.

---

## Not verified

- **That the deployed contracts match this source.** No chain state was read for this text; everything above is read from the tree at `85e9671`. Bytecode, `latestImplementation`, and the modules a live publication actually has enabled are unchecked.
- **That the ENS records contract's authorized callers are what the setup script intends.** `authorizeCaller(pkp, true)` is in `protocol/scripts/lit/update-protocol.ts`; whether the deployed contract's owner list and PKP address correspond to it was not checked.
- **Which publications exist and how they are configured** — owner counts, thresholds, whether any live publication is N-of-N, whether any has a second alias, whether any has ever run a Filecoin leg. All of that is deployment state, not code.
- **That `VITE_KUBO_TOKEN` is provisioned in the shipped bundle.** Read from the component; whether the deployed build carries it, and with what scope, was not checked.
- **That the Filecoin uplink is configured.** The legs are wired and skip cleanly; whether a storage session exists in the operator's install is unknown, so "five copies" is a capability, not a measurement.
- **The commit-pinning behaviour of GitHub's `download_url`.** The claim in §6.4 is inferred from the contents API's semantics, not from a live race.
- **That `website-starter` at `dde6b0f` is the repo any live publication points at**, or that its `mapping.json` is byte-identical to what any publication's `config` record holds.
- **That the preview runner and the preview gateway are the same operator.** Assumed from the hostnames; not checked.
- **Whether `ipfs-check.transport-union.dev` is reachable and what provider list the app sends it** — the client code was read, the service was not exercised.
- **Whether the `s2s-app` render's lack of mirroring is intentional.** It reads as an omission rather than a decision; nothing in the code or the docs says which.
- **Gas and latency figures for any of the above.** No transaction was sent, no render was run.
