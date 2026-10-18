# SPEC-author-cli — the headless authoring binary (`s2s author`)

> **Type:** host specification — describes the `@s2s/author-cli` workspace package, the *headless
> binary* host from [SPEC-hosts](./SPEC-hosts.md) AD-1/AD-4. Implemented 2026-10-18.
>
> **Status:** IMPLEMENTED (scaffold + compile-clean + pure-part tests). Live-chain paths are
> exercised by hand only — see [Live execution notes](#live-execution-notes).
>
> **Origin:** joera direction on the SPEC-hosts binary ticket; command structure mandated as
> `s2s author <action>` with `--json` machine output for the Neovim plugin.
>
> **Blank-slate rule (SPEC-hosts):** this package reuses **only** what already lives in
> `@s2s/soul2soul-shared`. It never imports `neutralpress`/`0xobsidian` internals; every runtime
> adapter is written fresh for node.

---

## The one-paragraph model

`s2s author <action>` is a node CLI that drives the same author flows neutralpress drives in the
Obsidian plugin — **upload, preview, publish, revoke** — plus **new** (fresh full publication
creation, which the other two hosts cannot express, SPEC-hosts AD-4). All pure orchestration lives
in `@s2s/soul2soul-shared` (the `authoring` module: note parsing, signed-content building, tag →
publication resolution, revoke path derivation, publication-safe deployment sequencing); the CLI
writes only the thin node adapters: a viem EOA signer, a permissionless Safe runner (Pimlico,
all-HTTP), a Kubo client, a LitService, a Filecoin storage client, and the env config. It is built
for the **Neovim plugin**: `--json` puts a single machine-readable JSON document on stdout; human
progress goes to stderr.

## Command surface

Top-level bin `s2s`; three groups: `author` (content actions on an existing
publication), `publication` (publication lifecycle), and `config` (CLI settings).

```
s2s author upload    <note> [--publication <ens>] [--json]        # ipfs + pins only (off-chain)
s2s author propose   <note> --cid <kuboCid> [--publication <ens>] [--json]  # on-chain offer only
s2s author preview   <note> [--publication <ens>] [--json]        # ipfs + preview render (off-chain)
s2s author publish   <note> [--publication <ens>] [--json]        # all-in-one: upload + offer + render + pins
s2s author revoke    <note> [--publication <ens>] [--json]        # on-chain retract + remove re-render
s2s publication new  <name> --repo <owner/repo> [--branch <b>] [--author <addr>...] [--owner <addr>...] [--json]
s2s config set       <key> <value> [--local] [--json]            # write a config value
s2s config get       <key> [--json]                              # effective value for a key
s2s config unset     <key> [--local] [--json]                    # remove a key from the file
s2s config list      [--json]                                    # all effective values (secrets masked)
s2s config path      [--local] [--json]                          # print the config file path
```

The **upload ↔ propose split**: `upload` signs, uploads to Kubo, fires the pinning
legs, and writes `genesis`/`author` back — but **never touches the chain**. The on-chain
`makeOffer` is the separate **`propose`** step, which takes the `kuboCid` that `upload`
reported (`--cid`) and the note's stable on-chain identity (frontmatter `genesis`, else
`content_id`, mirroring neutralpress' revoke genesis resolution). `publish` remains the
one-shot convenience that does upload + propose + prod render + pins together.

Global flags parse anywhere in the argv:

| Flag | Meaning |
|---|---|
| `--json` | Emit the final result as JSON on stdout (Neovim contract). Always boolean — never consumes a value token. |
| `-h`, `--help` | Help for the current level (`s2s`, `s2s author`, `s2s author <action>`). |
| `--version` | Print `s2s v<version>` and exit 0. |
| `--publication <ens>` | Target publication ENS (`name.soul2soul.eth`). Defaults to the first `--s2s` publication tag in the note's frontmatter. |
| `--cid <kuboCid>` | (propose) The content CID reported by `s2s author upload` — required. |
| `--repo <owner/repo>` | (new) Dev repository of the publication — required. |
| `--branch <b>` | (new) Default render branch; empty string when omitted. |
| `--author <addr>,...` | (new) Initial author set; defaults to the EOA address. |
| `--owner <addr>,...` | (new) Initial Safe owners; defaults to empty (single initial signer). |
| `--local` | (config) Target the project config file (`.s2sconfig.json` in cwd) instead of the user config. |

### Config file (bring-your-own infra)

The `config` group writes a JSON config file that supplies any setting the env
surface can. No private key or RPC endpoint is required to run it — it is
dispatched by `cli.ts` **before** `buildContext`, so you can configure the CLI
from a completely unprovisioned machine.

| File | Location | Written by |
|---|---|---|
| user config | `~/.config/s2s/config.json` (`XDG_CONFIG_HOME` honored) | `s2s config set` (default), mode `0600` |
| project config | `./.s2sconfig.json` (cwd) | `s2s config set --local` |

Keys are the flat camelCase forms of the env vars (`kuboGateway`, `rpcL1`,
`privateKey`, … — `s2s config list` shows the full set). List keys (`rpcL1`,
`rpcL2`) accept comma-separated values and are stored as JSON arrays. Enum keys
(`environment`, `filecoinChain`, `entryPoint`) are validated on write.

**Precedence** (git-style, env is the 12-factor escape hatch):

```
env vars (incl. cwd .env) > project config > user config > built-in defaults
```

Examples:

```sh
s2s config set kuboGateway http://127.0.0.1:5001        # bring your own Kubo
s2s config set rpcL1 http://my-l1.example,http://fallback # comma lists allowed
s2s config set privateKey 0x… --json                     # stored 0600, masked on read
s2s config set environment dev
s2s config get kuboGateway        # prints the *effective* value (env may win)
s2s config list --json            # full effective surface, secrets masked
```

Secret keys (`privateKey`, `lit*Key`, `githubToken`, `kuboToken`, `pinataJwt`,
`filebaseToken`, `filecoinPrivateKey`) are **masked** in `get`/`list` output, and
`set --local` warns when a secret lands in the project file (commit risk — keep
secrets in the user config or gitignore `.s2sconfig.json`).

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Runtime failure (missing env, RPC/render failure, …). |
| `2` | Usage error (unknown group/action, missing argument, missing required flag). |

## Neovim JSON contract (the stdout/stderr split)

- **stdout** carries exactly one document: the final result. In `--json` mode it is a JSON object;
  in human mode it is a short summary (still one blob, for terminal users).
- **stderr** carries progress logs, warnings, and (in human mode) errors. It is never parsed.
- On failure, stdout in `--json` mode carries a single error envelope, and nothing else:

```json
{ "ok": false, "error": "unknown author action 'bogus'" }
```

Success results are flat, typed objects per action (see `src/commands/*.ts`):

- `upload`: `{ action, note, publication, subdomain, objectId, kuboCid, frontmatterWritten }` — **no** `txHash` (off-chain).
- `propose`: `{ action, note, publication, subdomain, objectId, kuboCid, txHash }` — the on-chain offer for an already-uploaded CID.
- `preview`: `{ action, note, publication, subdomain, objectId, kuboCid, render: { cid, path, previewUrl } }` — no `txHash`.
- `publish`: `{ action, note, publication, subdomain, objectId, kuboCid, txHash, render: { cid, path, previewUrl, prodUrl } }`
- `revoke`: `{ action, note, publication, subdomain, objectId, txHash, render? }`
- `new`: `{ action, name, safeAddress, configCid, owners, authors, devRepository, branch, feed }`

Help/version in `--json` mode are also JSON (`{ "help": "…" }` / `{ "name": "s2s", "version": "…" }`).

## Environment surface

`.env` in the CWD is loaded by the entrypoint (`dotenv/config`) before config resolution. All
settings flow through `loadConfig()` into a single `CliConfig` (`src/core/config.ts`), which
merges the two config-file layers beneath the env layer (see **Config file** above). The table
lists the env names; every one is also settable via `s2s config set <key>` with a flat camelCase key.

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `S2S_PRIVATE_KEY` | authoring | — | EOA signer key for author flows (the genesisAuthor, INV-10). |
| `LIT_ACCOUNT_KEY` | authoring | — | Lit master/network key (LitService account). |
| `LIT_USAGE_KEY` | render paths | — | Lit usage key passed to the action runs. |
| `GITHUB_TOKEN` / `S2S_GITHUB_TOKEN` | `new` | — | GitHub token for the assets/config build (`ConfigBuilder`). |
| `S2S_KUBO_GATEWAY` | uploads | `ipfs.transport-union.dev` | Kubo RPC gateway. |
| `S2S_KUBO_TOKEN` | token-gated | — | Kubo bearer token (renders use it as `_ipfsGatewayAuth`). |
| `S2S_PINATA_JWT` / `S2S_PINATA_GATEWAY` | backups | — | Pinata pinning leg. |
| `S2S_FILEBASE_TOKEN` | backups | — | Filebase pinning leg. |
| `S2S_RUNNER_URL` | preview | `https://run.transport-union.dev/run` | Lit-action runner (preview renders use the Bun runner). |
| `S2S_RPC_L1` / `S2S_RPC_L2` | — | fallback chain | Explicit comma-separated L1/L2 RPC lists; else `MAINNET_RPC_URL`/`BASE_RPC_URL` (+ DRPC/Alchemy/Infura) via shared `buildFallbackRpcs`. |
| `S2S_ENS_REGISTRY` | — | protocolInfo | Override the ENS OpenSubdomainRegistry address. |
| `S2S_FILECOIN_CHAIN` | filecoin | `mainnet` | `mainnet` or `calibration`. |
| `S2S_FILECOIN_RPC` | filecoin | `https://api.node.glif.io/rpc/v1` | Filecoin JSON-RPC. |
| `S2S_FILECOIN_SESSION_KEY` | filecoin (protocol-payer) | — | Path to a `session-key.json`. Mutually exclusive with private key. |
| `S2S_FILECOIN_PRIVATE_KEY` | filecoin (direct) | — | Direct Filecoin signer key. Mutually exclusive with session key. |
| `S2S_BUNDLER_URL` | `new` | — | Pimlico/ERC-4337 bundler RPC (Safe userOps). |
| `S2S_PAYMASTER_URL` | `new` (optional) | — | Pimlico paymaster (gas sponsorship). |
| `S2S_ENTRY_POINT` | — | `0.6` | EntryPoint version the bundler serves (`0.6`/`0.7`). |
| `S2S_ENV` | — | `prod` | `dev` → dev protocol gateways/factories + dev Lit. |

## Architecture (blank-slate host)

```
src/
  cli.ts            top-level dispatch (s2s <group> <action>), json/help/version, error envelope
  lib/              args parser, command spec, errors, output contract, frontmatter write-back
  core/             config + configfile (field registry, config-file IO), context (clients), service, author write/revoke
  adapters/         signer (viem EOA), tx-runner (EOA + permissionless Safe), ipfs, lit, rpc, filecoin
  commands/         upload / propose / preview / publish / revoke (author), new (publication), config set/get/unset/list/path
```

Reused from shared (only): `parseMarkdownNote`, `extractFrontmatter`, `buildSignedContentItem`,
`noOpEncrypt`, `renderwithLitActions`, `revokedPathFor`, `runFilecoinLeg`, `toDidEthr`,
`toPreviewLabel`, `resolvePublicationSafe`, `resolvePublicationModules`, `subdomainOf`,
`newPublicationSafe` + `buildNewPublicationDeps`, `S2SPublication`, `TxRunner`, `buildFallbackRpcs`,
the protocol generated ABIs, and `toBytes32Id`.

Written fresh (nothing imported from neutralpress/0xobsidian):

- **EOA signer** (`adapters/signer.ts`) — viem `privateKeyToAccount`, EIP-712 typed signing for
  `buildSignedContentItem`; DID = `toDidEthr(eoaAddress)`.
- **TxRunner ×2** (`adapters/tx-runner.ts`) — a plain EOA runner for propose/publish/revoke
  (genericTx encodes calldata from the protocol ABIs and sends a normal L2 tx; `upload`/`preview`
  never touch the chain), and
  `createSafeRunner` (permissionless `toSafeSmartAccount` + Pimlico) for `new`. `saltNonceFor`
  derives a deterministic, top-bit-cleared Safe salt-nonce from a human salt — identical on L1 and
  L2 so the twin Safes land on the same address.
- **Kubo client** (`adapters/ipfs.ts`) — `addToKubo` with **2-space JSON.stringify** (load-bearing
  for CID parity with the Filecoin CAR rootCid).
- **LitService** (`adapters/lit.ts`) + **rpc** (`adapters/rpc.ts`) — render-gate wiring.
- **Filecoin storage** (`adapters/filecoin.ts`) — node `FilecoinStorage` (session-key or direct-key
  path); unconfigured → warn and fail open.
- **PublicationService** (`core/service.ts`) — port of neutralpress' resolution (ENS Safe via
  NameWrapper, module sniffing on L2) over the shared pure resolvers.

