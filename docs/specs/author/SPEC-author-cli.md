# SPEC-author-cli — the headless authoring binary (`s2s author`)

> **Parent:** [SPEC-author](SPEC-author.md) — the authoring front door. Host siblings:
> [SPEC-author-nvim](SPEC-author-nvim.md) and [SPEC-author-vscode](SPEC-author-vscode.md) (the
> editor wrappers built against this spec's Binary API reference).
>
> **Type:** host specification — describes the `@s2s/author-cli` workspace package, the *headless
> binary* host from [SPEC-author-hosts](SPEC-author-hosts.md) AD-1/AD-4. Implemented 2026-10-18.
>
> **Status:** IMPLEMENTED (scaffold + compile-clean + pure-part tests). Live-chain paths are
> exercised by hand only — see [Live execution notes](#live-execution-notes).
>
> **Origin:** joera direction on the SPEC-author-hosts binary ticket; command structure mandated as
> `s2s author <action>` with `--json` machine output for the Neovim plugin.
>
> **Blank-slate rule (SPEC-author-hosts):** this package reuses **only** what already lives in
> `@s2s/soul2soul-shared`. It never imports `neutralpress`/`0xobsidian` internals; every runtime
> adapter is written fresh for node.

---

## The one-paragraph model

`s2s author <action>` is a node CLI that drives the same author flows neutralpress drives in the
Obsidian plugin — **upload, preview, publish, revoke** — plus **new** (fresh full publication
creation, which the other two hosts cannot express, SPEC-author-hosts AD-4). All pure orchestration lives
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
s2s author address   [--json]                                                                     # author id: the Safe (predicted, no deployment)
s2s author init      [--json]                                                                     # deploy the author Safe (idempotent)
s2s author upload    <note> [--publication <ens>] [--allow-plaintext] [--json]                    # ipfs + pins only (off-chain)
s2s author propose   <note> [--cid <cid>] [--publication <ens>] [--allow-plaintext] [--json]  # on-chain offer only
s2s author preview   <note> [--publication <ens>] [--allow-plaintext] [--json]                    # ipfs + preview render (off-chain)
s2s author publish   <note> [--publication <ens>] [--allow-plaintext] [--json]                    # all-in-one: upload + offer + render + pins
s2s author revoke    <note> [--publication <ens>] [--json]                                        # on-chain retract + remove re-render
s2s publication new  <name> --repo <owner/repo> [--branch <b>] [--author <addr>...] [--owner <addr>...] [--json]
s2s config set       <key> <value> [--local] [--json]                                             # write a config value
s2s config get       <key> [--json]                                                               # effective value for a key
s2s config unset     <key> [--local] [--json]                                                     # remove a key from the file
s2s config list      [--json]                                                                     # all effective values (secrets masked)
s2s config path      [--local] [--json]                                                           # print the config file path
```

The **upload ↔ propose split**: `upload` signs, uploads to Kubo, fires the pinning
legs, and writes `genesis`/`author` back — but **never writes to the chain**. `author`
in that frontmatter is the **author Safe** as a bare `0x…` address (the `did:ethr:` form is the
signed item's, not the note's), not the signing EOA;
`author` sits inside the EIP-712 signing view, so it is part of `genesis`. The on-chain
`makeOffer` is the separate **`propose`** step, which takes the `cid` that `upload`
reported (`--cid`) and the note's stable on-chain identity (frontmatter `genesis`, else
`content_id`, mirroring neutralpress' revoke genesis resolution). `upload` also writes the
CID it just produced into the frontmatter as `cid`, so `propose` works with no flags
after an upload; `--cid` overrides. `publish` remains the
one-shot convenience that does upload + propose + prod render + pins together.

**`upload` does not resolve the publication on-chain.** The publication contributes only its
name (the `subdomain` label of the ENS name, derived locally), so an upload succeeds for a
publication that has not been created yet or whose ENS name has no address record. Only
`propose` / `publish` / `revoke` (and the Filecoin durability leg) resolve the Safe and its
modules. The Filecoin leg is the one deferred lookup: it runs after the pins, and a
publication it cannot resolve degrades to a warning rather than failing the upload.

Flags parse anywhere in the argv, and each action declares its own (see
`src/commands/*.ts`; shared ones in `src/commands/flags.ts`). Only these three are global:

| Flag | Meaning |
|---|---|
| `--json` | Emit the final result as JSON on stdout (Neovim contract). Always boolean — never consumes a value token. `--json=false` / `--no-json` mean human output. |
| `-h`, `--help` | Help for the current level (`s2s`, `s2s author`, `s2s author <action>`). The action level is rendered from that action's flag declaration. |
| `--version` | Print `s2s v<version>` and exit 0. |

Everything else is per-action, and an undeclared flag is a **usage error (exit 2)**, not a
silent no-op:

| Flag | Meaning | Declared by |
|---|---|---|
| `--publication <ens>` | Target publication ENS (`name.soul2soul.eth`). Defaults to the first `--s2s` publication tag in the note's frontmatter. | upload, offer, preview, publish, revoke |
| `--cid <cid>` | Explicit content CID. Defaults to the `cid` the last `upload` wrote to the note's frontmatter; a usage error if neither is present. | offer |
| `--allow-plaintext` | Accept a plaintext write the encryption downgrade guard refuses: the note says `encryption: false` while the previous revision of the same identity (`genesis`, else `content_id`) was encrypted, could not be read to check, or cannot even be located because the frontmatter records no `cid`. It skips only that guard — offer's "note says `encryption: true`, anchored item is plaintext" refusal and `assertCiphertext` validation still apply. | upload, offer, preview, publish |
| `--repo <owner/repo>` | Dev repository of the publication — required. | publication new |
| `--branch <b>` | Default render branch; empty string when omitted. | publication new |
| `--author <addr>,...` | Initial author whitelist; defaults to the **author Safe** (`s2s author address`) — never the EOA. Repeatable (or comma-separated). | publication new |
| `--owner <addr>,...` | Publication Safe owner; repeatable (or comma-separated). | publication new |
| `--local` | Target the project config file (`.s2sconfig.json`) instead of the user config. | config set, unset, path |
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
| user env file | `~/.config/s2s/.env` (`XDG_CONFIG_HOME` honored) | by hand, mode `0600` |
| project env file | `./.env` (cwd, optional) | by hand |

Keys are the flat camelCase forms of the env vars (`kuboGateway`, `rpcL1`,
`privateKey`, … — `s2s config list` shows the full set). Read-only derived keys are also accepted by `config get`:
`eoa` (the signing account, computed from `privateKey` locally — no RPC). Note that the
**author id is not the EOA**: it is the author Safe (`s2s author address`), which is
counterfactual and therefore needs an L2 read. List keys (`rpcL1`,
`rpcL2`) accept comma-separated values and are stored as JSON arrays. Enum keys
(`environment`, `filecoinChain`, `entryPoint`) are validated on write.

### The author identity: a counterfactual Safe

`upload` signs with the EOA, but the manuscript's owner — the author id written
into the signed item — is the **Safe** that the EOA owns, exactly as in
0xobsidian/neutralpress (`user.safe`). Its address is counterfactual, so it can
be quoted before anything is deployed:

```
salt      = "s2s_" + eoa
saltNonce = keccak256(salt)                 # unmasked, no chain id in the salt
Safe      = SafeL2 v1.4.1, owners [eoa], threshold 1, EntryPoint v0.7
            singleton 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
            factory   0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
```

Because the salt excludes the chain, the same author has one address on L1 and
L2. The Safe is deployed on Base on first use (`s2s author init`) and left
undeployed on mainnet until a publication needs it — the plugin's asymmetry,
reproduced deliberately. `author init` is idempotent and is where modules get
installed later; today it only deploys. Both steps need an L2 RPC; `init` also
needs an ERC-4337 endpoint: `S2S_PIMLICO_KEY` (what the plugin stores as
`pimlico_key`) is enough — the per-chain Pimlico URL is derived and doubles as
bundler and paymaster. `S2S_BUNDLER_URL` / `S2S_PAYMASTER_URL` remain as
escape hatches for a different bundler.

The env files exist because **the CLI ships to people who do not have this
repo**: `~/.config/s2s/.env` is the primary configuration surface for an
installed CLI, and `./.env` is an optional per-project refinement (a project may
pin its own publication or key without touching the global file). Both are
loaded once at startup by `loadEnvFiles()` (`src/lib/env.ts`).

**Precedence** (git-style, env is the 12-factor escape hatch; most specific wins):

```
real env vars > ./.env > ~/.config/s2s/.env > project config > user config > defaults
```

Within the env layer, a key is only filled from a file when it is unset (or
blank) at every higher level, so nothing below can shadow a shell export. Values
that a file supplies therefore behave exactly like exported ones for
`loadConfig()`, which reads `process.env` only. `XDG_CONFIG_HOME` is honored for
both the env file and the config file, and a blank `XDG_CONFIG_HOME` falls back
to `~/.config`.

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
| `2` | Usage error (unknown group/action, unknown flag, missing argument, missing required flag, missing flag value). |

## Neovim JSON contract (the stdout/stderr split)

- **stdout** carries exactly one document: the final result. In `--json` mode it is a JSON object;
  in human mode it is a short summary (still one blob, for terminal users).
- **stderr** carries progress logs, warnings, and (in human mode) errors. It is never parsed.
- On failure, stdout in `--json` mode carries a single error envelope, and nothing else:

```json
{ "schemaVersion": 1, "ok": false, "code": "usage", "error": "unknown author action 'bogus'" }
```

Success results are flat, typed objects per action — enumerated exactly in
[Binary API reference](#binary-api-reference-machine-contract) below — wrapped in the same
envelope (`schemaVersion`, `ok: true`, then the action's own fields).

Help/version in `--json` mode are also JSON documents in that envelope
(`{ "schemaVersion": 1, "ok": true, "help": "…" }` / `{ … "name": "s2s", "version": "…" }`).

### Result envelope

Every `--json` document is an envelope, added in one place (`lib/out.ts` for successes,
`cli.ts` for failures) — no command sets these keys itself:

| Key | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | Bumped when the shape of a document changes. Hosts refuse a version they do not know. |
| `ok` | `boolean` | `true` for a result, `false` for a failure. The one field a host can branch on without guessing from `action`. |
| `code` | `string` | Failures only: `usage` (exit 2), `action_failed` (a Lit action ran and failed), `error` (other CLI failure), `internal` (uncaught throw). |

A host must not depend on `error` prose — it is human-readable and changes freely. Branch on
`ok`, `code`, and the action's typed fields.

## Binary API reference (machine contract)

The stable, machine-facing interface of the binary. Hosts (the Neovim plugin, scripts)
build against **this section only**. All shapes below are the single JSON document on
stdout when `--json` is passed; field types are TS-style. This is the load-bearing
contract — change it only by deliberate API change, and update this section in the same
commit.

### Invocation & framing

```
s2s <group> <action> [positionals…] [flags…]
```

- Flags parse **anywhere** in the argv; `--flag value` and `--flag=value` both work;
  `-h` is an alias of `--help`; `--` stops flag parsing (the rest are positionals).
- Each action declares its own flags (`src/commands/*.ts`), and parsing is **strict**: an
  unknown flag is a usage error (exit 2) naming the nearest declared one, and a string flag
  with no value is a usage error too. Flags are **not** interchangeable between actions.
- `--json` is **always boolean** — it never consumes the next token; `--json=false` and
  `--no-json` mean human output. Booleans in general accept `--no-<flag>`.
- A `repeatable` flag (`--author`, `--owner` on `publication new`) accumulates; repeating it is
  the same as passing a comma-separated list.
- `--help` for an action is **derived from that flag declaration**, so it cannot disagree with
  what the parser accepts; there is no hand-written usage string to fall out of date.
- **stdout** carries exactly one document (the JSON result in `--json` mode). **stderr**
  carries human progress (logs, warnings, human-mode errors) — never parsed by hosts.
- Failure in `--json` mode puts a single envelope on stdout and nothing else:

  ```json
  { "schemaVersion": 1, "ok": false, "code": "usage", "error": "unknown author action 'bogus'" }
  ```

- **Exit codes:** `0` success · `1` runtime failure (missing env, RPC/render failure) ·
  `2` usage error (unknown group/action, missing argument, bad flag value).

### Global documents

| Invocation | stdout (`--json`) | exit |
|---|---|---|
| `s2s --version` | `{ "schemaVersion": 1, "ok": true, "name": "s2s", "version": "0.1.0" }` | 0 |
| `s2s` / `s2s --help` | `{ "schemaVersion": 1, "ok": true, "help": "<top help>" }` | 0 |
| `s2s <group> --help` | `{ "schemaVersion": 1, "ok": true, "help": "<group help>" }` | 0 |
| `s2s <group> <action> --help` | `{ …, "ok": true, "help": "<usage + summary + flags>" }` | 0 |
| any failure (`--json`) | `{ "schemaVersion": 1, "ok": false, "code": "<code>", "error": "<msg>" }` | 1 or 2 |

### `author` group — result types

```ts
// s2s author address [--json]      — the author id (Safe), predicted; no tx
{ action: 'author.address'; address: string; eoa: string; salt: string;
  chain: 'base'; deployed: boolean }

// s2s author init [--json]         — deploy the author Safe if not deployed
{ action: 'author.init'; address: string; eoa: string; salt: string;
  chain: 'base'; deployed: boolean; txHash: string | null }

// s2s author upload <note> [--publication <ens>] [--json]     — ipfs + pins only (off-chain)
{ action: 'upload'; note: string; publication: string; subdomain: string;
  objectId: string; cid: string;
  ipfsUrl: string;        // 'ipfs://<cid>'
  gatewayUrl: string;     // 'https://ipfs.io/ipfs/<cid>'
  frontmatterWritten: boolean }          // no txHash

// s2s author propose <note> [--cid <cid>] [--publication <ens>] [--json] — on-chain offer only
{ action: 'propose'; note: string; publication: string; subdomain: string;
  objectId: string; cid: string; txHash: string }

// s2s author preview <note> [--publication <ens>] [--json]    — ipfs + preview render (off-chain)
{ action: 'preview'; note: string; publication: string; subdomain: string;
  objectId: string; cid: string;
  render?: { cid: string; path: string; previewUrl: string } }

// s2s author publish <note> [--publication <ens>] [--json]    — all-in-one: upload + offer + render + pins
{ action: 'publish'; note: string; publication: string; subdomain: string;
  objectId: string; cid: string; txHash: string;
  render?: { cid: string; path: string; previewUrl: string; prodUrl: string } }

// s2s author revoke <note> [--publication <ens>] [--json]     — on-chain retract + remove re-render
{ action: 'revoke'; note: string; publication: string; subdomain: string;
  objectId: string; txHash: string;
  render?: { cid: string; path: string; previewUrl: string } }
```

Shared field meanings:

| Field | Meaning |
|---|---|
| `note` | Path to the note (frontmatter + body). |
| `publication` | Resolved publication ENS (flag, else first `--s2s` frontmatter tag). |
| `subdomain` | Publication subdomain (bytes32 → string via shared `subdomainOf`). |
| `objectId` | Stable on-chain content identity (frontmatter `genesis`, else signed item id). |
| `cid` | Content-addressed CID from Kubo (2-space `JSON.stringify` parity). |
| `ipfsUrl` | (upload only) `ipfs://<cid>` — gateway-agnostic URI, from `ipfsUri` in `lib/ipfs-link.ts`. |
| `gatewayUrl` | (upload only) `https://ipfs.io/ipfs/<cid>` — browser-openable, from `ipfsGatewayUrl`; also the human-mode `link` line under `cid`. |
| `txHash` | L2 transaction hash of the on-chain action. |
| `render` | Render descriptor: `cid` (render CID), `path`, `previewUrl`, `prodUrl`. |
| `frontmatterWritten` | True when upload changed the note's frontmatter (`genesis`/`author`/`creation_date` on first publish, `cid` and `modified_date` always). |

`ipfsUrl`/`gatewayUrl` are **additive scalars** on `upload` alone — existing keys are unchanged, so
hosts that read the result as an open shape need no change: the Neovim plugin formats known fields,
passes unknown scalars through and never rejects extras (SPEC-nvim-s2s decision 6, with a
future-shaped fixture in its test seams). Both links come from `lib/ipfs-link.ts`, where the gateway
is one constant (`IPFS_GATEWAY_BASE`) — serving them from the configured `kuboGateway` instead of
`ipfs.io` is a one-line change there, not a change at any call site.

### `publication` group — result types

```ts
// s2s publication new <name> --repo <owner/repo> [--branch <b>] [--author <a>,…] [--owner <o>,…] [--json]
{ action: 'new'; name: string; safeAddress: string;
  configCid: string | null; owners: string[]; authors: string[];
  devRepository: string; branch: string; feed: string }
```

`feed` is the zero address when Lens feed wiring is not present (current stub).

### `config` group — result types (no private key / RPC required)

```ts
// s2s config set <key> <value> [--local] [--json]
{ action: 'config.set'; key: string; file: string; local: boolean }

// s2s config get <key> [--json]        — value is the *effective* value (env may win); null when unset
{ key: string; value: string | null }   // secrets masked; `eoa` is derived, not stored

// s2s config unset <key> [--local] [--json]
{ action: 'config.unset'; key: string; file: string; local: boolean }

// s2s config list [--json]             — all effective values; secrets masked
{ config: Record<string, string> }       // plus the derived `eoa` when privateKey is set

// s2s config path [--local] [--json]
{ path: string; env: { user: string; userExists: boolean; project: string | null } }
```

`path` is the config file (`--local` → the project file); `env` reports the two
env-file locations so a caller can see where credentials are expected.

Config keys are the flat camelCase forms of the env surface (see below); precedence is
env > project file > user file > defaults; `--local` targets `./.s2sconfig.json`.

## Environment surface

`.env` files are loaded by the entrypoint (`loadEnvFiles()`, `src/lib/env.ts`) before config
resolution, in the order `./.env` then `~/.config/s2s/.env`, each filling only keys that are
still unset. Real environment variables always win. The user-level file is the primary surface
for an installed CLI — a user has no repo `.env` — and `$XDG_CONFIG_HOME` is honored. All
settings flow through `loadConfig()` into a single `CliConfig` (`src/core/config.ts`), which
merges the two config-file layers beneath the env layer (see **Config file** above). The table
lists the env names; every one is also settable via `s2s config set <key>` with a flat camelCase key.

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `S2S_PRIVATE_KEY` | authoring | — | EOA signer key. Signs (EIP-712 content items, `lit actions auth`) and **owns the author Safe** — it is never the on-chain author identity (that is the Safe, INV-10). |
| `LIT_ACCOUNT_KEY` | authoring | — | Lit master/network key (LitService account). |
| `LIT_USAGE_KEY` | render paths; `encryption: true` notes | — | Lit usage key passed to the action runs, and the key the encrypt seam (`core/encrypt.ts`) passes to `LitService.encrypt`. |
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
| `S2S_PIMLICO_KEY` | `new`, `author init` | — | Pimlico API key — the only value stored. Endpoints are derived per chain: `https://api.pimlico.io/v2/<chainId>/rpc?apikey=<key>`, serving bundler *and* paymaster. |
| `S2S_BUNDLER_URL` | `new`, `author init` (optional) | — | Escape hatch: explicit bundler RPC, overriding the derived Pimlico URL. On its own it means no sponsorship. |
| `S2S_PAYMASTER_URL` | (optional) | — | Escape hatch: explicit paymaster RPC, overriding the Pimlico one. |
| `S2S_ENTRY_POINT` | `new` (override) | `0.7` | EntryPoint version the bundler serves (`0.6`/`0.7`). Not free: it selects the Safe4337Module in each Safe's initializer, so it is part of the Safe's address. Keep `0.7` to match the plugin; `new` warns when overridden. |
| `S2S_ENV` | — | `prod` | `dev` → dev protocol gateways/factories + dev Lit. |

## Architecture (blank-slate host)

```
src/
  cli.ts            top-level dispatch (s2s <group> <action>), json/help/version, error envelope
  lib/              args parser, command spec, errors, output contract, frontmatter write-back
  core/             config + configfile (field registry, config-file IO), context (clients), service, author write/revoke, encrypt seam
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
  `buildSignedContentItem` (`proof.signer` = the EOA); DID = `toDidEthr(authorSafe)`.
- **TxRunner ×3** (`adapters/tx-runner.ts`, `core/author-safe.ts`) — a plain EOA runner used for
  **reads** only (genericTx encodes calldata from the protocol ABIs; the EOA runner never sends an
  author write), `createAuthorWriteRunner` (permissionless `toSafeSmartAccount` + Pimlico, pinned
  SafeL2 v1.4.1) for `makeOffer`/`retract` so the author Safe is `msg.sender`, and
  `createSafeRunner` for `new`. `saltNonceFor`
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

- **propose / publish / revoke** — the **author Safe** (`0x7907…`, derived from `s2s_${eoa}`,
  owned by the EOA) is the actor. `makeOffer`/`retract` are ERC-4337 userOps through the bundler,
  so `msg.sender` — and therefore `genesisAuthor` — is the Safe. The EOA is the **signer only**:
  it signs the EIP-712 content item (`proof.signer`), signs `lit actions auth` for the render
  gates (which then check `isOwner(authorSafe, recovered)`), and owns the Safe. Sending an author
  write from the EOA reverts `OnlySafe()` on a genesis's first version and would permanently
  write `genesisAuthor = EOA`, locking the Safe and 0xobsidian out of that document.
  (`upload`/`preview` are **off-chain** — they never touch the chain at all.)
- **Identity everywhere else** — `did:ethr:` author, frontmatter `author`, the render action's
  `authorSafeAddress`, and the Filecoin piece attribution (`[publicationSafe, authorSafe]`) all
  carry the author Safe. `s2s author address`/`config` print the EOA only as the Safe's owner.
- **new** — the Safe is the actor for the deployment sequence: both L1 and L2 Safes are deployed
  with the same salt via `toSafeSmartAccount`; the SafeRunner sends the registerSubdomain (L1),
  module installs (L2), publication module, enableModule×2, config records, and owner-setup userOps
  through the bundler (Pimlico paymaster when configured).

## Flow notes

- **Signed content**: `buildSignedContentItem`; `objectId` = frontmatter `genesis` when present, else
  the signed item's objectId. `genesis` is written back to the note's frontmatter (`upsertFrontmatter`)
  when it was missing. This write path is the missing half of the port: `author.ts:2` calls it the CLI
  port of neutralpress' `publishToPublication`, the step `SPEC-neutralpress.md:73-75` records as never
  wired there — that package publishes plaintext.
- **Encrypted notes** (`encryption: true` in the frontmatter): `core/encrypt.ts buildEncryptFn`
  returns a Lit encryptor bound to `ctx.protocolInfo.pkp` with `LIT_USAGE_KEY`; shared's
  `buildSignedContentItem` calls it **after signing, before upload**. That order is safe because the
  signature covers `plaintextHash`, not the body: `plaintextHash` is the keccak of the JCS-canonical
  body — `jcs` over `{title, slug, content, custom}` (`shared/src/identity/sign-content.ts:54`) —
  fixed in `publicPart` before the EIP-712 signature (`:51-99`), so a ciphertext `.body` still
  satisfies the commitment. The signed item carries `encryption: true`; `encryption: false`/absent
  keeps `noOpEncrypt`, so the body is that canonical JSON in the clear. Four checks at three call
  sites, in this order, all before any IPFS or chain side effect: `buildEncryptFn` resolves the
  credentials (`author.ts:109` → `encrypt.ts:240`) and a missing or empty
  `LIT_USAGE_KEY`/`protocolInfo.pkp` is a `UsageError`; the downgrade guard runs next
  (`author.ts:112`), so on a plaintext note it has already decided before anything is signed; then
  the write signs and encrypts (`author.ts:154` → `encrypt.ts:254`). `assertCiphertext` carries two of
  the checks in its single call: the ciphertext must be JSON text that parses to a non-empty string
  or object — the read path does `JSON.parse(body.content)`
  (`protocol/actions/src/libs/decrypt.ts:36`) — so Lit's swallowed error strings are rejected instead
  of published, and an encryptor that echoes the plaintext back (directly, as a JSON string, or
  re-serialised) is refused rather than publishing the body in the clear under a lying
  `encryption: true`. The downgrade guard keys on the identity, `genesis` else `content_id`
  (`author.ts:386`; legacy `content_id`-only notes are covered), and refuses three states, each with
  its own message: the previous item is encrypted (restore `encryption: true`, or
  `--allow-plaintext`); the previous revision cannot be read, cause-classified — a recorded CID that
  does not resolve gets "fix or remove the stale `cid`", while a timeout or a gateway fault gets
  "re-run …, or pass `--allow-plaintext`", so that first remedy does not name the flag; and an
  identity with no recorded `cid`, where nothing can be checked at all, also a `UsageError`
  naming the flag. No silent plaintext fallback. The code records one open risk in its header: the
  writer's ciphertext shape is inferred from the read path, not from a recorded live `/lit_action`
  encrypt response, so if a live encrypt returns bare base64 the fix belongs on the read path
  (`decrypt.ts:36` must stop assuming `JSON.parse`), not in loosening the writer.
  Reading an encrypted note still has to pass the action's `canRead` gate
  (`protocol/actions/src/libs/gates.ts`: `canPublish(authorSafe)` + `isOwner(signer)` +
  `hasDeal(genesis)`) inside `decryptRaw`, so an author preview renders empty/revoked until a deal
  exists for the note.
- **The split**: `upload` ends at Kubo + pins (no chain tx, so its result carries no `txHash`).
  It never resolves the publication (no ENS → Safe → modules lookup): the signed metadata needs
  only the name label, taken from the ENS name itself. On the **first** write-back it also stamps
  `creation_date`: neutralpress has always filled it on save, the CLI never did, and the real
  first-write time is not recoverable from the file — so an existing note gets the `modified_date`
  it already carried (a lower bound on its age), never `now`. `genesis` stays quoted, because a
  bare 64-hex `0x…` parses as a YAML number.
  It writes `cid` into the frontmatter (the CID of that upload — ephemeral: the next
  upload overwrites it, and it describes the note as of that upload, not current edits).
  `cid` succeeded `kubo_cid`; the old key is still **read** (by `propose`'s fallback and by the
  downgrade guard, both through `resolveKuboCid`) and is **deleted** on the next write-back, so a
  note never carries two CIDs naming different revisions. `cid` is not template data, so it is
  excluded from the shared `custom` bag like every other protocol key.
  `propose` re-resolves the note's on-chain identity (`genesis`, else `content_id`) and sends
  the `makeOffer(objectId, cid)` for `--cid` if given, else the stored `cid`; it
  expects `upload` to have run first (no identity — `genesis` or `content_id` — or no CID and no
  `--cid`, → usage error pointing at `s2s author upload`). When the note says `encryption: true`,
  `propose` also verifies the item it is about to anchor: it fetches that CID and refuses if the
  stored item does not declare `encryption: true`, has no string body, or cannot be read or parsed —
  and the check is on the anchored CID (including `--cid`), not on the frontmatter's `cid`. It
  runs the same downgrade guard as the write path.
- **Render gate**: `authorSafeAddress` = `service.getMultiSig()` (ENS-resolved, like neutralpress);
  signature = `signMessage('lit actions auth')`; `litUsageKey` required; preview → Bun runner,
  publish → Lit nodes; kuboToken passed as Bearer `_ipfsGatewayAuth`.
- **Durability** (upload and publish only, never preview): fire-and-forget
  `backupToProviders` (filebase + pinata) plus the Filecoin leg (`runFilecoinLeg`) with
  `onFilecoinMismatch` CID reporting. The Filecoin leg needs the publication's Safe for the CAR
  recipients, so it resolves the publication lazily inside its own callback — after the Kubo and
  pin work is already done — and reports a warning when the publication cannot be resolved.
- **Revoke**: on-chain `retract` **first** (author-caller full withdrawal), then a remove-plumbing
  re-render so the revoked path stops resolving. Revoke-path derivation honors the real on-chain
  `localePaths` (read via Records `getRecord('config')` → config CID → mapping), falling back to
  the legacy `/${locale}` prefix scheme when the map can't be resolved.
- **new**: requires `--repo` + an ERC-4337 endpoint (`S2S_PIMLICO_KEY`). `createFeed` is a **stub returning the zero
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
