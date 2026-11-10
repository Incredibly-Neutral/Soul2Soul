# SPEC-author-hosts — shared core + the authoring hosts (obsidian, safe-app, binary, neovim)

> **Parent:** [SPEC-author](SPEC-author.md) — the authoring front door. Children that realize
> this split: [SPEC-author-identity](SPEC-author-identity.md),
> [SPEC-author-publishing](SPEC-author-publishing.md), [SPEC-author-cli](SPEC-author-cli.md),
> [SPEC-author-nvim](SPEC-author-nvim.md), [SPEC-author-vscode](SPEC-author-vscode.md).
>
> **Type:** settled architectural decision (a SPEC — describes the target host architecture, not a
> change proposal). Records the decision made **2026-10-17**.
>
> **Status:** ACCEPTED (joera direction). Some mechanisms are not yet built; pending pieces are
> listed at the bottom with pointers to RFCs. When built + reviewed, fold the settled parts back
> here.
>
> **Origin:** joera (2026-10-17), from the "safe-app init + shared reuse" design thread.

---

## The model in one sentence

`s2s` authoring is owned by **three hosts** — the obsidian plugin (`neutralpress`/`0xobsidian`),
`safe-app` (browser iframe), and a future **headless binary** — that **all draw from
`@s2s/soul2soul-shared`**, where shared holds the *pure orchestration + narrow injected deps* and
**each host writes its own thin adapter for its own runtime reality**. Nothing is shared that is
runtime-specific; no host imports another host's internals.

---

## AD-1. Three hosts, one shared core

| Host | Runtime | ETH actor | Tx model | Owns |
|---|---|---|---|---|
| `neutralpress` / `0xobsidian` | obsidian plugin — **left as-is** | deployer EOA via oxo (`PermissionlessSafeService`) | execute (private key) | in-plugin authoring + fresh creation |
| `safe-app` | browser iframe (Vite/Lit) | **the Safe itself** | SafeAppsSDK propose-to-queue, batched | "make this existing Safe a publication" (module install) + all author flows from the Safe |
| **binary** (future) | node CLI — **blank slate** | funded key via `permissionless` (`toSafeSmartAccount` + Pimlico, all HTTP) | execute (private key) | fresh full creation (twin L1+L2 Safes + L1 ENS registration) + headless authoring |

**Consequences / rules:**

- **Leave `0xobsidian` as-is.** The oxo controller graph (`MainController` + services) is
  obsidian-bound at construction — reads `plugin.settings.*`, `session-key.json` via the vault,
  uses `Notice`/`saveSettings`, Electron `net` transport (`0xobsidian/src/main.ctrlr.ts`,
  `permissionless.safe.service.ts`). It is **not** moved into shared; it stays an opaque host that
  supplies deps. Shared already treats it as an opaque `any` at the seam
  (`shared/src/publication/tx-runner.ts:47` `createTxRunner(oxo, chain)`).
- **The binary is a blank slate.** It does not clone or import `neutralpress`/`0xobsidian`
  internals, and we do **not** force a grand unified host abstraction into shared to "reuse
  everything". Reuse-everything made the design more complicated, not less. The binary reuses only
  what is already in shared; it writes its own node adapters (permissionless `TxRunner`, viem
  signer, kubo client, `LitService`, `FilecoinStorage`-node, env config) fresh.
- **The obsidian plugin keeps working as today** — no behavioral change from this decision.

## AD-2. Interface extraction, not object relocation

