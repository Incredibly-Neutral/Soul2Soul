# @s2s/author-contracts

The author-side Safe contracts for Polyphony, on Base.

One factory, `AuthorFactory`, deploys every per-author proxy: the drafts log, the owner history, and the records module.

| contract                 | what it is                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthorFactory`          | the deploy path: one UUPS proxy per author Safe for the drafts log, one for the owner history **plus the guard wired to it**, one for the records module, and the implementation pointers everything proxies onto |
| `DraftsModuleV1`         | the author's draft log                                                                                                                                                                                          |
| `OwnerHistoryModuleV1`   | who was an owner of the author Safe, and from which block                                                                                                                                                       |
| `OwnerHistoryGuard`      | a Safe transaction guard that keeps the owner history current; installed with `setGuard`, which checks ERC-165 first — a guard that does not answer `0xe6d7a83a` reverts `GS300` and cannot be installed at all |
| `S2SAuthorGate`          | the author check the registry asks: is this address Safe's proxy, onto an allowed singleton, with a records module from an allowed factory enabled and bound to it. All four values are constructor arguments, with no admin |
| `S2SRegistry`            | handles: one unique name per author Safe, one Safe per name. Non-upgradeable, 90-day cooldown after release, versions never reused |

## Deployed on Base

| contract                                | address                                      |
| --------------------------------------- | -------------------------------------------- |
| `DraftsModuleV1` (implementation)       | `0x4Af56578974F04AF041CDE6CFB2676f9Ce96905C` |
| `OwnerHistoryModuleV1` (implementation) | `0x72AEa9722fe3d615F36c2b28dd77117459078Bd0` |

`AuthorFactory` has no address in this table: use the one `pnpm deploy:authorcontracts`
printed. `contracts.authorFactory` (`S2S_AUTHOR_CONTRACTS_FACTORY`) overrides it per
environment, and the three implementations are whatever that factory reports.

A factory deployed before this change has no records role: two implementations, no
`recordsImplementation`, no `createRecordsModule`. Deploy a new `AuthorFactory` with the same
script, which then deploys the records implementation against that new factory. The records
implementation is not compiled in this package: `S2SRecordsModuleV0_1` comes from the artifact
`@s2s/publication-contracts` exports, with `(authorFactory, protocolSafe)` as its constructor
arguments, and the script calls `setRecordsImplementation` on the factory.

`createDraftsModule(safe)`, `createOwnerHistoryModule(safe)` and `createRecordsModule(safe)` are
**permissionless**, and none installs anything: deploying a proxy (and, for the history, a guard)
spends the caller's gas and writes nothing to any Safe. Adoption is the Safe's own transaction —
`setGuard(guard)`, one transaction, `onlySelf`. The factory cannot do it and does not try.

`createRecordsModule(safe)` differs from the other two in one way: the records module's
`initialize` must arrive from the factory, so the proxy is deployed with an empty initializer and
the factory calls `initialize(safe, "")` itself, immediately after. One module per Safe, at
`recordsModuleAddress(safe)`: the salt carries no nonce, the recorded module is returned on every
retry, and the address is zero when no records implementation is set. The factory approves exactly
one records upgrade target at a time (`isApproved(RECORDS_KIND, current)`), which is what the
module's upgrade gate reads.

Adoption is three things, not one: the proxies exist, the guard is in the slot, and the modules
are enabled. A gate finds a role by asking `supportsInterface(roleId)` of each address on
the Safe's `getModulesPaginated` list — `0xefb74036` for drafts, `0xee855023` for owner history —
so an unenabled module has no role to find. Enabling costs the Safe no authority: the modules
never call `execTransactionFromModule`, write only their own storage and answer views. The guard
still matters separately, because a guard is what sees writes. The factory's
`getDraftsModulesForSafe`, `getOwnerHistoryModulesForSafe` and `guardFor` are **indexes, not
proof** — creation is open, so anyone can append an entry for any Safe — and so are the CREATE2
prediction views `draftsModuleAddress` / `ownerHistoryModuleAddress` / `recordsModuleAddress`,
which order the probes and prove nothing. `recordsModule` is a mapping rather than a list, but it
is still not proof of installation: a proxy exists before any Safe enables it.

Source in `src/`, tests in `test/`, deploy script in `scripts/`.
`pnpm compile && pnpm test`; `pnpm deploy:authorcontracts` deploys both author implementations,
the factory, and the records implementation, sets it, and prints the four addresses.
`pnpm deploy:registry` deploys the gate then the registry on Base (see below).

## Handles: `S2SRegistry` and `S2SAuthorGate`

The pen name is free text; the handle is the unique name. `.s2s` is display only: no ENS, no DNS,
no suffix onchain. `S2SRegistry` is non-upgradeable, has no owner, no pause and no upgrade path, and
holds one live entry per handle:

| field             | meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `safe`            | the owning Safe; `resolve(handle)` returns it, or zero         |
| `handle`          | the exact registered spelling, not the stripped one            |
| `version`         | 1 for a first registration, +1 per registration of this skeleton |
| `registeredAt`    | block timestamp of the live registration                        |
| `recordsLocation` | the module named at registration; the Safe can move it          |

Every rule is a byte rule on the raw UTF-8, checked in this order: 3–32 bytes, then `a-z 0-9 -`
only (uppercase is refused, never folded), then no leading, trailing or doubled hyphen, then
reservation, then the skeleton claim, then the cooldown. `InvalidChar(index)` names the byte that
was refused, so a two-byte character reports the index of its first byte.

The skeleton is the handle lowercased, `-` removed, then `0→o`, `1→l`, `i→l`, `5→s`, `rn→m`,
`vv→w`, applied in one pass over the hyphen-free bytes. The order matters: hyphens go before the
pair rules, so `cor-n` and `corn` both fold to `com`. The skeleton is what the one-name-per-spelling
rule keys on, so `alice`, `a1ice`, `al-ice` and `allce` claim the same name. `skeletonOf(handle)` is
public, `pure`, and canonical even for input registration refuses: `skeletonOf('ALICE')` is
`allce`. Validation uses the same function, so `check` cannot disagree with `register`.

One handle per Safe and one Safe per handle. `register(handle, recordsLocation)` is called by the
Safe itself and passes the records module the gate must find enabled on it and bound to it. It
reverts `AlreadyRegistered` before it looks at the name. `release()` deletes the entry, frees every
spelling of the skeleton and starts a **90-day cooldown** during which the name is unavailable to
everyone, including the Safe that released it. The version is keyed by the skeleton in
`versionOf`, so any later spelling of it gets version + 1 and a version is never reused. `setRecordsLocation` is the
ownering Safe's only other write.

Governance can `reserve`/`unreserve` skeletons, `assignReserved(handle, safe, recordsLocation)` a
free reserved name to a gate-checked Safe, `setAuthorGate` and `transferGovernance`. All three name
writers run the same structure check `register` does, so a spelling an author could never register
reverts instead of reserving an unmatchable skeleton. It has no
function that changes a registered entry's `safe`, `version` or `recordsLocation`, and no way to
release on another Safe's behalf. `assignReserved` leaves the reservation set: a released assigned
name returns to the reserved pool, not to public registration.

`check(handle)` returns `(available, reason)` and is caller-independent: it does not consider
whether the caller already holds a handle, and `register` still reverts `AlreadyRegistered` in
that case.

| reason | constant                | meaning                                             |
| ------ | ----------------------- | --------------------------------------------------- |
| 0      | `REASON_FREE`           | registrable now                                     |
| 1      | `REASON_INVALID_CHAR`   | a byte outside `a-z 0-9 -`                          |
| 2      | `REASON_INVALID_LENGTH` | under 3 or over 32 bytes                            |
| 3      | `REASON_INVALID_HYPHEN` | leading, trailing or doubled hyphen                 |
| 4      | `REASON_RESERVED`       | governance keeps the skeleton out of `register`     |
| 5      | `REASON_SKELETON_TAKEN` | another handle with this skeleton is live           |
| 6      | `REASON_COOLING`        | released, still inside the 90 days                  |
| 7      | `REASON_REGISTERED`     | this exact handle is live                           |

`S2SAuthorGate.isAuthor(safe, recordsModule)` answers in this order: `safe` has code; its
`codehash` is one of the allowed Safe proxy runtime hashes; `safe.masterCopy()` is an allowed
singleton; `recordsModule` has code; its `codehash` is the allowed module proxy hash; its
`moduleKind()` is `keccak256("s2s.module.records")`; its `factory()` is in the allowed factory list;
that factory's `recordsModule(safe)` is this module; `safe.isModuleEnabled(recordsModule)`; and
`recordsModule.safe() == safe`. There is no try/catch:
the Safe proxy's own reads cannot revert after its hash check, and a module call that reverts fails
the registration rather than being treated as a no.

The Safe code hash proves the bytecode is Safe's proxy runtime code, not that the canonical tooling
made the contract: anyone can deploy a Safe proxy with that code, and such a Safe is accepted
because the registry registers author Safes, not provenance. On the module side, proxy code and
`moduleKind()` prove the shape, not the origin: `factory()` is answered by the implementation behind
the proxy, so anyone can deploy the same proxy runtime over an implementation that returns an
allowlisted factory. What holds is the factory's own index. `AuthorFactory(factory).recordsModule(safe)`
must return this exact module, and only the factory's `createRecordsModule` writes that mapping. A
stub, a proxy from an unlisted factory, and a proxy over an implementation naming a listed factory
the factory never used are all refused.

All four values are constructor arguments and there is no setter, so a wrong value is permanent in
that gate and needs a new gate plus `setAuthorGate`. `SAFE_SINGLETONS` is the singleton(s) Base
proxies point at, read from `masterCopy()` of a Safe you trust or taken from Safe's Base
deployment. `SAFE_PROXY_CODEHASHES` is `keccak256(eth_getCode(<known Safe proxy>))` on Base, not a
creation code hash and not a hash from another chain. `AUTHOR_FACTORIES` is the `AuthorFactory`
address(es) whose `recordsModule(safe)` must name the module. `MODULE_PROXY_CODEHASH` is
`keccak256(eth_getCode(<a records module AuthorFactory created>))`. The factory deploys
OpenZeppelin's `ERC1967Proxy`, not `S2SModuleProxy`, and every records module it deploys shares that
proxy runtime code. Re-verify all four after any Safe or module release.

## Deploying the registry

`pnpm deploy:registry` deploys
`S2SAuthorGate(singletons, proxyCodehashes, authorFactories, moduleProxyCodehash)` then
`S2SRegistry(gate, governance)`, waits for both receipts, reads back `authorGate()` and
`governance()`, and prints both addresses. It refuses to run when the RPC's chain id is not Base
(8453), when a list or the module hash is missing, when any entry is malformed, when a singleton or
factory has no code, or when governance is zero or has no code. There is no default governance
address. `RESERVED_HANDLES` is checked against the handle byte rules before anything is sent, and a
`reserve` receipt that is not a success aborts instead of printing `Reserved`.

| env var                 | required | meaning                                                    |
| ----------------------- | -------- | ---------------------------------------------------------- |
| `PROTOCOL_PRIVATE_KEY`  | yes      | deployer key, pays gas                                     |
| `SAFE_SINGLETONS`       | yes      | comma-separated Safe singleton addresses                   |
| `SAFE_PROXY_CODEHASHES` | yes      | comma-separated `bytes32` proxy runtime code hashes        |
| `AUTHOR_FACTORIES`      | yes      | comma-separated factories that must index the module for the Safe |
| `MODULE_PROXY_CODEHASH` | yes      | `bytes32` runtime code hash of the module proxy            |
| `GOVERNANCE_ADDRESS`    | yes      | registry governance; must have code, no default            |
| `RESERVED_HANDLES`      | no       | seed names to reserve. Only governance can send `reserve`, so unless the deployer is governance the script prints the `to`/`data` to execute |
| `VITE_DRPC_API_KEY`     | no       | falls back to `https://mainnet.base.org`                   |

