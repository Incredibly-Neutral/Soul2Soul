# The author and the manuscript in the s2s prototype

A companion to component 2 of the protocol paper, sitting beside it rather than summarising it: the
paper describes the content-item schema as a contract; this describes the machinery that currently
exists under it — which contract, which key, which file, which call, which bytes. Written from the
code at `85e9671` (main), with the Neovim host read from its unmerged branch (`agent/nvim-core`).

Five words, used consistently below, borrowed from the paper rather than from the code:

- **the author** — the account that signs a manuscript, and the key beneath it.
- **the press** — a publication: an ENS name on Ethereum, a Safe that owns it, and two modules on
  Base that hold its admissions and its settings.
- **the manuscript** — one content item: a signed, immutable JSON object at a CID, identified by the
  digest of its own metadata.
- **the page** — HTML the renderer produces from manuscripts, addressed by a path.
- **the renderer** — the Lit action pipeline that turns the press's admissions into a page tree.

## Status vocabulary

| Tag | Means |
|---|---|
| **RUNNING** | On the ordinary path today. A user of a shipped host hits this code. |
| **BUILT, UNEXERCISED** | The code exists and is tested, but no shipped path reaches it (a flag is always off, a branch is unmerged, a caller never supplies the argument). |
| **DESIGNED** | Written down in `brain/`, no code. |
| **IDEA** | Mentioned in a document, nothing else. |

## What the code says that the outline does not

The outline given for this text was an outline of the intention. Where it and the tree disagree, the
tree wins, and these are the disagreements worth stating before anything else:

| Outline says | Tree says |
|---|---|
| author = Safe multisig + two modules | author Safe carries **no purpose-built modules**. The two modules (`S2SRecordsModule`, `S2SPublicationModuleV2`) hang on the **press** Safe. The author Safe's only module is the ERC-4337 Safe module, installed implicitly by the account library and baked into its address. |
| modules provide byline / key rotation | key rotation and byline history are **DESIGNED** (`brain/handoffs/handoff-owner-history-module.md`, no code). A curated byline list has no contract; the generic string→string `S2SRecordsModule` is the only place it could live, and nothing writes it. |
| body and custom fields encrypted | encryption is **BUILT, UNEXERCISED**: both shipped authoring paths pass `noOpEncrypt`, and `encryption` is `false` in every object produced today. |
| two clients (Neovim, Obsidian) | three hosts on one binary: Obsidian (`0xobsidian` + `neutralpress`), the `s2s` CLI, and the Neovim plugin, which contains no protocol logic at all — it shells out. |
| manuscript identity comes from its content | identity is the EIP-712 **digest of the metadata**, computed before the body is encrypted and before any CID exists. The body enters only as `plaintextHash`. |

One cross-host inconsistency is worth naming early because it changes object identity: the CLI signs
`base = slug` (`author-cli/src/core/author.ts:150`), the Obsidian plugin signs no `base` at all
(`neutralpress/src/content/content.ctrlr.ts:155-167`), and the signing view defaults `base` to `''`
(`shared/src/identity/signing-view.ts:26`). The same note published from the two hosts yields two
different `objectId` values.

---

# Part A. The author

## A1. The account: a Safe with one owner, and the modules that are elsewhere

**RUNNING.** The author's identity on chain is not the key. It is a Safe — a proxy contract that
executes calls on behalf of a set of owners — with exactly one owner and a threshold of one. The key
signs; the Safe is named.

Nothing registers it and nothing announces it. The address is derived, so it exists as an address the
moment a key exists, and as a contract only after someone pays to deploy it.

### Derivation

```ts
// author-cli/src/core/author-safe.ts:29-46
export const AUTHOR_SAFE_SALT_PREFIX = 's2s_';
export const SAFE_L2_SINGLETON: Address = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
export const SAFE_PROXY_FACTORY: Address = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
export const AUTHOR_SAFE_VERSION = '1.4.1' as const;
export const AUTHOR_SAFE_ENTRY_POINT = '0.7' as const;

export function authorSafeSalt(eoa: Address | string): string {
  return `${AUTHOR_SAFE_SALT_PREFIX}${eoa}`;
}
```

and at the account library (`0xobsidian/src/eth/permissionless.safe.service.ts:183-192`):

```ts
const smartAccount = await toSafeSmartAccount({
  client: this.publicClient,
  owners: [this.signer],
  threshold: 1n,
  version: SAFE_VERSION,
  entryPoint: SAFE_ENTRY_POINT,
  saltNonce: BigInt(keccak256(toBytes(salt))),   // salt = `s2s_${eoa}`
  safeSingletonAddress: SAFE_SINGLETON_L2,       // SafeL2 v1.4.1 on Base
  safeProxyFactoryAddress: SAFE_PROXY_FACTORY
});
```

Four things are load-bearing in that block, and each of them changes the address if changed:

1. **SafeL2 v1.4.1**, pinned by singleton address — not the account library's default, which is the
   L1 singleton.
2. **EntryPoint v0.7.** The 4337 module address is part of the Safe's initializer, so the entry point
   is part of the address. `author-safe.ts:78-84` refuses to let this be configured for exactly that
   reason.
3. **The salt is unmasked and chain-free.** `saltNonce = keccak256("s2s_0x…")` — no chain id in the
   preimage, so the address is the same on Ethereum and on Base. The plugin initialises both chains
   and deploys one.
4. **One owner, threshold one.** There is no multisig in the "several humans" sense. "Multisig" here
   means "contract account", and the contract has one signer.

### Who deploys it, and when

The Obsidian core creates the author and deploys in the same gesture
(`0xobsidian/src/main.ctrlr.ts:163-196`):

```ts
await this.initChains(['ETH_MAINNET', 'BASE']);
await this.account["BASE"].deploySafe();
this.user.safe = this.account["BASE"]?.address;
```

Mainnet is initialised and left undeployed — deliberately, per the comment there: "Do not reduce to
Base-only." The headless path makes the same deployment an explicit, idempotent command
(`author-cli/src/core/author-safe.ts:143-176`): predict, check for bytecode, deploy through the
bundler, then poll `isDeployed()` thirty times at two-second intervals so the caller learns
"deployed" rather than "maybe".