### The ETH actor split (AD-1 / INV-10)

- **propose / publish / revoke** — the **EOA** is the actor (genesisAuthor). The Safe is
  *not* the actor for author flows; `makeOffer`/`retract` are sent as plain L2 txs from the EOA.
  (`upload`/`preview` are **off-chain** — they never touch the chain at all.)
- **new** — the Safe is the actor for the deployment sequence: both L1 and L2 Safes are deployed
  with the same salt via `toSafeSmartAccount`; the SafeRunner sends the registerSubdomain (L1),
  module installs (L2), publication module, enableModule×2, config records, and owner-setup userOps
  through the bundler (Pimlico paymaster when configured).

## Flow notes

- **Signed content**: `buildSignedContentItem` + `noOpEncrypt`; `objectId` = frontmatter `genesis`
  when present, else the signed item's objectId. `genesis` is written back to the note's frontmatter
  (`upsertFrontmatter`) when it was missing.
- **The split**: `upload` ends at Kubo + pins (no chain tx, so its result carries no `txHash`).
  `propose` re-resolves the note's on-chain identity (`genesis`, else `content_id`) and sends the
  `makeOffer(objectId, kuboCid)` for the `--cid` it was given; it expects `upload` to have run first
  (genesis must exist, or it errors with a pointer to `s2s author upload`).
