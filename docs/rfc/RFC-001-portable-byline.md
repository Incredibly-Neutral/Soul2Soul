# RFC-001 — the portable byline

Status: proposed · Domain: AUTHOR · Satisfies: AUTHOR-9
Sources (dated records, `docs/research/`):
[convergence](../research/2026-09-10-portable-byline-convergence.md) ·
[scoping](../research/2026-09-10-author-owned-bylines-scoping.md) ·
[resolution](../research/2026-09-10-portable-author-byline-resolution.md) ·
[case 2 surface](../research/2026-09-10-portable-byline-case2-author-did-surface.md) ·
[trust model](../research/2026-09-10-external-indexer-trust-model.md) ·
[off-chain findings](../research/indexer-offchain-resolution-findings.md)

The first two carry the design; the rest are working material whose conclusions are above.
The deals-ledger reports were later moved to `docs/research/`; that line of work is dropped, see *Rejected*.

## Problem

> **Settled since 2847c81:** the author form is the author Safe's bare `0x` address; the `did:ethr` label this RFC leans on is retired, and nothing writes it.

AUTHOR-9 asks for a public, author-curated list of works and agreements. What the paper
actually promises is larger: a reader can *follow an author*, not a publication, and the
author's byline survives leaving. None of that exists.

Everything in the implementation is keyed on a **publication**: the read path is
`namehash(<publication subdomain>)` → record → CID → IPFS; attribution is a per-publication
append log (`getDeals` / `getOffers` / `getLatest`); `S2SPublicContent.publications[]`, the
plural field, is never populated. There is no cross-publication query, no author module, no
author ENS node, no resolver for an author. The one author-shaped thing that already exists is
`did:ethr:<authorSafe>` — a client-side label over the Safe address that gates, whitelists and
`genesisAuthor` already use. It is the portable identity; it has never been pointed at anything.

## Shape

Two halves that solve different problems and share one verification spine. They are
complementary, not rival designs:

- **Authority of record (author-asserted).** The author's own ledger store says "here is my body
  of work and where it can be read." Small, writable, deletable only by the author.
- **Comprehensiveness and independent verification (derived).** Anyone can index the
  publication factory's `ModuleCreated` events, read each publication module's append log, filter
  by author, and reproduce a corpus. Trustless in the sense that every entry is checkable.

The author's claim is not authoritative on its own; the derived view is not curated. Each
checks the other, and both rest on the same three proofs: the author-time EIP-712 signature over
the content item, the page-level signed data-integrity proof, and the on-chain
`authorOf(genesis)` / `hasDeal(genesis)` reads.

## Proposal

### 1. Home: a records module on the author's account

`S2SRecordsModule` is a generic, immutable `string → string` store: `onlySafe` writes, public
reads, `getAllKeys` / `getAllRecords` enumeration, `NAME() == "S2S Records Module"`. It is
already deployed on every publication and on the protocol controller. Nothing in it is
publication-specific, and it needs no modification.

The install path is the publication path minus the publication module — existing machinery:

```
recordsFactory.createModule(authorSafe)      // same factory
authorSafe.enableModule(recordsModule)       // batched, via the 4337 client
recordsModule.setRecord('byline:<publication>:<genesis>', claim)
```

Optional by design: an author who never installs a module has no byline and loses nothing else.
Today **no author has one**; this is the greenfield part.

### 2. Record schema: hybrid, not one blob

- **Per-tuple claim keys** — `byline:<publication>:<genesis>`, value a small JSON claim
  (`{version, from, to?, proof}`). The on-chain list, enumerable with `getAllKeys`, so "everything
  this author published" is one read. Curation is `deleteRecord`, which is also how the
  right-to-be-forgotten case works: the entry leaves the current list, the transaction history
  stays.
- **One optional content-addressed pointer** — `bylines` → CID of an index document carrying what
  the ledger should not: human titles, URLs, ordering, presentation. References and proofs only;
  never a manuscript.