The author record itself is a plugin-side struct, not a chain object
(`0xobsidian/src/user/user.ts:23-46`): `{ name, active, eoa, private_key, safe }`. `name` never leaves
the machine.

### Gas: the author does not need ETH

Author writes are ERC-4337 user operations — a `SafeRunner`, not an EOA transaction
(`author-cli/src/adapters/tx-runner.ts:167-210`): `toSafeSmartAccount` plus a Pimlico bundler, with a
Pimlico paymaster when one is configured. The Obsidian path hardcodes
`https://api.pimlico.io/v2/<chainId>/rpc` with the plugin's own key
(`0xobsidian/src/eth/permissionless.safe.service.ts:100-108`) and caches gas prices for a short TTL so
concurrent publishes share one quote.

The write that matters is `S2SPublicationModuleV2.makeOffer(genesis, cid)`, sent **by the Safe**, so
`msg.sender == authorSafe`. That is not a stylistic choice: the module refuses a first append from
anything not whitelisted (`OnlySafe()`), and refuses a later append from anything that is not the
genesis author (`S2SPublicationModuleV2.sol:344-357`). The EOA cannot stand in for the Safe; a
manuscript written from the EOA first is a manuscript the Safe can never edit. The CLI encodes that in
a comment (`author-safe.ts:106-120`) and in a hard separation of runners: `EoaRunner` for reads,
`SafeRunner` for author writes.

### The modules — an inventory, because the outline's "two modules" is not true of the author

| Contract | Lives on | Carries | Status |
|---|---|---|---|
| `S2SPublicationModuleV2` | press Safe | admissions: append-only version log per genesis, deal/offer sets, whitelists (100 authors, 20 devs) | **RUNNING** |
| `S2SRecordsModule` | press Safe | generic `string → string` KV, `onlySafe` writes, enumerable | **RUNNING** (used for protocol config and ENS records, not for author bylines) |
| ERC-4337 Safe module | author Safe | validates user operations for the Safe | **RUNNING** (installed by the account library in the initializer; not authored here) |
| ownership-history / key rotation recorder | — | "this Safe was owned by these keys, in this order" | **DESIGNED** — `brain/handoffs/handoff-owner-history-module.md`, investigation and design only, "no code touched", one fork still open |
| curated byline repository | — | an author's chosen display names / links | **DESIGNED** — treated as a proposal in `brain/findings/FINDINGS-author-features.md`; no contract, no writer, no reader |

Two consequences follow, and they are the interesting part of A1:

- **Key rotation is not possible yet.** A Safe's owner set can be changed with `swapOwner`, but nothing
  records that it happened, so a reader cannot tell a rotated key from a compromised one. The design
  note's conclusion is that identity is the Safe and rotation swaps keys rather than identity — which
  is the right model, and unimplemented.
- **Nothing on chain says which key signed.** The Safe's `getOwners()` says which key *could* have.
  Attribution to a specific key rests entirely on the `proof` field inside the manuscript, off chain.

### Key custody — three stories for one identity

| Host | Where the key lives | Protection |
|---|---|---|
| Obsidian | `data.json` as `key_blob` (base64), decrypted to `private_key` in memory on load (`0xobsidian/src/main.ts:113-160`, `keystore/keystore.ts`) | Electron `safeStorage` — OS keychain; a pass-through keystore on Linux where `safeStorage` is unavailable, which is to say sometimes no protection at all |
| CLI | `S2S_PRIVATE_KEY`, or `privateKey` in `.s2sconfig.json` / `~/.config/s2s/config.json` | plaintext; file permissions |
| Neovim | none — it has no key. It shells out to the binary, so it inherits the CLI's key | inherits the CLI's |

Signing happens on the EOA, always. `safe-app` — the press's control panel — is the only place where
a browser wallet signs, and there the message is a fixed string, `'lit actions auth'`, used to
authorise a render, not to author a manuscript.

## A2. The clients: Neovim, Obsidian, and the binary they share

**RUNNING** for Obsidian and the CLI; **BUILT, UNEXERCISED** for Neovim (branches `agent/nvim-core`,
`agent/nvim-format`, unmerged, absent from `main`).

### Obsidian: two plugins, one stack

`0xobsidian` is the core — identity, accounts, storage, chain services. `neutralpress` is the
authoring surface built on it, and owns the only author write path. Publishing is a five-step notice
sequence (`neutralpress/src/publication/publish.ts:44-105`):

```
1/5 signing content ...
2/5 storing content item on Filecoin ...
3/5 appending version to publication contract ...
4/5 Authorizing ...                      (render only)
5/5 ...
```

The mechanics, in order: `publishContent` parses the note from Obsidian's metadata cache, builds and
signs the item with the BASE account's EOA as `asTypedDataSigner()`, uploads the JSON to Kubo,
`makeOffer`s the CID, optionally renders, then fires the durability legs fire-and-forget.

What the plugin does not do, and the CLI does:

- It signs **no `base` field** (see the divergence above).
- It signs with `noOpEncrypt` — see B1.
- It **overwrites `objectId` with the existing genesis** on a revision
  (`content.ctrlr.ts:195-204`) before uploading, so the stored JSON of a revision carries a digest
  that is *not* the digest of its own signature.
- It re-uploads unconditionally; the frontmatter CID is only a fallback.

### Neovim: a client with no model of the protocol

The plugin knows one thing about the system — that a binary exists. Everything else is composition of
argv (`nvim-s2s/lua/s2s/commands.lua:1-60`, `spawn.lua:1-40`):

```
:S2S <action> [args]        :s2s for short
actions: upload propose preview publish revoke new config last health help
argv:    { bin, group, action, <absolute note path>, args…, '--json' }
```

`--json` is appended unconditionally and last; the plugin never parses flags itself, it discovers them
from `<bin> <group> <action> --help --json` once per session (`commands.lua:62-92`). The working
directory is found by walking up from the note for `.s2sconfig.json`, `.git`, or `package.json`
(`spawn.lua:40-63`), so project-local config wins without the plugin knowing what config is.