- **Render gate**: `authorSafeAddress` = `service.getMultiSig()` (ENS-resolved, like neutralpress);
  signature = `signMessage('lit actions auth')`; `litUsageKey` required; preview → Bun runner,
  publish → Lit nodes; kuboToken passed as Bearer `_ipfsGatewayAuth`.
- **Durability** (upload and publish only, never preview): fire-and-forget
  `backupToProviders` (filebase + pinata) plus the Filecoin leg (`runFilecoinLeg`) with
  `onFilecoinMismatch` CID reporting.
- **Revoke**: on-chain `retract` **first** (author-caller full withdrawal), then a remove-plumbing
  re-render so the revoked path stops resolving. Revoke-path derivation honors the real on-chain
  `localePaths` (read via Records `getRecord('config')` → config CID → mapping), falling back to
  the legacy `/${locale}` prefix scheme when the map can't be resolved.
- **new**: requires `--repo` + `S2S_BUNDLER_URL`. `createFeed` is a **stub returning the zero
  address** — Lens feed creation is not wired headless (see gaps).

## Known gaps / follow-ups

- **Lens feed is not wired** for `new` — `createFeed` returns the zero address. The browser hosts
  talk to a Lens-compatible API with the owner session; a headless equivalent is a follow-up.
- **Frontmatter write-back** re-serializes the whole `---` block via yaml `Document`: existing key
  order and scalar values survive, **comments do not**, and `0x`-looking strings are **quoted**
  (so they round-trip as strings rather than re-parsing as numbers). Both are documented caveats.
