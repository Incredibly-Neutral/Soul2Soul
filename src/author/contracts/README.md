# @s2s/author-contracts

The author-side Safe contracts for Polyphony, on Base.

| contract | what it is |
|---|---|
| `DraftsModuleV1` + `DraftsModuleV1Factory` | the author's draft log, one UUPS proxy per author Safe |
| `OwnerHistoryModuleV1` + `OwnerHistoryModuleV1Factory` | who was an owner of the author Safe, and from which block, one proxy per Safe |
| `OwnerHistoryGuard` | a Safe transaction guard that keeps the owner history current |

Source in `src/`, tests in `test/`, deploy scripts in `scripts/`.
`pnpm compile && pnpm test`; `pnpm deploy:draftsfac`, `pnpm deploy:ownerhistory`.

## The owner-history hook is best-effort. Read this before proposing a rotation.

Safe 1.4.1 has no owner-rotation callback. The only tap is a transaction guard:
`execTransaction` calls `checkAfterExecution` after every execution, and every
owner mutation is `onlySelf`, so a guard *sees* every rotation. Seeing is not the
same as recording.

`OwnerHistoryGuard` forwards at most 600k of gas to `sync()` and keeps 20k back so
the Safe's own transaction can never fail because of it — a guard that reverts is
a permanent brick, so the guard is written to swallow everything. The consequence
is that a Safe transaction whose gas limit is the *estimated* cost starves the
hook: the sync is skipped, `SyncFailed(blockNumber)` is emitted, the era is
stamped at the next successful `sync()` instead of at the rotation block, and the
gap is legible as `lastSyncedBlock()` lagging behind the rotation.

So, when rotating owners on a guarded author Safe:

- propose the transaction with **at least `600_000 + 40_000` of headroom** above
  the estimate, **or** include an explicit `sync()` call in the batch (which needs
  no headroom, because it is the call itself);
- afterwards check that `SyncFailed` was not emitted and that
  `lastSyncedBlock()` moved;
- if it did not, anyone can repair it with a plain `sync()` — `sync()` is
  permissionless, reads nothing but `safe.getOwners()`, and writes nothing but
  what the Safe already says.

The guard's job is the safety net for rotations that arrive through other clients
(the Safe web app, a hardware wallet, a script). The primary path for a rotation
proposed by this project's own tooling should be an explicit `sync()`.

Two holes worth knowing, both properties of Safe 1.4.1:

- `execTransactionFromModule` is a self-call and skips guards, so an enabled Safe
  module can rotate owners — and can `setGuard(address(0))` — with no hook at all.
  The guard covers transactions, not a malicious module.
- An owner rotation too large for the 600k ceiling (an era beyond ten owners
  gaining one, measured) always misses the hook and is always repaired later.

## The publish surface

`main` is `generated/abis/index.ts`, which is generated on `pnpm compile` by
`hardhat-deploy`'s `generateTypedArtifacts` hook and exports exactly the four
contracts above. That hook has no include/exclude option; it skips files whose
path ends in `.t.sol`, which is why the test fixtures live in
`test/MockSafe.t.sol`. Keep fixtures in a `.t.sol` file or they will be published
as if they were part of the ABI surface.