The one place the plugin compensates for the binary is result extraction
(`spawn.lua:55-140`): stdout is scanned for top-level `{…}` spans, each is decoded, and the object
carrying `action`, `error`/`ok`, or `config`/`version`/`help` outranks a stray durability log object.
That is a workaround, and the plugin's own comment says so: the binary "is allowed to put human
progress on stdout by accident (its durability legs run fire-and-forget), so the result document is
located, not assumed to be the whole buffer." The contract in the spec is *exactly one JSON document
on stdout*; the implementation is *find the JSON among the noise*. One of the two should move — the
binary is the one that should.

Links the plugin surfaces are rewritten to something a browser can open
(`nvim-s2s/lua/s2s/format.lua:472-527`): `https://polyphony.eth/introduction` →
`https://polyphony.eth.limo/introduction`, gateway configurable (`limo` default, `link` alternative),
with `raw_url` kept as returned.

### The CLI: what both Obsidian and Neovim are built on

Groups `author`, `publication`, `config`; `--json` puts one machine document on stdout and human
progress on stderr.

| Action | Does | Chain? | Upload? | Render? |
|---|---|---|---|---|
| `author upload` | sign + Kubo + pins | no | yes | no |
| `author propose` | `makeOffer(cid)` — uses the CID from the last upload | yes | no | no |
| `author preview` | sign + Kubo + preview render | no | yes (pinned) | preview |
| `author publish` | sign + Kubo + `makeOffer` + prod render + write-back + durability | yes | yes | prod |
| `author revoke` | `retract` **first**, then remove-plumbing render | yes | no | prod |
| `author init` | deploy the author Safe | yes | no | no |
| `publication new` | create the press | yes | no | no |

Note `preview`: it puts the manuscript on IPFS and pins it, with no admission and no render. The
manuscript is not private after a preview, only unpromoted — anyone holding the CID can fetch it.

The whole write path is one function (`author-cli/src/core/author.ts:88-200`), and its ordering is the
part that matters:

```
parse note (basename, not path)
resolve author Safe state
sign  ── buildSignedContentItem ──► objectId, plaintextHash, proof
objectId = frontmatter.genesis ?? signedItem.objectId
upload JSON.stringify(item, null, 2) as content.json
makeOffer(objectId, kuboCid)                     (offer / publish only)
frontmatter: modified_date, kubo_cid, [genesis, author on first publish]
render                                           (preview / publish / revoke)
durability legs                                  (publish only)
```

Frontmatter is the CLI's local index, and it is written back to the note: `genesis`, `author`,
`kubo_cid`, `modified_date`. That is how `propose` can run without flags after an `upload`, and how a
revision attaches to the right manuscript.

## A3. Where the bytes live: Kubo, pins, and Filecoin

**RUNNING**, with two caveats at the end.

### The upload

```ts
// shared/src/ipfs/index.ts:277-300
const formData = new FormData();
formData.append('file', new Blob([fileContent], { type: 'text/plain' }), name);
const response = await fetch(`https://${this.fixEndpoint(this.kuboGateway)}/api/v0/add`, {
  method: 'POST',
  headers: this.kuboToken ? { Authorization: `Bearer ${this.kuboToken}` } : undefined,
  body: formData,
});
return result.Hash || result.Cid?.['/'] || result.Cid;
```

`api/v0/add`, one file named `content.json`, `text/plain`, bearer token, no `cid-version` parameter —
so the CID shape is the node's default. The JSON is serialised with **two-space indentation**, and
that is load-bearing rather than cosmetic: the Filecoin leg builds its CAR from the same serialised
bytes, and the CLI's comment says so (`author.ts:155-157`). Reformatting the JSON changes the CID and
breaks the parity check.

Worked, for the example manuscript in B1 (1180 bytes of JSON, dag-pb, sha2-256, 256 KiB chunks):

```
CIDv0   QmSuxwP6siPGwmxTVW1WvtgurPXbUpMxNPEjQMbNP34q85
CIDv1   bafybeicd66dj6wkgqfirbzfk7qdmrqrkxd4rzdv27sy5bmkrejlip3g66i
DAG     dag-pb (0x70), 1191 bytes with UnixFS envelope
```

### The gateways

| Host | Serves |
|---|---|
| `ipfs.transport-union.dev` | Kubo RPC and path gateway (`/ipfs/<cid>/…`); token-gated writes |
| `preview.transport-union.dev` | **subdomain** gateway: `<CIDv1-label>.preview.transport-union.dev` serves one rendered site root |
| `ccip.transport-union.dev` | ENS/CCIP resolution |
| `run.transport-union.dev` | the Bun serverless runner the preview render uses |
| `<name>.eth.limo`, `<name>.eth.link` | a press's live site, via ENS contenthash |

Link construction is centralised (`shared/src/authoring/links.ts`), which is why the CLI, the plugin,
and the Neovim host print the same three URLs: `previewLink(cid, path)`, `ipfsLink(cid, path)`,
`ensLink(publication, path)`. The preview label is the **CIDv1** form of the rendered root, so every
render gets its own immutable door.

### Durability: three legs, none of them blocking

`backupToProviders(cid, opts)` fires and forgets (`shared/src/ipfs/index.ts`):

| Leg | Call | Failure mode |
|---|---|---|
| Filebase | `POST https://api.filebase.io/v1/ipfs/pins` `{cid, name}` | recorded, ignored |
| Pinata | `POST https://api.pinata.cloud/pinning/pinByHash`, `pinataOptions.sourceIpfs.apiUrl = <remote>/api/v0` | recorded, ignored |
| Filecoin | CAR → Synapse warm storage | `ok` / `mismatch` / `failed` / `skipped` |

Result shape: `{ filebase, pinata, filecoin }`. `mismatch` means the Filecoin root CID differed from
the Kubo CID, and it is surfaced as a warning rather than an error — the CID parity invariant (INV-13)
is observed, not enforced.

