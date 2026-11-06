# @s2s/author-contracts

The author-side Safe contracts for Polyphony, on Base.

One factory, `AuthorContractsFactory`, deploys every per-author proxy in this package:

| contract | what it is |
|---|---|
| `AuthorContractsFactory` | the deploy path: one UUPS proxy per author Safe for the drafts log, one for the owner history **plus the guard wired to it**, and the two implementation pointers everything proxies onto |
| `DraftsModuleV1` | the author's draft log |
| `OwnerHistoryModuleV1` | who was an owner of the author Safe, and from which block |
| `OwnerHistoryGuard` | a Safe transaction guard that keeps the owner history current; installed with `setGuard`, which checks ERC-165 first — a guard that does not answer `0xe6d7a83a` reverts `GS300` and cannot be installed at all |

## Deployed on Base

| contract | address |
|---|---|
| `DraftsModuleV1` (implementation) | `0x6e8fCDc4a229E55bf76Ec3A73F0fAbFBe0ce7aE6` |
| `OwnerHistoryModuleV1` (implementation) | `0xD8303A7Ca8637794279865bf74723cD0fCEE4112` |
| `AuthorContractsFactory` | `0xbf394ea4e984D473cAFE094a27B88aeaeD788d6A` |

These are the `prod` defaults the CLI carries. `contracts.authorFactory`
(`S2S_AUTHOR_CONTRACTS_FACTORY`) overrides the factory per environment, and the two
implementations are whatever that factory reports.

`createDraftsModule(safe)` and `createOwnerHistoryModule(safe)` are **permissionless**, and
neither installs anything: deploying a proxy (and, for the history, a guard) spends the
caller's gas and writes nothing to any Safe. Adoption is the Safe's own transaction —
`setGuard(guard)`, one transaction, `onlySelf`. The factory cannot do it and does not try.

`enableModule` is **not** part of the install and is not recommended: an enabled module can
call `execTransactionFromModule`, i.e. execute anything as the author Safe, and these modules
need no module powers. What proves adoption instead is the guard slot:
`Safe.getStorageAt(0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8, 32)`
→ guard → `guard.module()` → module. The factory's `getDraftsModulesForSafe`,
`getOwnerHistoryModulesForSafe` and `guardFor` are **indexes, not proof** — creation is open,
so anyone can append an entry for any Safe.

Source in `src/`, tests in `test/`, deploy script in `scripts/`.
`pnpm compile && pnpm test`; `pnpm deploy:authorcontracts` deploys both implementations then
the factory and prints the three addresses.

## Per author Safe — the CLI does this

The per-Safe steps are not a manual chore any more: `s2s author new <pet>` installs on the author
it just created, and `s2s author init` does the same for an author that already exists. Both call
`createDraftsModule(safe)` and `createOwnerHistoryModule(safe)`, check `getDraftsModulesForSafe` /
`getOwnerHistoryModulesForSafe` first so a re-run deploys nothing, and then send the Safe's
`setGuard(guard)`. On a multisig author Safe — where one key cannot execute that transaction — the
factory calls still run, the command stops at `pending-safe` and prints the `to`/`data` to propose,
and an existing guard is never overwritten. See
`docs/specs/author/SPEC-author-cli.md#installing-the-author-contracts`.

The same three steps by hand, when the CLI is not the tool in hand:

1. `createDraftsModule(safe)` on the factory → the drafts proxy. Nothing else to do: its gate is
   `msg.sender == safe`, so the Safe sends `append` to the proxy directly.
2. `createOwnerHistoryModule(safe)` on the factory → `(module, guard)`.
3. One transaction **from the Safe**: `setGuard(guard)` (`to = safe`, `data = setGuard(guard)`
   calldata, proposed in the Safe app or any Safe client). `setGuard` checks ERC-165 first and
   reverts `GS300` for anything that does not answer `Guard`'s interface id.

Do **not** `enableModule` on the author Safe on top of that: an enabled module can
`execTransactionFromModule`, i.e. execute anything as the Safe, and nothing here needs it —
`setGuard` is `onlySelf`, `sync()` is permissionless, and every read is a `view` call.

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
  The guard covers transactions, not a malicious module. It is also the only path
  that can remove a bricked guard.
- An owner rotation too large for the 600k ceiling (an era beyond ten owners
  gaining one, measured) always misses the hook and is always repaired later.

## The publish surface

`main` is `generated/abis/index.ts`, which is generated on `pnpm compile` by
`hardhat-deploy`'s `generateTypedArtifacts` hook and exports exactly the four contracts above —
whatever `src/` contains, because the hook has no include/exclude option. It skips files whose
path ends in `.t.sol`, which is why the test fixtures live in `test/MockSafe.t.sol`. Keep
fixtures in a `.t.sol` file or they will be published as if they were part of the ABI surface.
