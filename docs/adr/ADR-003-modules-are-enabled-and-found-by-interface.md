# ADR-003 — author modules are enabled, and found by interface

Status: accepted · Domain: AUTHOR

## Context

A gate that holds an author Safe must find the two author modules installed on it. The factory
that minted them is permissionless by design, so its per-Safe list holds proxies no Safe ever
used; a proxy is an address until the Safe adopts it. `NAME()` is a string any contract can copy,
so it names nothing. Oversight has to read adoption from a record only the Safe can write, and
the Safe has exactly two: the enabled-module list and the guard slot.

## Decision

An author Safe enables both of its modules. A reader finds a module that implements ERC-165 by
asking each address on that Safe's enabled-module list `supportsInterface(roleId)` — `0xefb74036`
for the drafts role, `0xee855023` for owner history — and taking the one that answers true.
`enableModule` is `onlySelf`, so the list is the Safe's own statement of what it adopted, and it is
the authoritative role index for both modules. The same rule covers the records module.

It is not yet the rule for the publication module. `S2SPublicationModule` V1, V2 and V3 inherit
`Initializable` and `UUPSUpgradeable` and declare no `supportsInterface`, so the probe reverts on
every deployed publication module and a reader cannot read that revert as "no module here". A
reader that probes publication modules therefore asks for the id first and falls back to `NAME()`
when no candidate answers it. That fallback is recorded debt, not a design: it is deleted when a
publication module implementing the role id is deployed and every live publication has migrated to
it.

The interface id is a compile-time constant of the deployed contract, and it may never change
once published. A reader that has already decided on an id cannot be reached by an upgrade, so a
changed id makes every published module undiscoverable for good. `NAME()` survives as a
human-readable diagnostic and nothing discovers by it.

The guard stays in the slot. A guard is what sees writes: Safe 1.4.1 calls it inside every
`execTransaction`, and an owner rotation is an ordinary `execTransaction` with a self-call in it.

Enabling grants no execution power. Neither module calls `execTransactionFromModule`; each writes
its own storage and answers views. A proxy's implementation pointer is set at creation and moves
only through the Safe's own `upgradeTo`, so an enabled proxy cannot be repointed behind the
Safe's back.

## Alternatives rejected

- **Carry the module address in the content blob.** The blob is signed by the author's key while
  the module is adopted by the Safe. A pointer in the content lets a signed artifact name a
  module the Safe never installed, and makes every reader trust the writer instead of the ledger.
- **The factory index as authority.** `createDraftsModule(victimSafe)` from any account appends
  an entry, so the list contains proxies that Safe never created and never used. It is a lead for
  what to go and verify, never proof of adoption.
- **Read the guard slot for discovery.** The slot holds one address, at a fixed offset in Safe
  storage, reachable only with `eth_getStorageAt`. It names the guard, and the guard names one
  module; it cannot index two roles, and it makes every reader depend on Safe's internal layout.
  It stays a proof for the guard, not a way to find a module.

## Consequences

- An install is now three Safe self-calls in one transaction: `enableModule(drafts)`,
  `enableModule(history)`, `setGuard(guard)`. Before this, only `setGuard` needed the Safe.
- **The cutover is not free.** The modules deployed today, at the addresses `SPEC-author-cli`
  records, predate `supportsInterface`. A gate cannot resolve an unmigrated author Safe by role, and
  that Safe's drafts stay unreadable outside the gate until it adopts new modules. Accepted: the
  alternative is a name or a factory index, and neither proves adoption.
- The enabled list becomes security-relevant. Owners must check that the address they enable is a
  proxy over the published implementation, and they must be able to build `disableModule` with
  its linked-list predecessor — a module the Safe cannot disable is a permanent call surface.
- The id freezes the role's minimum surface forever. Adding a function to a role means publishing
  a new id, not editing the old one; the old id keeps answering from the old bytecode.
- A function outside the id cannot be discovered by role. `blocksOf` and `history` sit outside
  the drafts id, so a reader that needs them pins the implementation or tolerates their absence.
- Adoption keeps the Safe and replaces the modules. A new proxy starts with empty storage, so
  owner-history eras recorded before a migration are gone; the drafts log is carried across by
  `absorb()`. Enabling the new module and disabling the old one is a Safe transaction either way.