The Filecoin leg itself (`shared/src/filecoin/index.ts:761-830`) reaches **two committed copies via two
independent primary stores**: it iterates a pool of eight browser-usable providers, calls each with
`providerIds: [p]` and `copies: 1`, counts a copy only when that single-store call completes with
exactly one copy, and stops at two. Exhausting the pool throws `FilecoinMinCopiesError`. Cost is
modelled rather than quoted: `2.5 USD / TiB / month` storage plus `0.024 USD` per data set per month
(`index.ts:725-739`), i.e. rent, not a one-off fee — a manuscript kept forever costs forever.

Who pays is a config choice, and both options are Bring-Your-Own-Account
(`author-cli/src/adapters/filecoin.ts`): a session-key file (`initWithSessionKey`, described as the
protocol-payer path) or a raw key (`init()`). With neither configured, the leg is `skipped`, silently
and by design.

Every piece is tagged `attributedTo: JSON.stringify(owners)` — the author and press addresses, inside
the Filecoin piece metadata, not on chain.

### The two caveats

1. **The parity check compares strings.** Kubo returns CIDv0; the Filecoin CAR builder returns whatever
   `filecoin-pin` produces. Two spellings of one multihash — `Qm…` and `bafy…` — would report
   `mismatch` while pointing at identical bytes. Whether that fires in practice is unverified here.
2. **Preview publishes bytes without publishing a manuscript.** Upload + pin, no offer. Worth knowing
   before treating "not published" as "not public".

## A4. Four open cards

### Card 1 — retracting a manuscript

**RUNNING**, and asymmetric by caller (`S2SPublicationModuleV2.sol:182-207`):

| Caller | Deal | Offer |
|---|---|---|
| author | removed from deals | removed from offers — full withdrawal |
| press Safe | demoted to an offer (`keptAsOffer = true`) | rejected |
| anyone else | `NotAuthorized()` | `NotAuthorized()` |

What retraction does **not** do: delete anything. The version log stays, every version stays readable
at its CID, and the events stay. Retraction withdraws the manuscript from the press's admissions; it
does not withdraw it from IPFS, from Filebase, from Pinata, or from Filecoin.

And it is two operations, not one. `s2s author revoke` sends `retract` **first**, then re-renders with
the path in `remove[]` so the page stops resolving it (`author-cli/src/commands/revoke.ts:1-5`,
`shared/src/authoring/revoke.ts`). If the second step fails — no Lit session, no RPC, a render error —
the chain says withdrawn and the site still shows the page until the next successful render. There is
no reconciliation job.

The render-side path derivation is worth its own paragraph because it has already been wrong once: the
removal path must reproduce the renderer's `createPath` prefix logic, including the case where a
declared locale maps to an *empty* prefix (`localePaths.en === ''` yields `/<slug>`, not `/en/<slug>`).
`revokedPathFor(slug, locale, localePaths)` is the single implementation.

### Card 2 — pseudonymity, and what 4337 gives back to the reader

**IDEA** as a guarantee, **RUNNING** as a leak. The design intends `did:ethr:0x<safe>` to be an author
identity that is separate from the human. Three properties of the current construction undo most of
that separation:

1. **The user operation carries the EOA's signature.** Threshold is one, so the signature on every
   `makeOffer` is an ECDSA signature by the owner key. Anyone reading the calldata recovers the EOA and
   can group every Safe that EOA owns. The Safe is a pseudonym for the key, not for the person.
2. **The salt preimage is guessable.** `saltNonce = keccak256("s2s_0x…")`. Given a candidate EOA, one
   keccak confirms whether a Safe belongs to it. That is not a break — you still need the candidate —
   but it turns "unlinkable by default" into "linkable by anyone who suspects".
3. **The surrounding services see the plaintext of the relationship.** The bundler and paymaster see
   the userOp and the IP that submitted it; the Kubo node sees the token and the bytes; the Filecoin
   upload sees the funded account. None of those are on chain, and all of them are somebody's log.

Add to that: the body is stored in plaintext today (B1), so the content itself is public at a CID the
chain names. Pseudonymity here means "the press's readers do not need your name", not "nobody can find
you".

### Card 3 — the byline name

**DESIGNED**, at best. There is no name field in the signed object — `S2SContentItem` carries
`author: did:ethr:0x…` and nothing else about the human. There is no author-side contract that maps a
did to a display name; `S2SRecordsModule` is a generic KV on the *press* and nothing writes bylines
into it today.

The only name in the system is `OXOUser.name` in the plugin's local settings
(`0xobsidian/src/user/user.ts:24`), which never leaves the machine. Practical effect: the page's
byline is whatever the press's template decides to render from a did — an address, or a name the press
hardcodes, or nothing.

This is a gap with teeth. A byline that resolves through the press is a byline the press can change;
a byline that travels with the manuscript has to be signed, and `specVersion: '1'` has no field for it.
Adding one is a breaking change to the signing view, i.e. to every existing digest.

### Card 4 — the payment wallet

**IDEA**. There is no payout path anywhere in the contract stack: no splits, no royalties, no
`withdraw`, no recipient field. `S2SPublicationModuleV2` is an admissions register and nothing else.
Whatever money a press takes would sit in the press Safe, and paying an author would be an ordinary
transfer the press decides to make, off protocol.

The author Safe has no receive function of its own and no owner-callable withdrawal; it is a signer
identity, funded only by the paymaster's sponsorship. A separate payment address would have to be
declared, and there is nowhere to declare it — the same structural gap as Card 3, with the same
consequence: any such field is a new signed field and a new digest.

---

# Part B. The manuscript

## B1. The object: type, example, what is signed, how it canonicalises

**RUNNING.**

### The type