- **Live-chain paths** (`upload`/`preview`/`publish`/`revoke`/`new` against real RPCs) are not
  exercised by the automated suite — the dev chain is unreachable here and the full shared suite's
  live-chain `sequence` tests fail pre-session. See below.
- **`@filoz/synapse-sdk`** (pulled transitively by shared's Filecoin module) has no
  `exports`/`main`, which node ESM resolution rejects. It is fine under esbuild (bundled) and under
  node CJS, but **any vitest test that imports the Filecoin adapter fails to load**. The pure
  `upsertFrontmatter` is therefore isolated in `src/lib/frontmatter.ts` so tests never touch that
  graph.
- **Bin linking**: `s2s` is available via `node dist/cli.cjs`; the `bin` symlink appears when a
  package installs `@s2s/author-cli` (nothing depends on it yet).

## Test seams

`pnpm test` (vitest, node env) covers the pure parts: arg parsing (`booleanFlags` never consuming
the next token, value flags, `--`, `-h`), env config defaults/overrides/aliases, `requireSetting`,
`saltNonceFor` (determinism, top-bit-cleared range), `upsertFrontmatter` (upsert, body
preservation, hex quoting), and the config-file layer (field-registry coverage, env > project >
user > default precedence, list/enum normalization, file round-trip, secret masking). Gate:
`pnpm build` = `tsc -noEmit` + esbuild; eslint strict (`--max-warnings 0`) over `src/` and `test/`.

## Live execution notes

Hand smoke-tests that pass in this environment: bare invocation, `--version`, all four help
levels (top, author, publication, config), unknown group/action (exit 2), missing settings (exit
1), and the `--json` error envelope — all clean, with stdout carrying exactly one JSON document.
The `config` group runs with a completely empty environment (no private key, no RPC) — verified
with `env -i`. End-to-end authoring against live RPCs requires the full env surface (private key,
Lit keys, Kubo, bundler) and is the manual-acceptance step.