The gate and registry are not in the `Deployed on Base` table above: use the addresses the script
prints, and record them where the CLI reads its contract address from. Nothing is installed on any
Safe by this deployment.

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
3. One transaction **from the Safe** carrying the batch: `setGuard(guard)` and
   `enableModule(drafts)`, `enableModule(history)` (`to = safe`, the three calls in one `multiSend`
   or one Safe transaction). `setGuard` checks ERC-165 first and reverts `GS300` for anything that
   does not answer `Guard`'s interface id; `enableModule` is `onlySelf` and reverts `GS102` when
   the module is already enabled, so send only what is missing.

`enableModule` is part of the install. What it does not give the modules is the ability to execute
as the Safe: neither calls `execTransactionFromModule`, `setGuard` is `onlySelf`, `sync()` is
permissionless, and every read is a `view` call.

## The owner-history hook is best-effort. Read this before proposing a rotation.

Safe 1.4.1 has no owner-rotation callback. The only tap is a transaction guard:
`execTransaction` calls `checkAfterExecution` after every execution, and every
owner mutation is `onlySelf`, so a guard _sees_ every rotation. Seeing is not the
same as recording.

`OwnerHistoryGuard` forwards at most 600k of gas to `sync()` and keeps 20k back so
the Safe's own transaction can never fail because of it — a guard that reverts is
a permanent brick, so the guard is written to swallow everything. The consequence
is that a Safe transaction whose gas limit is the _estimated_ cost starves the
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
`hardhat-deploy`'s `generateTypedArtifacts` hook and exports the ABIs of everything in `src/` —
the six contracts above and the interfaces they share — because the hook has no include/exclude
option. It skips files whose path ends in `.t.sol`, which is why the test fixtures live in
`test/MockSafe.t.sol` and `test/RegistryMocks.t.sol`. Keep fixtures in a `.t.sol` file or they
will be published as if they were part of the ABI surface.