```ts
// shared/src/protocol/types.ts:45-83
export interface S2SPublicContent {
  specVersion: string;   // envelope/format version, e.g. "1"
  author: DidEthr;       // did:ethr:0x<safe>
  postType: string;      // S2S kind (post/page); NOT how to parse the body
  mediaType: string;     // how to parse the body
  parent: string;
  position: string;
  publication: string;   // the press's subdomain
  locale: string;
  createdAt: number;     // unix seconds; this version's timestamp
  base?: string;
  tags: string[];
  attributes?: Record<string, unknown>;
  plaintextHash: string; // keccak256 of the canonical secret JSON
}

export interface S2SProof {
  type: 'eip712';
  signer: `0x${string}`;    // the EOA — verified as a Safe owner
  signature: `0x${string}`;
}

export interface S2SContentItem {
  public: S2SPublicContent;  // signed
  objectId: string;          // = EIP-712 digest of `public`
  proof: S2SProof;
  encryption: boolean;       // true → body is ciphertext
  body: string;              // ciphertext OR JSON.stringify({title, slug, content, custom})
}

export interface S2SContentBody {
  title: string;
  slug: string;
  content: string;
  custom?: Record<string, unknown>;
}
```

Flat, no discriminated union. `parent`/`position` are strings (`"0"` for a root) — an ordering hint
for a tree of manuscripts that the renderer does not currently use to sort.

### A complete object

This one is real: the hashes and the signature below were produced by the same ethers v5 build the
repo uses, with the same domain, the same type array, and the same JCS helper. Recover the signature
against the signing view and you get `0x7099…79C8` back. The Safe address is a placeholder — the
digest depends on it.

```json
{
  "public": {
    "specVersion": "1",
    "author": "did:ethr:0x3f7d1c9e2a4b6d8f0c1e3a5b7d9f1c3e5a7b9d1f",
    "postType": "post",
    "mediaType": "text/markdown",
    "parent": "0",
    "position": "0",
    "publication": "polyphony",
    "locale": "en",
    "createdAt": 1761782400,
    "base": "on-portable-bylines",
    "tags": [
      "#protocol",
      "bylines",
      "essay"
    ],
    "plaintextHash": "0xadea4283a72be878857873dfec34e99d950daffb3a7a850533981bad37c56258"
  },
  "objectId": "0xd1117505cb5c1ffc4497be62b4ce0b4f0ce7d282958bd7f24f1edc7d9d6c7509",
  "proof": {
    "type": "eip712",
    "signer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "signature": "0x9c0fc10d103b055c9e4820951caad6748efe0490c96b0e9f12b80824aed62c9f4468ae962aa46f3d0314e852c2de3d8ff30fbac4dea9b0c254df6121793fb8f11b"
  },
  "encryption": false,
  "body": "{\"content\":\"<p>A byline should outlive the publication that printed it.</p>\\n<h2>Why</h2>\\n<p>Because the ledger remembers, and the site does not.</p>\",\"custom\":{\"summary\":\"<p>A byline should outlive the publication that printed it.</p>\"},\"slug\":\"on-portable-bylines\",\"title\":\"On portable bylines\"}"
}
```

1180 bytes as written, 1191 as a DAG. The `body` is a **string containing JSON**, not a nested object —
which is what makes encryption a substitution rather than a schema change: swap the string for
ciphertext and flip `encryption`.

The canonical body, before escaping:

```json
{"content":"<p>A byline should outlive the publication that printed it.</p>\n<h2>Why</h2>\n<p>Because the ledger remembers, and the site does not.</p>","custom":{"summary":"<p>A byline should outlive the publication that printed it.</p>"},"slug":"on-portable-bylines","title":"On portable bylines"}
```

`keccak256(utf8(that)) = 0xadea4283…6258` = `plaintextHash`.

### Public versus secret

| Field | Public | Signed | Notes |
|---|---|---|---|
| `specVersion`, `author`, `postType`, `mediaType`, `parent`, `position`, `publication`, `locale`, `createdAt`, `base` | yes | yes | in the clear, in the CID's bytes |
| `tags`, `attributes` | yes | **as `bytes32` hashes** | arrays are committed by hash, not element-wise |
| `plaintextHash` | yes | yes | the only commitment to the body |
| `proof` | yes | no | signs `public`; not covered by itself |
| `body` | the bytes are public | **no** | covered only by `plaintextHash`; unreadable-difficult only when encrypted |

The distinction that matters: "public" here means *in the object at a public CID*, which is not the
same as *rendered*. An admitted manuscript is public and rendered; an offer is public and not rendered;
a preview is public and not rendered.

### The signing view, and why it differs from the object

```ts
// shared/src/identity/signing-view.ts:11-34
const tagsHash = keccakOfJson(pub.tags);
const attributesHash = pub.attributes
  ? keccakOfJson(pub.attributes)
  : '0x0000000000000000000000000000000000000000000000000000000000000000';

return {
  specVersion, author, plaintextHash, postType, mediaType, parent, position,
  publication, locale, createdAt,
  base: pub.base ?? '',
  tagsHash,
  attributesHash,
};
```

with

```ts
// shared/src/protocol/types.ts:87-113
export const S2S_DOMAIN = { name: 'S2S Content', version: '1', chainId: 8453 };
export const S2S_TYPES = { S2SContent: [
  { name: 'specVersion', type: 'string' },  { name: 'author', type: 'string' },
  { name: 'plaintextHash', type: 'bytes32' }, { name: 'postType', type: 'string' },
  { name: 'mediaType', type: 'string' },    { name: 'parent', type: 'string' },
  { name: 'position', type: 'string' },     { name: 'publication', type: 'string' },
  { name: 'locale', type: 'string' },       { name: 'createdAt', type: 'uint256' },
  { name: 'base', type: 'string' },         { name: 'tagsHash', type: 'bytes32' },
  { name: 'attributesHash', type: 'bytes32' },
]};
```

Consequences worth spelling out, because each has bitten or will:

- **EIP-712 has no arrays of strings in a struct field.** `tags` and `attributes` are committed as
  `keccak256(JCS(value))`, and the object stores the readable arrays. A verifier recomputes the hashes
  and checks the signature. Adding a tag therefore changes the digest — tags are identity, not labels.
- **`base` is defaulted, not omitted.** `pub.base ?? ''` means "no base" and "empty base" are the same
  digest, which is right for stability and wrong for the CLI/Obsidian divergence noted earlier.
- **`chainId: 8453` is in the domain.** A signature made on a fork, or on another chain id, does not
  verify. The identity is Base-scoped even though the Safe address is not.
