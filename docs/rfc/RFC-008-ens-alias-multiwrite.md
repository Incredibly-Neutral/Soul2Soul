# RFC-008 — ENS alias / multi-domain write target for publications

> Domain: `PUBLICATION` · moved from `brain/specs/RFC-ens-alias-multiwrite.md` (2026-11-04); number assigned on the move.

> **Type:** design proposal / forward work (an RFC, not a spec). Captures the required behavior
> for generalizing the single `config.domain` write-node override into an **additive alias list**
> (write the publication's contenthash to the canonical publication node AND one or more alias
> ENS names), so a future agent or human can pick it up cold. **Not implemented.** When built and
> reviewed, fold the settled outcome into `SPEC-contracts-ens.md` and
> `SPEC-protocol-actions.md` and strike here.
>
> **Status of prerequisite:** the single-`domain` override is **built and merged** (PR #83
> `config.domain` write target; PR #85 add-domain button; PR #86 ownership-gate toggle, default
> OFF). This RFC is the next step: make it a list, make it additive.
>
> **Origin:** joera direction (2026-10-08). Follows the question "would it be easy to run two
> update txs in parallel? and what if we name the added domain an alias, potentially multiple?"

---

## Context: what exists today

The update action writes the publication's contenthash to a **single node**:

- `protocol/actions/src/update/main.ts:96-103` — node selection:
  `writeDomain = config?.domain ? config.domain : publication; node = namehash(writeDomain)`.
- `protocol/actions/src/update/main.ts:329-330` — the only record write in the codebase:
  `evmWrite(..., 'setText', [node, 'contenthash_wrapped', encoded])`.
- `S2SPublicationConfig` (`shared/src/publication/types.ts:22-33`) has **`domain?: string` only**
  — no array/multi-domain field.
- With `config.domain` set, the write **swaps** the node (publication node is NOT written);
  with it absent, the write falls back to `namehash(publication)`. Proven by tests at
  `update/reset.test.ts:306-334` (single `setText`; node = `namehash(domain)`, explicitly
  `not.toBe(namehash(publication))`).
- There is **no separate reset action** — reset is a boolean inside `update/main.ts`
  (owner-gated `canReset` at `:78-81`), sharing the same single-node `setText` write at
  `:324-334`.

## Confirmed mechanics (read-only verification, `main` @ d603a08)

### C3 `batchSetRecords` is the clean multi-node path

- **Exists on-chain, same gating as `setText`:** `protocol/contracts/contracts/ENSL2nRecords.sol:101-119`
  (`batchSetRecords(bytes32[] nodes, address[] addrs, string[][] keys, string[][] values) external onlyAuthorized`).
  `onlyAuthorized` (`:28-33`) = `authorizedCallers[msg.sender] || msg.sender == owner()`; `setText`
  uses the same modifier (`:70-72`). `onlyProtocol` (`:36-39`) is defined but **never applied** to
  any function — it is not part of either write path. The PKP/Lit key is whitelisted via
  `authorizeCaller` (`:128-133`), so the same caller that passes `setText` passes
  `batchSetRecords`.
- **Present in shared ABI:** `shared/src/contracts/ens.ts:445` (`ensRecordsAbi`), and generated
  ABIs (`protocol/generated/abis/ENSSubdomainRecordsContract.ts:187/:669`).
- **Currently called nowhere** — `setText` is the only record write (update / maintain-cache /
  repoint-archive, single-node each).
- **Gotcha:** `protocol/actions/src/libs/abi.ts` is **435 lines of fully commented-out dead
  code** — `l2RecordsAbi` cannot be imported. The update action uses its own inline
  `RECORDS_CONTRACT_ABI` (`update/main.ts:20-23`) containing only `getText` + `setText`. To call
  `batchSetRecords` from the action, extend that inline ABI (or swap in `ensRecordsAbi` from
  shared).

### `evmWrite` is NOT safe for parallel `Promise.all` writes from the same PKP

`protocol/actions/src/libs/evm.ts`:
- No `NonceManager` anywhere. Nonce is read **once** per call
  (`:130` `getTransactionCount(pkp, "pending")`) and pinned into the tx (`:145`); signer is a
  fresh plain `ethers.Wallet` (`:159`).
- Two parallel calls from the same PKP **race on the nonce** (both may read the same nonce before
  either lands in the mempool). The second send then hits "already known" / "replacement
  underpriced" — and `:178-186` maps exactly those errors to a **silent-success footgun**
  (`{ success: true, message: "already_submitted" }` with a fake hash), so only one of the two
  writes actually lands.
- **Sequential is safe** (each call re-reads `pending` nonce at send time → nonce+1), but each
  write carries its own ~90s receipt-wait budget (`:60`), so N sequential writes = up to N×90s.
- `evmSetup`/`evmWrite` are **fully generic** (any contract + any ABI string; method encoded via
  `contract.interface.encodeFunctionData`). No change to `evm.ts` is needed to call
  `batchSetRecords` — only the caller's ABI must include it.

**Bottom line:** one `batchSetRecords` tx (atomic, all-or-nothing, no nonce concerns) is the easy
correct mechanism. Literal parallel txs are the hard, subtly-wrong version of the same thing.

## Required behavior

