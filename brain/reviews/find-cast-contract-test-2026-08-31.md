# FIND: cast command used to test a WRITE to a contract

Date: 2026-08-31 · Read-only search of `/home/joera/code/s2s` (all branches, docs, stashes).
Purpose: locate the exact `cast` CLI command earlier used to test WRITES to a contract
(records / update-protocol / lit-action records config — the on-chain records `getProtocolInfo` reads).

## VERDICT: NOT PRESENT — no `cast` WRITE command exists in this repo

There is **no** `cast send`, `cast call`-against-a-writable-path, or any other cast/foundry
command that tests a WRITE to the on-chain records/config module (`S2SRecordsModule`), the
ENS records contract, or the publication/factory modules in this repository — not in the
working tree, not in any of the ~50 branches, and not in git history or stashes.

What the user is looking for was **not** done with `cast`. Writes to the records module are
driven by **TypeScript scripts** (Safe multisig + viem), not by a cast CLI call.

## Evidence of a deliberate, full search

- `rg -i "cast (send|call|calldata|storage|code)"` across the tree (excl node_modules/dist): only hits = ENS scripts below.
- `grep -rni "cast send|cast call"` across the whole tree (excl .git/node_modules/dist): same two ENS scripts only.
- `git log --all -S 'cast '`, `-G 'cast (send|call)'`, `-G 'cast send'`: no write-test hits; the only `cast call` lines ever committed are the ENS read-only ones.
- `git grep -niE "cast"` across **every branch ref** (`refs/heads/*`, `refs/remotes/*`): identical ENS `cast call` lines on every branch, nothing else.
- `git stash` (6 stashes) + `git reflog`: no cast content.
- `brain/` docs (handoffs/, research/, specs/, whitelpaper/, worktrees.md, agents.md, reviews/): zero matches for the bare word `cast`; the write mechanisms discussed are all TS (`update-protocol.ts`/`swap-action.ts`/`setRecord`/`evmWrite`), never cast.
- `package.json`(root + safe-app + shared + protocol): no `cast`/`forge`/`anvil` npm script or dependency.

## Near-miss cast / foundry usages (the ONLY ones that exist)

All live under `protocol/scripts/ens/` and are **read-only lookups or ENS deployment tooling** —
none writes to the records/config module that `getProtocolInfo` reads.

1. **`cast call` — resolver lookup (READ)** · `protocol/scripts/ens/test_resolver.sh:3`
   ```
   cast call --rpc-url https://mainnet.infura.io/v3/5588b2f2645b47bf9d9df736ab328181 \
     "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" \
     "resolver(bytes32)(address)" \
     "$(cast namehash blockchain-ethics.soul2soul.eth)"
   ```
2. **`cast call` — contenthash read (READ)** · `protocol/scripts/ens/test_ccip.sh:2`
   ```
   cast call --rpc-url https://mainnet.infura.io/v3/5588b2f2645b47bf9d9df736ab328181 \
     0x32D75C02008ABC920D85D9b9058582c7217d1dC3 \
     "getText(bytes32,string)(string)" \
     0x9b8478caf6b6cbd2bc1b944f8219dee954cb7c3de16cff8b4dd0413309632d83 "contenthash"
   ```
3. **`cast namehash`** (pure helper) · `protocol/scripts/ens/namehash.sh:3`
4. **`forge create`** (deploys the ENS subdomain registry, not the records module) · `protocol/scripts/ens/deploy_registry.sh` — `--private-key` + `--rpc-url`, constructor args only; it is a one-time deploy of `ENSSubdomainRegistry.sol`, not a records write.
5. **`forge verify-contract` + `cast abi-encode`** · `protocol/scripts/ens/verify_registry.sh`

## What actually writes the on-chain records (the real mechanism — not cast)

- **Records module (`S2SRecordsModule`)**: `0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29` — `getRecords`/`setRecord`/`deleteRecord`.
- **ENS records contract**: `0x5D42f9b016B4251FC6407d5e8154DA887F394900` — `authorizeCaller` / `setText`.
- **Writer script**: `protocol/scripts/lit/update-protocol.ts` — builds a **Safe multisig batch** (`@safe-global/protocol-kit` + viem `encodeFunctionData`) calling `setRecord` for `pkp_ethAddress`, `lit_action_prep/render/update/encrypt/maintainCache`, `ens_records`, `data_gateway`, `ens_registry`, `publication_factory`, `records_factory` (lines ~133–148), plus `authorizeCaller` on the ENS records contract (line ~160). It runs via `pnpm update-protocol` / `pnpm protocol:update` (`package.json` / `protocol/package.json`) and is **not auto-executed** (Safe proposal must be confirmed by owners — INV-8).
- **Group-side writer**: `protocol/scripts/lit/swap-action.ts` (Lit group permission, separate from records).
- **Reader**: `getProtocolInfo` in `shared/src/protocol/index.ts` reads these records (INV-2 key set, SPEC-00-system-contract.md:208).

So if a confirmed "2 writes succeeded to a NEW contract" was observed, the underlying tooling was
the TS Safe-batch scripts above (or the safe-app UI), and there is **no cast command in this repo**
that would reproduce or audit that write. The user's recollection of a cast write-test is not
backed by anything in the repository.

## File:line index for all cast/foundry occurrences

| Occurrence | Kind | File:line |
|---|---|---|
| `cast call` resolver | READ | protocol/scripts/ens/test_resolver.sh:3 |
| `cast call` contenthash | READ | protocol/scripts/ens/test_ccip.sh:2 |
| `cast namehash` | helper | protocol/scripts/ens/namehash.sh:3 |
| `forge create` | deploy (ENS registry) | protocol/scripts/ens/deploy_registry.sh:4 |
| `forge verify-contract` | verify | protocol/scripts/ens/verify_registry.sh:2 |
| `cast abi-encode` | helper | protocol/scripts/ens/verify_registry.sh:7 |