- **`specVersion: '1'` is the whole compatibility story.** Any new signed field is a new digest for
  every manuscript — there is no extension bag that is *not* signed. `attributes` is the closest thing,
  and it is signed.

### Canonicalisation

`shared/src/identity/jcs.ts`: RFC 8785 — keys sorted by UTF-16 code unit, no whitespace, JSON string
escaping, numbers per ECMAScript. `keccakOfJson(v) = keccak256(utf8(jcs(v)))`.

The order inside `buildSignedContentItem` (`shared/src/identity/sign-content.ts:46-105`) is the part
people get wrong:

```
1. bodyJson      = jcs(body)
2. plaintextHash = keccak256(utf8(bodyJson))
3. signing view  = buildSigningView(publicPart)          ← plaintextHash is now inside it
4. objectId      = EIP-712 digest(signing view)
5. signature     = signTypedData(domain, types, view)
6. body          = encryptFn(bodyJson)                   ← encryption happens last
```

Encryption is last on purpose: the author signs the plaintext's hash, so a reader can prove what was
signed without the key, and the ciphertext never enters the digest. `objectId` exists before a CID
exists, which is the property that lets identity precede storage (B2).

### The signature

- **Where:** inside the object, `proof.signature`, over `proof.signer`'s typed data.
- **What:** the 13-field signing view — never the body, never the CID, never the object.
- **Who:** the EOA. `proof.signer` is the recovery target; `public.author` is the Safe. Verification
  is two steps, and both are needed: recover the EOA from the digest and signature, then check that
  EOA is an owner of the Safe (`isOwner`) — which is what the render gate does implicitly and what
  `verify-content.ts` does explicitly.
- **Encoding:** 65 bytes, `r ‖ s ‖ v`, `v` as 27/28. `proof.signer` is written by stripping and
  re-adding `0x` on `signer.getAddress()` (`sign-content.ts:88-92`), so it keeps the checksummed
  casing — comparison against `author` must be case-insensitive.

### Encryption: staged, wired, off

The seam is one parameter (`sign-content.ts:50`): `encryptFn`. Both shipped hosts pass
`noOpEncrypt`, and `encryption: encryptFn !== noOpEncrypt` records the difference. So today every
object says `encryption: false`.

The other half exists and is tested: the renderer decrypts when `item.encryption` is true, gated by a
Lit action that reads three on-chain facts (`protocol/actions/src/libs/gates.ts:10-40`):

```
canPublish(authorSafe)  ∧  isOwner(authorSafe, signer)  ∧  hasDeal(genesis)
```