1. **Config:** add `aliases?: string[]` to `S2SPublicationConfig`. Keep `domain?: string` for
   backward compatibility — a config with only `domain` set behaves exactly as today (treated as a
   single-alias override), so already-published configs and the tested flow keep working.
   Precedence decision (pick one in implementation, state it here):
   - `domain` present + no `aliases` → alias list = `[domain]` (compat), **or**
   - migrate `domain` into `aliases[0]` on build.
2. **Update action:** build the node list `[namehash(publication), ...(aliases ?? []).map(namehash)]`,
   dedupe, and write **all of them in one `batchSetRecords` call** (same `contenthash_wrapped`,
   same `encoded` value, per-node key arrays). The canonical publication node is **always**
   written — the current "swap" semantics become "additive". Extend the inline
   `RECORDS_CONTRACT_ABI` (`update/main.ts:20-23`) with `batchSetRecords` (or import
   `ensRecordsAbi`). If `batchSetRecords` is deliberately not used (e.g. size limits), fall back
   to sequential `setText` calls — **never** parallel `Promise.all` (nonce race + silent-success
   footgun).
3. **Reset:** same node list, same batch write (publish and reset share the write path today;
   keep that).
4. **Safe-app:** the Records tab "Add domain" becomes "Add alias" — add/remove **multiple**,
   list shown, each alias validated for publication-Safe ownership via the existing
   `domain-validation.ts` gate (currently toggled OFF; applies per-alias when ON).
5. **Removal semantics:** when an alias is dropped from the list, the next update **clears its
   record** (write empty/removed value at that node) so a removed alias stops resolving instead of
   going stale. The canonical publication node is never cleared by this mechanism.
6. **Identity / ownership / discovery are untouched:** `canPublish`/`canReset`, the ownership
   walk (`getDomainOwnerAndModules`), and the protocol discovery root (`ens.factory.ts:60`,
   `namehash('soul2soul.eth')`) stay keyed on the canonical publication name. Aliases are pure
   additional doors to the same record.

## Acceptance contract

- Config with `aliases: ['a.eth', 'b.eth']` produces a single `batchSetRecords` call writing
  `contenthash_wrapped` to `namehash(publication)`, `namehash('a.eth')`, `namehash('b.eth')`.
- Config with only `domain` (no `aliases`) produces identical behavior to today (single write at
  `namehash(domain)`).
- No `domain` and no `aliases` → single write at `namehash(publication)` (unchanged).
- Reset clears the same node list, atomically.
- Tests: extend `update/reset.test.ts` (the `config.domain` describe block) with the aliases
  cases; assert on the `batchSetRecords` call's node array. Green gates: shared suite, protocol
  update suite, shared tsc, safe-app type-check + vitest.

---

## Appendix — Runbook: point an alias `.eth` name at the C5 resolver

**Completed 2026-10-08 for `s3ntiment.eth`** (joera). Recorded as the canonical ops for any
additional alias. No contract changes or redeploys are involved — the ENS contracts are fully
generic (C5 namehashes whatever name arrives; C3 keys records by node; gateway serves any node).

Known addresses (production):
- **C5 resolver** (`ENSResolverWithCCIP`): `0x5ED9023eaDbE9757E347E92D1Da97F2e0b010b61`
- **C3 records** (Base, `ENSL2nRecords`): `0x5D42f9b016B4251FC6407d5e8154DA887F394900`
- **ENS NameWrapper** (mainnet): `0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401`
- **CCIP gateway**: `ccip.transport-union.dev` (embedded in C5's `rpcUrls`)

Steps (all on Ethereum mainnet, in the ENS app `app.ens.domains`):
1. **Register** the name on the ENS `.eth` registrar (connect the wallet / Safe that will own it;
   pay the annual fee). This is the one non-negotiable L1 prerequisite — the protocol cannot own a
   top-level `.eth` name.
2. **Wrap it in the NameWrapper** — required for the wrapped record path C5 branches on
   (`isWrapped(node)` → `contenthash_wrapped`). The ENS app shows **Wrap** only when the connected
   account is the registered owner; if the name was registered through the app's registrar it may
   already be wrapped (you'd see **Unwrap** instead). For a Safe-owned name, connect one of the
   Safe's owner wallets so the app resolves the Safe as owner.
3. **Set the resolver** on the name to the **C5 contract address only** —
   `0x5ED9023eaDbE9757E347E92D1Da97F2e0b010b61`. Do NOT type the gateway URL — the resolver field
   takes exactly one thing (the contract address); the gateway URL lives in C5's own `rpcUrls`,
   never on the name.
4. **Verify** C5's `rpcUrls` already points at `ccip.transport-union.dev` (set at deploy; no
   action if so). A wallet/ENS lookup of the name should trigger a CCIP read to that URL.
5. **On-chain write:** with the alias in the publication config, the update action writes
   `contenthash_wrapped` at `namehash(alias)` on C3 — this works even before L1 is live (C3 gates
   on the PKP, not on registration), but **public resolution** only works after steps 1–4.
6. **Sanity check:** `ethers.utils.namehash('<alias>.eth')` → expected 32-byte node; resolve the
   name in ENS app / wallet.

Sequencing note: the C3 write (step 5) does not require L1, so the code change and the L1
registration can proceed in parallel; flip the alias into the config once both are ready.