shared holds pure orchestration + primitives, parameterized by **narrow injected deps**. Existing
instances of the pattern (extend, don't replace):

- `TxRunner` + `createTxRunner`/`createL1Runner`/`createL2Runner` bridge — `shared/src/publication/tx-runner.ts`
- `S2SIPFSMethods` (+ `backupToProviders`, `runFilecoinLeg` with `onFailure` callback) — `shared/src/ipfs/index.ts`
- `NewPublicationDeps` + `buildNewPublicationDeps` — `shared/src/publication/new.ts`
- `TypedDataSigner` / `decryptFn` — `shared/src/identity/*`
- `FilecoinCarBuilder` browser/node subpath split — `shared/src/filecoin/car-builder/*`

**Do NOT** relocate the oxo controller object graph into shared — that drags obsidian in and
breaks the browser (safe-app) and node (binary) runtimes. The correct shape is: shared defines the
*contract* (interface), each host supplies the *implementation* for its own runtime.

## AD-3. safe-app: the Safe is the universal ETH actor

Inside safe-app, **every Ethereum tx — including deployment and funding — is a tx proposed to the
Safe itself**, executed by the Safe, approved by the human owner. There is no deployer EOA inside
the iframe and there is no private key in the browser.

Contract ground-truth that makes this valid:

- `S2SPublicationModuleV3Factory.createModule(safe, owners, delegates)` accepts only the safe it
  names, or the protocol safe on that safe's behalf (`NotSafeOrProtocolSafe`), so the creation tx
  **must come from the Safe**. Under the superseded V2 factory the function was plain `external`,
  and the proxy's `initialize` being `onlySafe` (`S2SPublicationModuleV2.sol:101,111`) is what made
  it Safe-bound.
- `S2SRecordsModuleFactory.createModule(safe)` and `S2SRecordsModule.setRecord` are likewise
  Safe-bound (`S2SRecordsModule.sol:82,246`).
- `enableModule` / `getModulesPaginated` / `isModuleEnabled` are standard Safe functions
  (`shared/src/contracts/safe_implementation.ts`).
- safe-app already sends arrays via `safeSdk.txs.send({ txs: [...] })` = a batch proposal
  (`safe-app/src/lib/safe-integration.ts:136`).

**Canonical "new publication init" flow inside safe-app** (correcting the earlier
"needs external deployer" framing — that framing assumed an EOA deployer; it was wrong for the
install case):

1. Create a Safe (one or more owners) in Safe web.
2. Load safe-app; modules are missing → component offers to initialize.
3. safe-app proposes **one batch** from the Safe:
   `recordsFactory.createModule(safe)` → `enableModule(records)` →
   `pubFactory.createModule(safe, owners, [])` → `enableModule(pub)`.
4. Owner approves **once**; the Safe executes (needs a small native gas balance; a relay/paymaster
   is a later option).
5. Verify afterwards via `NAME()`-sniff / `getModulesForSafe`.

## AD-4. Division of labor

- **safe-app** = "make THIS existing Safe a publication" (module install + records) and then run
  author flows (publish/revoke/offers) as Safe-queued txs. The Safe is the actor.
- **binary** = fresh full creation (deploy twin L1+L2 Safes with the same salt, register the L1
  ENS subdomain, install modules) using a funded key, plus headless authoring.
- **neutralpress** = in-plugin authoring + creation via the oxo EOA runner (unchanged).
- **editor wrappers** (`nvim-s2s`, `vscode-s2s`) are clients, not hosts: no adapters, no domain
  state, no ETH actor of their own — they spawn the binary and format its `--json` result
  ([SPEC-author-nvim](SPEC-author-nvim.md), [SPEC-author-vscode](SPEC-author-vscode.md)).
- **Full fresh creation is NOT expressible from inside safe-app**: the Safe you are inside cannot
  deploy its own L1 twin or register the L1 ENS subdomain as an address it does not yet own. That
  boundary is intentional.

## AD-5. The ENS namespace is owned by the L1 Safe

The L1 Safe is the **owner of the publication's ENS namespace**: the canonical subdomain
(`registerSubdomain(subdomain, publicationAddress1)`, `shared/src/publication/new.ts:66-71`) and
**any full-domain aliases** are owned by the L1 Safe. This is the mechanism for ENS management.

Mechanics (verified):

- `registerSubdomain` is `public`/permissionless and assigns the subnode owner to the
  **`subdomainOwner` argument**, not the caller
  (`ENSOpenSubdomainRegistry.sol:105-135`, `ens.setSubnodeOwner(parentNode, label, subdomainOwner)`).
  Whoever executes the call does not matter for ownership — the passed address owns the node. So
  the L1 Safe executing `registerSubdomain(alias, l1Safe)` makes the L1 Safe the owner.
- **safe-app CAN propose a tx to the L1 Safe, but not via the SafeAppsSDK.** The SDK is bound to
  the embedded (current) Safe only (`safe.getInfo()` / `txs.send`). The browser-viable
  cross-chain path is the **Safe Transaction Service REST API for the L1 chain**
  (`POST {tx-service}/api/v1/safes/{l1Safe}/multisig-transactions/` with to/data/value/operation/
  safeTxGas) — safe-app builds the ENS tx data and posts it to the L1 Safe's queue; the L1 Safe's
  owners sign/execute in Safe UI. No private key needed in safe-app.
- **Constraints:** the L1 Safe address must be discoverable (deterministic from
  `salt = 'publication_safe_<name>'` + CREATE2, or from a records mapping); the L1 Safe needs gas
  to execute; multi-owner L1 Safes need threshold signatures like any Safe tx; safe-app needs the
  L1 (chainId 1) tx-service URL.
- **Aliases:** full-domain aliases (real ENS domains pointed at the publication) must also be
  owned by the L1 Safe so the publication can set resolver/addr/text/transfers on them.
  Mechanism for *writing contenthash to* aliases is covered separately by
  `RFC-ens-alias-multiwrite.md` (L2 records `batchSetRecords` — a different, complementary path).

---

## Runtime posture (constraints shared must keep)

shared is load-time runtime-agnostic: fetch/setTimeout/console only at load; node-only islands are
isolated behind subpath exports (`filecoin/car-builder/node`, `chain-secured`). Known landmines to
avoid when extending:

- `process.env` reads must stay inside functions (never module scope) and be host-guarded
  (`rendering/helpers.ts:23` reads `process.env.S2S_RUNNER_URL` at call time — ReferenceError in a
  Vite browser bundle if that path is ever reached).
- `NodeJS.ProcessEnv` in a public `.d.ts` forces `@types/node` onto browser consumers
  (`shared/src/rpc.ts:41`).
- **ethers v5 (shared) vs v6 (safe-app)** — routing shared author-flow code into safe-app keeps
  two ethers copies alive; be deliberate about which side signs.
- shared `dist` is gitignored and built on demand — safe-app/binary won't see new shared code
  until shared is rebuilt.

---

## Pending / pointers

- **safe-app init-batch component** — AD-3 flow, not yet built. Needs the publication-name/identity
  discovery for a module-less Safe (ENS reverse lookup vs. a name field in the component).
- **SafeAppsSDK / transaction-service L1 proposer** — AD-5 mechanism, not yet built.
- **Binary** — AD-1/AD-4, future ticket ("alternative to neutralpress, as a binary"). Its node
  `TxRunner` (permissionless) is written fresh, not lifted from `0xobsidian`.
- **ENS alias contenthash writes** — `RFC-ens-alias-multiwrite.md`.
- **`TxRunner` finer split** (connection / signer-lifecycle / read / write with executed-vs-queued
  semantics) — identified as prerequisite if safe-app drives shared orchestration directly; under
  the blank-slate principle, do not build a universal abstraction unless a second host needs it.