and after decryption it re-hashes the plaintext and compares to `plaintextHash`
(`protocol/actions/src/render/main.ts:349-390`). A mismatch is treated like a decrypt failure — the
item is dropped, the page still renders, and a warning is latched ("rendering decrypted item …
unverified"). That integrity check is the good part of the design: encryption does not get to hide an
integrity failure.

So the honest sentence is: access-controlled publication is implemented end to end and has never been
used. The switch is a caller's argument.

## B2. Identity and revision: genesis, the log, and one manuscript through two revisions

**RUNNING.**

### Genesis is the first digest

There is no registry and no mint. A manuscript's identity is `objectId` of its **first** version: the
EIP-712 digest of that version's metadata. Everything after that is a version appended under that
bytes32.

For the example: `genesis = 0xd1117505cb5c1ffc4497be62b4ce0b4f0ce7d282958bd7f24f1edc7d9d6c7509`.

The chain stores — per genesis — a `Version` (contract line 41):

```solidity
struct Version {
    string cid;
    uint256 timestamp;
    bool tombstone;
}
```

`tombstone` is declared, written `false` at every append (`_append`, line 362), and never set to true
by anything. It is a vestige of V1; the retraction semantics live in the deal/offer sets instead. The
shared reads (`shared/src/cid-view/*`) still carry the field through, which is harmless and slightly
misleading.

The structures behind the reads:

| Read | Returns | Notes |
|---|---|---|
| `getLatest(genesis)` | `Entry { genesis, author, cid, timestamp }` | the current pointer, `latestIndex` |
| `getVersion(genesis, i)` | `Version { cid, timestamp, tombstone }` | index-addressable history |
| `getVersionCount(genesis)` | `uint256` | |
| `getDeals(offset, limit)` | `Entry[]` | enumerable deal set, paginated |
| `getOffers(offset, limit)` | `Entry[]` | pending admissions |
| `hasDeal(genesis)` | `bool` | the Lit gate |
| `isGenesis(genesis)` / `authorOf(genesis)` | `bool` / `address` | `genesisAuthor` |
| `canPublish(addr)` | `bool` | press Safe ∨ whitelisted author ∨ whitelisted dev |
| `isWhitelistedAuthor(addr)` | `bool` | ≤ 100 authors |

Writes: `makeOffer(genesis, cid)` (the only author write), `acceptOffer(genesis)` (`onlySafe`),
`retract(genesis)`, `whitelistAuthor` / `removeWhitelistedAuthor` / dev equivalents (`onlySafe`).

The append itself (`S2SPublicationModuleV2.sol:344-370`) is where identity is enforced:

```solidity
if (genesisAuthor[genesis] == address(0)) {
    if (!canPublish(author)) revert OnlySafe();
    genesisAuthor[genesis] = author;            // first writer owns the identity
} else {
    if (author != genesisAuthor[genesis] && author != safe) revert OnlySafe();
}
uint256 idx = versions[genesis].length;
versions[genesis].push(Version({ cid: cid, timestamp: block.timestamp, tombstone: false }));
latestIndex[genesis] = idx;
```

Two things follow that are easy to miss. **First writer wins, permanently**: if the EOA appends a
genesis before the Safe does, `genesisAuthor` is the EOA and the Safe can never edit that manuscript.
**Any text is a valid CID** — the contract does not parse it, hash it, or check that anything exists
behind it. The only integrity in the system is the CID's own content addressing plus the signature
inside the object.

### Walk-through: one manuscript, two revisions

Take the example object from B1. Call its digest `G`.

**Revision 1 — first publish.** `s2s author publish note.md`:

1. Note parsed; `genesis` absent from frontmatter; `objectId = G`.
2. `buildSignedContentItem` → `objectId = G`, `proof`, `plaintextHash = 0xadea…6258`.
3. Upload: `content.json`, 1180 bytes → `QmSuxw…q85`, pinned, durability legs fired.
4. `makeOffer(G, "QmSuxw…q85")` as a userOp from the author Safe. If the Safe is whitelisted (or is
   the press Safe): `versions[G][0] = {cid, timestamp, false}`, `latestIndex[G] = 0`, `_addDeal(G)`,
   `DealStruck`. If not: `_addOffer(G)`, `OfferMade`, and the manuscript is public but unrendered.
5. Frontmatter written: `genesis: G`, `author: did:ethr:0x…`, `kubo_cid`, `modified_date`.
6. Prod render: prep enumerates deals, `getLatest(G)`, fetches the JSON at that CID, verifies the
   signature and `plaintextHash`, renders the press's template, uploads the HTML tree, then updates
   `contenthash_wrapped` on the press's ENS node. The page appears at `/<slug>` — here
   `/on-portable-bylines` — and the press's site is now that CID.

**Revision 2 — an edit.** The body changes; `createdAt` becomes `1761868800`.

```
new body    → plaintextHash 0x286bbb54…ceae       (was 0xadea4283…6258)
new digest  → 0x8db59462b65138e3fc39e0606be0f59e517af6d64b4e920a474fed8ca277f664
genesis     → G, unchanged, read from frontmatter
```

1. `objectId = frontmatter.genesis ?? signedItem.objectId` → `G`.
2. Upload: a new CID (different bytes), same `genesis`.
3. `makeOffer(G, cid₂)` — `genesisAuthor[G]` already set, so this only passes from the same Safe:
   `versions[G][1]`, `latestIndex[G] = 1`. The deal is untouched (`if (!_isDeal[genesis])` guards).
4. Render again: `getLatest(G)` now returns v2; the page is rebuilt at the same path.

What did *not* happen: no identity change, no second genesis, no new deal, no whitelisting, no
notification to the press, no record of *what* changed. The log records two CIDs and two timestamps.
Everything else — that v2 supersedes v1, that v1's words are still in v1's CID, that the author of v1
is the same as the author of v2 — is reconstructed from the objects themselves.

The version history therefore reads like:

```
G  = 0xd1117505…7509
├─ [0]  QmSuxwP6…  1761782400  (blocks.timestamp at append)
└─ [1]  <cid₂>      1761868800  ← latestIndex
```

with `getVersion(G, 0)` and `getVersion(G, 1)` giving back exactly that, and `getLatest(G)` giving the
`Entry` the renderer uses.

### Where the two revisions can diverge from each other

Four edge cases, all real, in the order they bite:

1. **Slug change.** Change the note's filename or `# heading` and the render path changes. Prep
   compares the current slug to the first version's slug and emits an old-path `remove` entry so the
   stale page does not linger (`protocol/actions/src/prep/main.ts:26-95`). Without that, two paths
   serve the same manuscript.
2. **`base` divergence.** Publish from Obsidian, edit with the CLI, and the second version signs
   `base = slug` where the first signed `base = ''`. The digest differs for a reason that is not
   content. The manuscript is still one manuscript — the genesis is the frontmatter's — but the two
   objects disagree about what "the same note" hashes to.
3. **`objectId` handling.** The CLI keeps the uploaded `objectId` at the new digest and only *offers*
   the genesis; Obsidian overwrites the uploaded `objectId` with the genesis
   (`content.ctrlr.ts:201-204`). So a revision published from Obsidian carries an `objectId` that is
   not the digest of its own signature — an object that disagrees with itself, which any strict
   verifier will reject. This is a bug, not a design.
4. **Retraction then republish.** `retract` removes the deal, the version log stays. A later
   `makeOffer(G, …)` appends to the same log and — if still whitelisted — deals again. From the chain's
   point of view the manuscript never left; from the page's point of view it was gone for a while.
   Both are true, and nothing records the interval except the events.

### What the chain does and does not guarantee

Holds, on chain: which genesis exists, who wrote first, which CID was latest at which block, whether a
deal or an offer is current, whether the press admitted the author.

Does not hold, anywhere: that the CID contains what the author meant, that the body at v2 supersedes
v1, that the signature belongs to the person named in the press, that a retracted manuscript is gone,
that the rendered page equals the latest CID (that is the renderer's claim, at a moment, sealed in
`contenthash_wrapped`), or that any of it will still be fetchable — durability is two Filecoin copies
and whoever keeps pinning.

The chain is a narrow, honest ledger of admissions and pointers; the manuscript carries the rest of its
own evidence.

---

## References

Paths relative to the repo root at `85e9671` (Neovim host: branch `agent/nvim-core`).

### Part A

| What | Where |
|---|---|
| Author Safe derivation, salts, pinned Safe/EntryPoint | `author-cli/src/core/author-safe.ts:20-46`, `:63-100`, `:106-140` |
| Author Safe deploy (idempotent, poll) | `author-cli/src/core/author-safe.ts:143-176` |
| Plugin author creation (`newAuthor`, Base-only deploy) | `0xobsidian/src/main.ctrlr.ts:163-196` |
| `toSafeSmartAccount` call, salt nonce, SafeL2 | `0xobsidian/src/eth/permissionless.safe.service.ts:183-192` |
| Pimlico client, gas-price cache | `0xobsidian/src/eth/permissionless.safe.service.ts:100-130` |
| EOA vs Safe runners, 4337 userOp | `author-cli/src/adapters/tx-runner.ts:15-30`, `:167-230` |
| Keys at rest (`key_blob`, `safeStorage`) | `0xobsidian/src/main.ts:113-200`, `0xobsidian/src/keystore/keystore.ts` |
| Author record (local only) | `0xobsidian/src/user/user.ts:23-61` |
| Obsidian publish pipeline (5 steps) | `neutralpress/src/publication/publish.ts:1-110` |
| Obsidian signing, genesis preservation, no `base` | `neutralpress/src/content/content.ctrlr.ts:140-205` |
| Neovim command surface | `nvim-s2s/lua/s2s/commands.lua:1-60` |
| Neovim argv contract, cwd discovery | `nvim-s2s/lua/s2s/spawn.lua:1-63` |
| Neovim stdout JSON extraction | `nvim-s2s/lua/s2s/spawn.lua:55-140` |
| Neovim ENS gateway rewrite | `nvim-s2s/lua/s2s/format.lua:472-527`, `:141-150` of `init.lua` |
| CLI write path, ordering, write-back | `author-cli/src/core/author.ts:88-200` |
| CLI commands (`upload`/`propose`/`preview`/`publish`/`revoke`/`init`) | `author-cli/src/commands/*.ts` |
| Kubo upload (`api/v0/add`) | `shared/src/ipfs/index.ts:277-300` |
| Durability legs | `shared/src/ipfs/index.ts` (`backupToProviders`), `shared/src/pin/index.ts` |
| Filecoin: two primary stores, min copies | `shared/src/filecoin/index.ts:761-830`, `shared/src/filecoin/uploadWithMinCopies` |
| Filecoin cost model | `shared/src/filecoin/index.ts:725-739` |
| Filecoin init (session key / key) | `author-cli/src/adapters/filecoin.ts` |
| CAR builder (Node) | `shared/src/filecoin/car-builder/node.ts` |
| Link builders (preview / ipfs / ens) | `shared/src/authoring/links.ts` |
| Preview label = CIDv1 | `shared/src/ipfs/contenthash.ts:262-268` |
| Retract semantics | `protocol/contracts/contracts/S2SPublicationModuleV2.sol:182-207` |
| Removal path derivation | `shared/src/authoring/revoke.ts` |
| Lit gates for reading | `protocol/actions/src/libs/gates.ts:10-80` |
| Byline/rotation design (no code) | `brain/handoffs/handoff-owner-history-module.md` |
| Curated byline as unbuilt proposal | `brain/findings/FINDINGS-author-features.md` |

### Part B

| What | Where |
|---|---|
| `S2SContentItem` / `S2SPublicContent` / proof | `shared/src/protocol/types.ts:45-83` |
| Domain + type array | `shared/src/protocol/types.ts:87-113` |
| JCS canonicaliser | `shared/src/identity/jcs.ts` |
| Signing view (hashes, `base` default) | `shared/src/identity/signing-view.ts:11-34` |
| Build-sign pipeline (order) | `shared/src/identity/sign-content.ts:46-105` |
| Verification | `shared/src/identity/verify-content.ts` |
| Zod schemas for the wire shape | `shared/src/rendering/action-io.ts` |
| Contract: structs, append, reads, whitelists | `protocol/contracts/contracts/S2SPublicationModuleV2.sol:36-419` |
| Version log reads in shared code | `shared/src/cid-view/deals.ts`, `shared/src/cid-view/coordinator.ts` |
| `toBytes32Id` (genesis from a reference) | `shared/src/identity/contract-id.ts` |
| Render: decrypt, integrity check | `protocol/actions/src/render/main.ts:264-390` |
| Render: slug-change removals, prep | `protocol/actions/src/prep/main.ts:26-95` |
| Update: `contenthash_wrapped` read/write | `protocol/actions/src/update/main.ts:150-260` |
| Render orchestration / endpoints | `shared/src/rendering/sequence.ts:151-230` |
| CLI frontmatter keys | `shared/src/authoring/note.ts` |

## Not verified

Collected honestly: each of these is asserted above from code reading, but not observed running.

1. **The Kubo CID `QmSuxwP6…q85`** is computed locally with Kubo's documented defaults (CIDv0, dag-pb,
   sha2-256, 256 KiB chunks, non-raw leaves). The node's actual `Import.CidVersion` / chunker settings
   are not readable from here. If the node is configured for CIDv1, every CID in this text is one
   character-class off.