Why not one key holding a JSON blob: every edit rewrites the whole list, the module has no
upgrade path, and a single blob makes "hide one entry" a rewrite. Why not a CID pointer alone: the
list would then not sit on the ledger, and AUTHOR-9 asks for exactly that.

### 3. Read path

`resolveAuthorByline(authorSafe)`, client-side, no new contract:

1. walk the Safe's modules, match `NAME() == "S2S Records Module"`;
2. `getAllKeys`, filter `byline:`;
3. for each claim, resolve the publication's module and assert `authorOf(genesis) == authorSafe`
   and `hasDeal(genesis)`;
4. fetch the `bylines` document, if present, for titles and URLs.

A claim that fails step 3 is an author assertion the publication's own ledger does not confirm,
and the reader should be able to see which of the two it is holding.

### 4. Derived index (the other half)

Watch `ModuleCreated` (factories) and `SubdomainRegistered` (ENS registry) → read each
publication module's `getDeals` / `getLatest` → filter by author. Generalises `cid-mirror`, which
already does per-publication resolve → fetch → serve with zero protocol authority. No privileged
write path: an indexer is a reader. A Safe-gated registry of indexers is a convenience surface at
most, never the source of the index.

### 5. No ENS node

`did:ethr:<Safe>` is the label and the Safe is the identity; the byline needs no name of its own.
An author ENS node is possible — `registerSubdomain` is permissionless — but the shared ENS
records store is PKP-write-only, so author writes would need a neutral press action gated on
author ownership. Same author-facing outcome, strictly more machinery. Deferred.

## Rejected

- **A protocol-wide deals ledger with `getBylines(author)` / `authorDeals[author]` maintained
  on-chain.** This was proposed (`docs/rfc/RFC-005-protocol-wide-deals-ledger.md`); the research
  dropped it. It recreates the central store the protocol exists to avoid, and it makes the
  protocol's governance the curator of everyone's byline. The per-author module gives the same
  query with no shared state.
- **A global `safeOf` / `gateOf` registry.** Same objection, less benefit.
- **Byline on the shared ENS records store.** Blocked by the PKP-only write gate; would need the
  neutral-action machinery for no added capability.
- **Trusting one indexer.** That is the platform failure the paper describes, reintroduced as
  infrastructure.

## Decisions needed

1. **Schema** — hybrid above (recommended: on-chain tuples + optional CID document) vs
   per-tuple keys only (no titles) vs a single CID pointer (list not on the ledger).
2. **Who pays** — module deploy and every claim write are author-Safe transactions; paymaster
   policy or the author.
3. **Schema evolution** — the module is immutable and has no upgrade authority. Accept that the
   claim schema is stable, or plan the deploy-new-and-re-point path.
4. **Tombstones** — whether a derived indexer must honour deletions, or the author's list and the
   derived view are allowed to disagree about a withdrawn entry.
5. **Marking the two kinds of entry** — verified (the publication's ledger confirms) vs
   author-asserted only. This is the reader's whole trust decision and it should be visible in
   the document format, not left to the client.

## Gotchas

- **Encrypted work is opaque to a derived indexer** — slug and title live inside the ciphertext,
  so a publication's own records cannot yield a readable index entry. The author's per-tuple claim
  key holds the genesis and therefore a list entry exists even where no title does. This is the
  strongest argument for per-tuple keys over a derived-only index.
- **genesis → URL is not derivable on-chain** — it needs the content item plus the publication's
  config. The index document is the only place a URL can live.
- `getRecords` returns `string[]` (ABI fix, PR #80) — a naive `address` decode misparses.
- `contenthash_wrapped` uses a custom `0xe3 01` codec; use `decodeContenthashWrapped`.
- GAP-1 (hardcoded provenance author) is **superseded** — the render action builds provenance from
  real signed data. The remaining tail is wiring client-side history readers onto per-publication
  modules, which is §3 above. Do not re-open it as a blocker.

## Acceptance

AUTHOR-9 is satisfied when an author with a module has enumerable claim entries; only the author
can add or delete them; a reader can resolve and verify them against the publication's own ledger
without trusting either party; and the list outlives the author leaving every publication.