2. **Filecoin root-CID parity.** The CLI compares the Filecoin `rootCid` string to the Kubo CID and
   warns on inequality. Whether they match in production, whether the mismatch is a real divergence or
   two spellings of one multihash, and whether the warning fires on every publish: untested here
   (requires a funded session key and network).
3. **The durability legs actually landing.** Filebase and Pinata are fire-and-forget; no test asserts a
   pin exists afterwards. The result object reports what the HTTP calls said, not what the providers
   kept.
4. **Which binary output leaks onto stdout.** The Neovim plugin's JSON-scan exists because something
   writes non-JSON to stdout. The plugin's comment blames the durability legs; I did not reproduce it,
   so the specific leaking call site is unknown.
5. **The `mismatch` example in A3** is reasoning from the comparison's string semantics, not an
   observed log line.
6. **Whether any press has whitelisted an author on mainnet** — and therefore whether the whitelisted
   branch of `makeOffer` has ever run in production. The contract path is tested in CI; the live state
   was not read.
7. **"Preview leaks the manuscript"** is true of the code path (`author preview` → `addToKubo` with
   pinning). Whether the pinned copy is *reachable* depends on the node's gateway policy, which was not
   probed.
8. **`safeStorage` availability on the user's Linux.** The degraded pass-through keystore is in the
   code; whether it is active for any given install is environment-dependent and untested here.
9. **The Neovim host end to end.** Read from an unmerged branch; nothing in this text reflects a plugin
   that has run against the current binary on `main`, and the branch may not apply cleanly.
10. **`tombstone` being dead.** Verified by reading: every construction sets `false`, no setter exists
    in V2. Not verified against an earlier deployment's storage layout (upgradeable proxy) where a
    value could conceivably have been written by V1 logic.
11. **The author Safe's module list at runtime.** That the ERC-4337 module (and fallback handler) is
    what the Safe carries after deployment is property of the account library's Safe setup, which was
    read as a comment and an initializer path, not queried on chain (`getModulesPaginated`). The
    absence of any *purpose-built* module is verified by grep, not by enumeration.
12. **The 1180-byte example's storage cost.** The cost model is quoted; the actual monthly charge for
    one manuscript also depends on how many data sets it shares and how the provider prices it.
