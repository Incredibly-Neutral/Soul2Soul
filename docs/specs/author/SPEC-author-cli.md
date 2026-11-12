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
> **Multiple authors (2026-11-05, joera direction):** "cli should hold multiple authors — `author
> new` / `author switch`, store pk + safe + pet name, switch by pet name". One install used to mean
> one identity (`S2S_PRIVATE_KEY` / config `privateKey`); the store below makes identities
> addressable and switches them with one command.
>
> **Nested config layers (2026-11-05, joera direction):** "config should be a schema of services, not
> a flat key list — a person is asked, per service, bring your own or take the default". The config
> file became one nested shape over five layers (env > project > custom > legacy > defaults) with
> dotted keys, `s2s setup` as the guided pass, and `privateKey` out of the registry (the author store
> owns it; a file copy still resolves, deprecated). See
> [Config file](#config-file-bring-your-own-infra).
>
> **The author contracts are installed by the CLI (2026-11-06):** the drafts module, the owner
> history module and its guard are deployed on Base, and putting them on an author Safe is this
> binary's job — `author new` installs after the key is filed, `author init` is the recovery path.
> See [Installing the author contracts](#installing-the-author-contracts).
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

Top-level bin `s2s`; four groups: `author` (content actions on an existing
publication), `publication` (publication lifecycle), `config` (CLI settings), and `setup` (the
guided first-run pass over those settings — see [Config file](#config-file-bring-your-own-infra)).
The `signer` group is the fifth: a key that joins a Safe it did not create —
[SPEC-author-signers](SPEC-author-signers.md).

```
s2s author new       <pet-name> [--key <0x…> | --mnemonic <words>] [--json]                      # add an author identity (activates it; installs the author contracts)
s2s author switch    <pet-name> [--json]                                                          # make a stored author the active one
s2s author list      [--json]                                                                     # stored authors, active one marked, pending swaps flagged
s2s author rm        <pet-name> [--force] [--json]                                                  # forget a stored author
s2s author address   [--json]                                                                     # author id: the Safe (predicted, no deployment)
s2s author init      [--json]                                                                     # deploy the Safe + install the author contracts (idempotent)
s2s author upload    <note> [--publication <ens>] [--allow-plaintext] [--json]                    # ipfs + pins only (off-chain)
s2s author propose   <note> [--cid <cid>] [--publication <ens>] [--allow-plaintext] [--json]  # on-chain offer only
s2s author preview   <note> [--publication <ens>] [--allow-plaintext] [--json]                    # ipfs + preview render (off-chain)
s2s author publish   <note> [--publication <ens>] [--allow-plaintext] [--json]                    # all-in-one: upload + offer + render + pins
s2s author revoke    <note> [--publication <ens>] [--json]                                        # on-chain retract + remove re-render
s2s publication new  <name> --repo <owner/repo> [--branch <b>] [--author <addr>...] [--owner <addr>...] [--json]
s2s setup            [--accept-defaults] [--json]                                               # guided first-run config: keep the defaults or paste your own
s2s config set       <key> <value> [--local] [--json]                                             # write a config value
s2s config get       <key> [--json]                                                               # effective value for a key
s2s config unset     <key> [--local] [--json]                                                     # remove a key from the file
s2s config list      [--json]                                                                     # all effective values (secrets masked)
s2s config path      [--local] [--json]                                                           # print every config file location
```

The **upload ↔ propose split**: `upload` signs, uploads to Kubo, fires the pinning
legs, and writes `genesis`/`author` back — but **never writes to the chain**. `author`
in that frontmatter is the **author Safe** as a bare `0x…` address, not the signing EOA — the same
value the signed item carries in `public.author`, so note and item cannot drift;
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
| `--allow-plaintext` | Accept a plaintext write the encryption downgrade guard refuses: the note says `encrypted: false` while the previous revision of the same identity (`genesis`, else `content_id`) was encrypted, could not be read to check, or cannot even be located because the frontmatter records no `cid`. It skips only that guard — offer's "note says `encrypted: true`, anchored item is plaintext" refusal and its refusal of a stored body that is not JSON ciphertext still apply. | upload, offer, preview, publish |
| `--repo <owner/repo>` | Dev repository of the publication — required. | publication new |
| `--branch <b>` | Default render branch; empty string when omitted. | publication new |
| `--author <addr>,...` | Initial author whitelist; defaults to the **author Safe** (`s2s author address`) — never the EOA. Repeatable (or comma-separated). | publication new |
| `--owner <addr>,...` | Publication Safe owner; repeatable (or comma-separated). | publication new |
| `--local` | Target the project config file (`.s2sconfig.json`) instead of the custom one (`~/.config/s2s/custom.json`). | config set, unset, path |
| `--accept-defaults` | `setup`: ask nothing, write nothing, keep every provided default (the no-TTY path). | setup |
| `--owner <addr>,...` | (new) Initial Safe owners; defaults to empty (single initial signer). |
| `--key <0x…>` | (author new) Private key to store. Without it the key is read from stdin when stdin is not a TTY (`echo 0x… \| s2s author new zomi`); with neither, a fresh phrase is generated (see below). |
| `--mnemonic <words>` | (author new) BIP39 phrase to restore from — the key is derived at `m/44'/60'/0'/0/0`. A piped line that is not a single `0x…` word is read as a phrase too. |

### Config file (bring-your-own infra)

The `config` group writes a JSON config file that supplies any setting the env surface can — the
"bring your own infra" answer: point the CLI at your own Kubo, your own pinning, your own RPC.
No private key or RPC endpoint is required to run it: it is dispatched by `cli.ts` **before**
`buildContext`, so you can configure the CLI from a completely unprovisioned machine.

**The same nested shape in every layer**, differing only in precedence. A layer carries only what
it sets; nothing is ever copied down into a file:

| Layer | Location | Written by |
|---|---|---|
| env | process env + `~/.config/s2s/.env`, `./.env` (`lib/env.ts`, mode `0600` for the user one) | by hand |
| project | `./.s2sconfig.json` (cwd) | `s2s config set --local` |
| custom | `~/.config/s2s/custom.json` (`XDG_CONFIG_HOME` honored, mode `0600`) | `s2s setup`, `s2s config set` (default) |
| legacy | `~/.config/s2s/config.json` (`XDG_CONFIG_HOME` honored) | **nothing** — read-only fallback |
| defaults | `defaults.json`, shipped next to the binary; `S2S_DEFAULTS_FILE` overrides the path | the package |
| builtin | `BUILTIN_FILE_CONFIG` in `core/configschema.ts` | the source |

The order is **env > project > custom > legacy > defaults > builtin**, and `core/config.ts` is the
only merger — every command reads its settings through one `loadConfig()`. The builtin floor is
what makes "no configuration at all" a working state (public IPFS gateway, public Filecoin RPC,
`prod`). A missing or unreadable defaults file is not an error: the floor alone still yields a
usable config.

The nested shape, one section per service:

```json
{ "environment": "prod",
  "pinning": { "pinata": { "provider": "pinata", "key": "…", "url": "gateway.example" } },
  "ipfs":    { "kubo":   { "provider": "kubo",   "url": "gw.example", "key": "…" } },
  "rpc":     { "drpc": { "key": "…" }, "custom": { "l1": ["…"], "l2": ["…"] } },
  "bundler": { "url": "…" },
  "paymaster": { "key": "…", "url": "…" },
  "filecoin":  { "chain": "mainnet", "rpcUrl": "…", "sessionKeyFile": "…" },
  "safeTx": { "url": "https://safe-transaction-base.safe.global", "key": "…" },
  "lit": { "accountKey": "…", "usageKey": "…" }, "ens": { "registry": "0x…" },
  "github": { "token": "…" } }
```

- **Sections are services**, not flat keys, because a machine owner is asked one question per
  service: bring your own, or accept the provided default. `pinning` and `ipfs` are **label maps**
  — an operator may pin to several providers and read through several gateways at once — while
  `paymaster`, `bundler`, `filecoin`, `lit`, `ens`, `github` are singletons (`rpc` is a singleton
  holding the named key providers).
- **Merge rules differ by kind.** A label entry merges **field by field** while the provider stays
  the same: a custom `ipfs.kubo.key` keeps the lower layer's `url`, and a lone `ipfs.kubo.url`
  keeps the lower `key` — a token for a gateway you did not restate is exactly the case that
  matters, and `ipfs.<label>.url` / `.key` are independently optional. The same holds for
  `pinning.<label>`: an absent field is **omitted**, never blanked, so
  `config set pinning.pinata.url …` keeps the JWT the layer below supplies. Naming a **different**
  provider replaces the entry whole (a Kubo token means nothing to a pinning service); provider
  identity is the *only* isolation rule, and a credential is inherited within a provider, never
  across one. A singleton merges field by field (a custom `paymaster.key` keeps the default
  `paymaster.url`); a list is **replaced**, never concatenated. Entries are copied, never aliased,
  so one `loadConfig` call's env can never leak into the next.
- **Two ERC-4337 endpoints, two leaves.** `bundler.url` is the bundler and `paymaster.url` the
  paymaster; a Pimlico key derives **both** (`https://api.pimlico.io/v2/<chainId>/rpc?apikey=<key>`,
  the same URL for the two roles, which is how Pimlico exposes them). Each URL is its own escape
  hatch, resolved independently: `bundlerUrl = bundler.url ?? pimlico`,
  `paymasterUrl = paymaster.url ?? pimlico`. An explicit bundler with no key therefore means
  **no sponsorship** (`paymasterUrl` undefined, the userOp runs unsponsored) — never "call the
  bundler as if it were a paymaster" — and an explicit paymaster URL never moves the bundler. The
  legacy flat keys map to their own leaves (`bundlerUrl` → `bundler.url`, `paymasterUrl` →
  `paymaster.url`), not onto one shared path.
- **Keys are dotted paths** into that shape, one-for-one with the registry in `core/configschema.ts`
  — `s2s config set pinning.pinata.key <jwt>`, `s2s config set rpc.custom.l1 https://a,https://b`,
  `s2s config unset paymaster.key --local`. A map key is `*` in a registry path and concrete on the
  command line (`ipfs.kubo.url`). `s2s config list` shows the resolved set, `s2s config get <path>`
  one leaf; `s2s config path` prints the four file locations (custom, project, legacy, defaults)
  plus the two env-file paths, so a caller can see where each layer lives on this machine.
- **Secrets are masked** in `get`/`list` output (`maskSecret`), and a URL that carries a
  credential is masked per value — `https://api.pimlico.io/v2/1/rpc?apikey=********`, the endpoint
  stays readable. That applies to the label-map URLs too (`pinning.<label>.url`,
  `ipfs.<label>.url`), so a gateway carrying `?token=` is masked in `get`, in `list` and in the
  `setup` wizard's `[source: value]` preview. An empty leaf is **not** masked (there is nothing to
  hide, and `********` for it would invent a credential). `set --local` warns when either kind
  lands in the project file — commit risk; keep secrets in the custom file or gitignore
  `.s2sconfig.json`. List keys (`rpc.custom.l1`, `rpc.custom.l2`) accept comma-separated values and
  are stored as JSON arrays; enum keys (`environment`, `filecoin.chain`) are validated on write.
- **`entryPoint` has no file home.** It is `S2S_ENTRY_POINT` + the builtin `0.7` and nothing else:
  a value in a file would be written and never read, so `config set entryPoint` / `unset` is a usage
  error naming the env var, while `config get entryPoint` still resolves (the merge is the same one,
  `ENV_ONLY_FIELDS` in `core/configschema.ts`).
- **`config unset` writes a tombstone when a delete would not take.** Removing a leaf from the
  target file only changes the answer if that file held it; when the value would come straight back
  from a layer the user cannot edit (the legacy file, `defaults.json`, the compiled-in floor) the
  write is an explicit `null` instead, which the merge reads as "unset" and applies above every file
  layer and below the env (a file cannot silence an env var). The result says so:
  `tombstone: true`. A marker is per leaf and per layer: a real value in a *higher* file beats a
  marker below it, and a marker on a label does not wipe a sibling the higher layer sets.
- **A tombstone only suppresses layers BELOW it, so `unset` refuses to write one when a HIGHER
  layer wins.** If the winning source is the env, or the project file while the target is the
  custom one, a `null` in the target would change nothing while the result claimed the value was
  gone — for a secret that is a false "I removed it". The command warns naming that layer and the
  edit that would work (`unset S2S_GITHUB_TOKEN` here, or `s2s config unset <path> --local` in the
  project file), writes no marker, and reports `suppliedBy: 'env' | 'project'`. A duplicate the
  target itself holds is still deleted (that delete cannot touch a higher layer). Same rule as
  `unset privateKey`, and it never creates a file just to say "nothing to do".
- **No path segment may be `__proto__`, `prototype` or `constructor`.** They are rejected as a
  label (so `config set ipfs.__proto__.url …` is a usage error, not a write to
  `Object.prototype`), and the path walkers only follow own properties.
- **`privateKey` is not a key of this surface.** A signing key has one on-disk home (`authors.json`, the
  author store), one override surface (`S2S_PRIVATE_KEY`), and is created by `s2s author new` /
  picked by `s2s author switch`. `s2s config set privateKey …` is a usage error naming those two
  commands — a key in a committed `.s2sconfig.json` is a leak waiting for a `git add`, and written to
  the custom file it would silently lose to the active stored author anyway.
- **A file-layer `privateKey` still resolves — deprecated, below the store.** Installs that predate
  the store kept the key in `config.json` (or `.s2sconfig.json`); they must keep signing. So
  `core/config.ts` honours it as the last resort: `S2S_PRIVATE_KEY` > project file > active stored
  author > custom file > legacy file. `CliConfig.author.source` still reports `'env'` / `'project'` /
  `'store'` / `'user'` exactly as before — the two user-owned files both report `'user'` — and when
  the winning key came from a file, one stderr warning names that file and the removal:
  `s2s config unset privateKey [--local]` for the writable layers, hand-delete for the legacy file.
  It is printed **once per file per process**; env and store keys are silent.
- **`config unset privateKey` works, and must.** It is the reverse of the fallback: it removes the
  key from the target file (custom, or the project file with `--local`), writes nothing when the key
  is not there (an unset never creates an empty file), and reports a copy in the read-only legacy
  file by path rather than pretending the install is clean. Result shape: `{ action: 'config.unset',
  key: 'privateKey', file, local }`.
- **Read-only derived keys** are accepted by `get`/`list` but never stored: `eoa` (the signing
  account, derived from the key locally — no RPC), `author` (the active stored author's pet name,
  `null` when the key came from env or a file) and `safe` (that author's recorded Safe, `null` when
  it has not been predicted yet). The **author id is not the EOA**: it is the author Safe
  (`s2s author address`), counterfactual and therefore needing an L2 read.

### `s2s setup` (the first-run wizard)

`config set` is the durable, scriptable way to set one value; `setup` is the guided pass for
someone who does not know which keys exist yet. It walks the services in a fixed order — **pinning,
ipfs, rpc, paymaster, filecoin** — and for each asks one question showing the value that is in
effect *and where it comes from* (`custom: pi…abcd`, `legacy: …`, `defaults: …`, `builtin: …`,
`unset`). Enter keeps it; pasting replaces it.

- **It asks about pinning, ipfs, rpc, paymaster and filecoin only.** Never `lit` or `ens` (fixed
  protocol values that ship in `defaults.json`), never `github` (resolved at publish time), never
  `privateKey` (the author store's job).
- **It writes one file: the custom layer.** Pasted values go to `~/.config/s2s/custom.json`; the
  project file is never a wizard output (a project file is a deliberate override, not something
  dropped in the current directory), and defaults are never copied — accepting a default writes
  nothing. When a value lives under a map label, the implied `provider` is written alongside it so
  the custom entry reads on its own (the merge would fill it from the label either way). The
  `[source: value]` marker comes from the same resolution the rest of the CLI uses
  (`configValueSource`), so a value in the read-only legacy file reports `legacy`, not `custom`.
- **`--accept-defaults` asks nothing and writes nothing.** It is the answer for "I only wanted to
  see it": every provided default is kept, nothing is asked, outcome is silent — and it needs no
  TTY. A run on a non-interactive stdin (a pipe, CI, the editor plugin) without that flag does not
  block either: it warns that there is no terminal and keeps every default.
- **No key, no RPC, no bundler needed** — dispatched before `buildContext`, like the `config`
  group. Result: `{ action: 'setup'; written: string[]; kept: string[] }` (registry paths, so a
  script can see exactly what landed and what was left), with the human summary on stdout and
  progress on stderr.

### The author store (several identities)

One install holds many authors. `~/.config/s2s/authors.json` (`XDG_CONFIG_HOME` honored; a blank
value falls back to `~/.config`) is written mode `0600`, atomically (tmp + rename, the same write
`core/configfile.ts` uses):

```json
{ "active": "zomi",
  "authors": { "zomi": { "privateKey": "0x…", "safe": "0x…", "contracts": { … } },
               "work": { "privateKey": "0x…", "safe": null } } }
```

- **Pet name** is the key of an insertion-ordered map. Shape
  `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`, max 64 chars. Names are unique **case-insensitively** (`Zomi`
  is refused when `zomi` exists), and one private key belongs to exactly one pet name — the same
  identity under two names would be two rows that can never diverge.
- **`active`** names the author whose key the CLI signs with. `null` — or a name that is no longer
  in the file — means no stored author is active.
- **`author new` activates** the author it creates: adding an identity is a switch. A duplicate
  name or a key already filed under another name is a usage error.
- **No key given → generate a phrase.** `s2s author new zomi` with no `--key`, no `--mnemonic` and
  nothing piped on stdin generates a 12-word BIP39 phrase (128 bits) and derives the key at
  `m/44'/60'/0'/0/0`: the common intent is "give me an identity", not "I have a key to file", and a
  phrase is what a person writes down and any wallet imports. **The store keeps the derived key,
  not the phrase** — the env layer, the project config and every signing path speak keys, so a
  phrase there would be a second secret protecting the same thing. The phrase is echoed once (a
  `mnemonic :` line in the human result; `mnemonic` plus the derived `privateKey` in `--json`,
  because a script may want either to back up) and is otherwise only in the store, which is 0600.
  Restoring from an existing phrase is the mirror case: `--mnemonic "word …"`, or pipe the words
  and they are told from a hex key by shape. A key or phrase the caller supplied is never echoed
  back — it is already theirs.
- **`author rm`** of the active author moves `active` to the first remaining author (file order), or
  to `null` when the store empties. Removing a non-active author leaves `active` alone. An unknown
  name is a usage error listing the known ones. A row a pending `signer rotate` depends on — the row
  such a replacement names, and the pending row itself — is refused with `rotation_pending` and a
  message naming `signer rotate`, because either row may be the only stored copy of a key that owns
  the Safe (the old one) or that the queued swap adds (the new one); `--force` removes it anyway,
  for a swap that can no longer execute, and warns that the chain is then the only record of who
  owns what. See [SPEC-author-signers](SPEC-author-signers.md).
- **Precedence for the signing key:** `S2S_PRIVATE_KEY` env > project config `privateKey` > active
  author's key > `privateKey` in a config file > undefined. The store therefore sits *above* the
  custom file (a deliberate `author switch` must beat a leftover default) and *below* the env and
  project layers. The two file layers still resolve but are **deprecated** — see
  [Config file](#config-file-bring-your-own-infra) for the one-time warning and removal.
  `CliConfig.author` reports which layer won, with the pet name and the stored Safe only for the
  store layer.
- **The env shadows the store, loudly.** When `S2S_PRIVATE_KEY` is set and the active stored author
  holds a different key, `buildContext` warns on stderr — `S2S_PRIVATE_KEY overrides active author
  'zomi'` — because a shell export silently overriding `author switch` is invisible in every
  result otherwise. stderr only: stdout still carries exactly one document.
- **Safe derivation and write-back.** `author new` writes the record first, with `safe: null`, then
  predicts the author Safe for the key it was given (same `s2s_${eoa}` salt as `author address`) and
  writes that back. The order is deliberate: prediction is a network read, and an interrupted or
  slow one must not cost the key the user just pasted. The endpoint comes from
  `buildRpcEndpoints(config).L2[0]` — the same DRPC → public → Alchemy → Infura chain every other
  author path uses, *not* the explicit `rpc.custom.l2` list, which is usually empty. A failed read (or the
  genuinely empty list) leaves `safe: null` and warns instead of failing: the key is the
  irreplaceable part, the Safe is re-derivable. `author address` and `author init` write the Safe back when the
  signing key came from the store and the stored value is missing or different, so `author list`
  and `author switch` can report the identity offline (no RPC, no bundler).
- **`contracts`** — optional, per author: the addresses the install produced (drafts proxy,
  owner-history proxy, guard). Absent on an author filed before the contracts existed;
  `s2s author init` fills it. It records what was installed, it does not prove adoption — adoption
  is the Safe's own guard slot, see
  [Installing the author contracts](#installing-the-author-contracts).
- **No context needed.** The four store actions are dispatched by `cli.ts` *before* `buildContext`
  (the `config` group's contract): no private key, no RPC, no bundler, no Lit keys. Every other
  `author` action still builds a context.

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
reproduced deliberately. `author init` is idempotent, deploys the Safe when it is not live, and
installs the author contracts on it
([below](#installing-the-author-contracts)); `author new` does the same inline, after the key is
filed. Both steps need an L2 RPC; `init` also
needs an ERC-4337 endpoint: `S2S_PIMLICO_KEY` (what the plugin stores as
`pimlico_key`) is enough — the per-chain Pimlico URL is derived and doubles as
bundler and paymaster. `S2S_BUNDLER_URL` / `S2S_PAYMASTER_URL` (or
`config set bundler.url` / `paymaster.url`) remain as escape hatches for a
different bundler and a different paymaster, independently: an explicit bundler
with no key means the userOp runs **unsponsored**, not that the bundler is also
the paymaster.

The env files exist because **the CLI ships to people who do not have this
repo**: `~/.config/s2s/.env` is the primary configuration surface for an
installed CLI, and `./.env` is an optional per-project refinement (a project may
pin its own publication or key without touching the global file). Both are
loaded once at startup by `loadEnvFiles()` (`src/lib/env.ts`).

**Precedence** (git-style, env is the 12-factor escape hatch; most specific wins):

```
real env vars > ./.env > ~/.config/s2s/.env
              > project (.s2sconfig.json) > custom (custom.json) > legacy (config.json)
              > defaults.json > builtin floor
```

Within the env layer, a key is only filled from a file when it is unset (or
blank) at every higher level, so nothing below can shadow a shell export. Values
that a file supplies therefore behave exactly like exported ones for
`loadConfig()`, which reads `process.env` only. `XDG_CONFIG_HOME` is honored for
both the env file and the config files, and a blank `XDG_CONFIG_HOME` falls back
to `~/.config`. The layers and their merge rules are in
[Config file](#config-file-bring-your-own-infra).

Examples:

```sh
s2s setup                                              # guided: keep the defaults or paste your own
s2s config set ipfs.kubo.url http://127.0.0.1:5001      # bring your own Kubo
s2s config set rpc.custom.l1 http://my-l1.example,http://fallback  # comma lists allowed
s2s config set lit.usageKey … --json                    # stored 0600, masked on read
s2s config set environment dev
s2s config get ipfs.kubo.url      # prints the *effective* value (env may win)
s2s config list --json            # full effective surface, secrets masked
```

Keys marked `secret` in the registry (`pinning.*.key`, `ipfs.*.key`,
`rpc.*.key`, `paymaster.key`, `lit.*Key`, `github.token`) are **masked** in
`get`/`list` output, and `set --local` warns when a secret lands in the project
file (commit risk — keep secrets in the custom file or gitignore
`.s2sconfig.json`). Leaves marked `url` (`rpc.custom.*`, `bundler.url`,
`paymaster.url`, `filecoin.rpcUrl`, `pinning.*.url`, `ipfs.*.url`) are masked
per **value** instead: a query-string credential becomes `********` and the
endpoint stays readable — and the `--local` warning covers them too. The signing
key is not among them: it belongs to the author store (`s2s author new`), and
`config set privateKey` is refused.

### Installing the author contracts

The author contracts are deployed once on Base — `src/author/contracts`, from
`scripts/deploy-author-contracts.ts` — and the **per-Safe install is this binary's job**. `author
new` runs it after the key is filed (always after, so no network failure can lose the key);
`author init` is the recovery and idempotent path for an author that already exists, e.g. a key
filed before the contracts were deployed.

| contract | address (Base, `prod`) |
|---|---|
| `DraftsModuleV1` (implementation) | `0x6e8fCDc4a229E55bf76Ec3A73F0fAbFBe0ce7aE6` |
| `OwnerHistoryModuleV1` (implementation) | `0xD8303A7Ca8637794279865bf74723cD0fCEE4112` |
| `AuthorContractsFactory` | `0xbf394ea4e984D473cAFE094a27B88aeaeD788d6A` |

That table is a record of the deploy, not the authority: the factory is selected by the
`contracts.authorFactory` config key (`S2S_AUTHOR_CONTRACTS_FACTORY`), so an environment can point
at its own copy, and both implementations are whatever that factory reports.

Both commands run the same sequence, in order:

1. **Predict the Safe, deploy it if it is not deployed.** `author init` on a live Safe sends
   nothing for this step.
2. **Read the guard the Safe carries, and prove it is ours.** The guard slot is the only thing
   only the Safe can write, so it — not the factory index — decides what is installed:
   `getStorageAt(safe, 0x4a204f…34c8)` → `G`, then `G.module()` → `M`, `G.safe() == safe`,
   `M.safe() == safe`. All three are immutables, so the proof needs no factory to agree and survives
   `contracts.authorFactory` pointing somewhere else. A guard that survives it is the install; the
   run reports `already` and sends nothing, whatever the permissionless index has accumulated since.
   If the drafts proxy is missing while the guard is proven, that one step still runs, because
   `already` with no drafts proxy would leave it missing for ever.
3. **Nothing in the slot:** `createDraftsModule(safe)` and `createOwnerHistoryModule(safe)` on the
   factory, for the entries the index lacks. Both are permissionless (`createDraftsModule` /
   `createOwnerHistoryModule` in [SPEC-author-drafts](SPEC-author-drafts.md) and
   [SPEC-author-owner-history](SPEC-author-owner-history.md)) — anyone can add an entry for any
   Safe — so the index is read as "what still needs creating", never as evidence of an install.
4. **One Safe self-call, `setGuard(guard)`**, with the guard `createOwnerHistoryModule` returned.

**A sent userOp is not an install.** `genericTx` resolves with a transaction hash that may have
reverted (`setGuard` reverts `GS300` on a guard that does not answer ERC-165), so every send is
followed by a re-read of the state it was supposed to change, and only a changed read counts.
`installed` and `already` therefore both mean *the guard is on the Safe*, read back; `pending-safe`
means it is not.

Only the guard needs a Safe transaction: the drafts proxy's gate is `msg.sender == safe`, so the
Safe sends `append` to the proxy directly and there is nothing to install for it.

**`enableModule` is never called on an author Safe.** An enabled module can call
`execTransactionFromModule`, i.e. execute anything as the Safe; `setGuard` is `onlySelf`, the guard
calls a permissionless `sync()`, and every read is a view call — so no module powers are needed and
none are granted.

**Idempotency, and what a second or a blocked run says.** A second run of either command reports
`already` for every step that is in place and sends nothing. On a **multisig** author Safe one CLI
key cannot complete the install — `setGuard` is a Safe transaction — so the factory calls still run
and the command stops at `pending-safe`, printing the `to` and `data` for the owners to propose.

Three other cases are also `pending-safe`, and each says which one it is in `note`: a guard this
package did not install is in the slot (never overwritten, and no `safeTx` is printed for it — there
is no call here that is safe to make); a submitted userOp has not shown up in the reads yet; or a
send is done but its re-read is unchanged, i.e. it may have reverted. A guard read that fails on the
network is not a foreign guard: the read is retried/propagated and the run says it could not look,
because naming a healthy author's guard foreign would tell its owner to remove it. A Safe with no
code yet after the deploy attempt is `skipped`, and nothing is sent to it.

**Nothing here can cost the key.** Any install failure degrades to a warning naming
`s2s author init`: the key and the Safe stay in the store, and the commands are re-runnable. The
addresses are recorded in the author row's `contracts` field when — and only when — the run ends
`installed` or `already`, i.e. when the guard is really on the Safe; the chain stays the truth and
the row is only what saves a read.

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
// The install block on every result that runs it. Always present, so a script
// never has to tell "absent" from "skipped".
Contracts = { factory: string | null; drafts: string | null; ownerHistory: string | null;
  guard: string | null; state: 'installed' | 'already' | 'pending-safe' | 'skipped';
  txs: string[];                      // transaction hashes, in send order (empty when nothing was sent)
  note?: string;                      // why not installed / what the owners must do
  safeTx?: { to: string; data: string } }   // `pending-safe` only: the setGuard call

// s2s author new <pet-name> [--key <0x…>] [--json] — file an identity, activate it, install the contracts
{ action: 'author.new'; name: string; eoa: string; safe: string | null;
  active: true; file: string; contracts: Contracts }   // no salt: it is `s2s_` + eoa, nothing to record

// s2s author switch <pet-name> [--json] — make a stored author active
{ action: 'author.switch'; name: string; eoa: string; safe: string | null; file: string }

// s2s author list [--json] — stored authors, active one marked
{ action: 'author.list'; active: string | null;
  authors: { name: string; eoa: string | null; safe: string | null; active: boolean;
             ownership: 'owner' | 'pending';   // 'pending' = filed by `signer rotate`
             replaces?: string }[] }           // the row it intends to replace

// s2s author rm <pet-name> [--json] — forget an author
{ action: 'author.rm'; name: string; file: string; active: string | null }

// s2s author address [--json]      — the author id (Safe), predicted; no tx
{ action: 'author.address'; address: string; eoa: string; salt: string;
  chain: 'base'; deployed: boolean;
  author: string | null }         // pet name when the key came from the store

// s2s author init [--json]         — deploy the Safe and install the author contracts (idempotent)
{ action: 'author.init'; address: string; eoa: string; salt: string;
  chain: 'base'; deployed: boolean; txHash: string | null;
  contracts: Contracts;            // see above
  author: string | null }

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
| `frontmatterWritten` | True when upload changed the note's frontmatter (`genesis`/`author`/`creation_date` on first publish, `cid`, `modified_date` and `encrypted` always). |

`ipfsUrl`/`gatewayUrl` are **additive scalars** on `upload` alone — existing keys are unchanged, so
hosts that read the result as an open shape need no change: the Neovim plugin formats known fields,
passes unknown scalars through and never rejects extras (SPEC-nvim-s2s decision 6, with a
future-shaped fixture in its test seams). Both links come from `lib/ipfs-link.ts`, where the gateway
is one constant (`IPFS_GATEWAY_BASE`) — serving them from the configured `ipfs.kubo.url` instead of
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
// s2s setup [--accept-defaults] [--json]  — guided first-run config
{ action: 'setup'; written: string[]; kept: string[] }   // dotted registry paths

// s2s config set <path> <value> [--local] [--json]
{ action: 'config.set'; key: string; file: string; local: boolean }

// s2s config get <key> [--json]        — value is the *effective* value (env may win); null when unset
{ key: string; value: string | null }   // secrets masked; `eoa` is derived, not stored

// s2s config unset <key> [--local] [--json]   — the only removal path for a stranded `privateKey`
{ action: 'config.unset'; key: string; file: string; local: boolean; tombstone?: true;
  suppliedBy?: 'env' | 'project' }   // set instead of `tombstone` when a higher layer wins

// s2s config list [--json]             — all effective values; secrets masked
{ config: Record<string, unknown> }      // plus the derived `eoa`/`author`/`safe` when they resolve
                                        // (unresolved derived keys are omitted, not null)

// s2s config path [--local] [--json]
{ path: string; local: boolean;
  files: { custom: string; project: string; legacy: string; defaults: string };
  env: { user: string; userExists: boolean; project: string | null } }
```

`path` is the file `set`/`unset` would write (`--local` → the project file); `files` reports every
layer's location, and `env` the two env-file locations, so a caller can see where credentials are
expected. `config set privateKey …` is a usage error (exit 2) pointing at `s2s author new` /
`s2s author switch`; `config unset privateKey` is the supported removal for a key left in a file.

Config keys are dotted paths into the nested shape (see above); precedence is
env > project file > custom file > legacy file > defaults > builtin, and `--local` targets
`./.s2sconfig.json`.

## Environment surface

`.env` files are loaded by the entrypoint (`loadEnvFiles()`, `src/lib/env.ts`) before config
resolution, in the order `./.env` then `~/.config/s2s/.env`, each filling only keys that are
still unset. Real environment variables always win. The user-level file is the primary surface
for an installed CLI — a user has no repo `.env` — and `$XDG_CONFIG_HOME` is honored. All
settings flow through `loadConfig()` into a single `CliConfig` (`src/core/config.ts`), which
merges the env layer over the file layers (see **Config file** above). The table
lists the env names; every one is also settable in a config file as a dotted path
(`s2s config set <path>`), listed by `s2s config list`.

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
| `S2S_RPC_L1` / `S2S_RPC_L2` | — | fallback chain | Explicit comma-separated L1/L2 RPC lists. Set **both** ⇒ they replace the derived chains; one alone heads its own chain and keeps the failover behind it. |
| `MAINNET_RPC_URL` / `BASE_RPC_URL` | — | fallback chain | Not aliases of the two above: they take the head of their own chain (the DRPC slot of shared `buildFallbackRpcs`), so an explicit endpoint never costs the Alchemy/Infura/public fallbacks. |
| `S2S_ENS_REGISTRY` | — | protocolInfo | Override the ENS OpenSubdomainRegistry address. |
| `S2S_FILECOIN_CHAIN` | filecoin | `mainnet` | `mainnet` or `calibration`. |
| `S2S_FILECOIN_RPC` | filecoin | `https://api.node.glif.io/rpc/v1` | Filecoin JSON-RPC. |
| `S2S_FILECOIN_SESSION_KEY` | filecoin (protocol-payer) | — | Path to a `session-key.json`. Mutually exclusive with private key. |
| `S2S_FILECOIN_PRIVATE_KEY` | filecoin (direct) | — | Direct Filecoin signer key. Mutually exclusive with session key. |
| `S2S_PIMLICO_KEY` | `new`, `author init` | — | Pimlico API key — the only value stored. Endpoints are derived per chain: `https://api.pimlico.io/v2/<chainId>/rpc?apikey=<key>`, serving bundler *and* paymaster. |
| `S2S_BUNDLER_URL` | `new`, `author init` (optional) | — | Escape hatch (`bundler.url`): explicit bundler RPC, overriding the derived Pimlico URL. On its own — no Pimlico key, no `paymaster.url` — it means **no sponsorship** (`paymasterUrl` undefined), never "reuse the bundler URL as the paymaster". |
| `S2S_PAYMASTER_URL` | (optional) | — | Escape hatch (`paymaster.url`): explicit paymaster RPC, overriding the Pimlico one. Never moves the bundler. |
| `S2S_ENTRY_POINT` | `new` (override) | `0.7` | EntryPoint version the bundler serves (`0.6`/`0.7`). Not free: it selects the Safe4337Module in each Safe's initializer, so it is part of the Safe's address. Keep `0.7` to match the plugin; `new` warns when overridden. |
| `S2S_SAFE_TX_URL` | `signer add`/`rotate`/`queue`/`confirm` | `https://safe-transaction-base.safe.global` | Safe Transaction Service base URL (`safeTx.url`). Unset on a `dev` deployment means those commands refuse with a usage error rather than fetching a relative URL. |
| `S2S_SAFE_TX_API_KEY` | — (optional) | — | Service API key (`safeTx.key`, secret, masked on read), sent as `Authorization: Bearer`. The public host answers unauthenticated and rate-limits instead. |
| `S2S_ENV` | — | `prod` | `dev` → dev protocol gateways/factories + dev Lit. |

## Architecture (blank-slate host)

```
src/
  cli.ts            top-level dispatch (s2s <group> <action>), json/help/version, error envelope
  lib/              args parser, command spec, errors, output contract, frontmatter write-back
  core/             configschema (the nested shape + field registry), config (the merger), configfile (config-file IO), defaults (the shipped layer — S2S_DEFAULTS_FILE seam), authors (the multi-identity store), context (clients), service, author write/revoke, encrypt seam
  adapters/         signer (viem EOA), tx-runner (EOA + permissionless Safe), safe-tx (Safe Transaction Service + the signed struct), ipfs, lit, rpc, filecoin
  commands/         upload / propose / preview / publish / revoke (author), new / switch / list / rm (author store), new (publication), config set/get/unset/list/path, setup
```

Reused from shared (only): `parseMarkdownNote`, `extractFrontmatter`, `buildSignedContentItem`,
`noOpEncrypt`, `renderwithLitActions`, `revokedPathFor`, `runFilecoinLeg`,
`toPreviewLabel`, `resolvePublicationSafe`, `resolvePublicationModules`, `subdomainOf`,
`newPublicationSafe` + `buildNewPublicationDeps`, `S2SPublication`, `TxRunner`, `buildFallbackRpcs`,
the protocol generated ABIs, and `toBytes32Id`.

Written fresh (nothing imported from neutralpress/0xobsidian):

- **EOA signer** (`adapters/signer.ts`) — viem `privateKeyToAccount`, EIP-712 typed signing for
  `buildSignedContentItem` (`proof.signer` = the EOA, `public.author` = the author Safe's bare
  address).
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
- **Identity everywhere else** — the item's `public.author`, frontmatter `author`, the render action's
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
- **Encrypted notes** (`encrypted: true` in the frontmatter, or no `encrypted`/`encryption` key at all —
  encryption is the default write, AUTHOR-2; plaintext is the stated opt-out `encrypted: false`. The
  legacy `encryption` spelling is still read): `core/encrypt.ts buildEncryptFn`
  returns a Lit encryptor bound to `ctx.protocolInfo.pkp` with `LIT_USAGE_KEY`; shared's
  `buildSignedContentItem` calls it **after signing, before upload**. That order is safe because the
  signature covers `plaintextHash`, not the body: `plaintextHash` is the keccak of the JCS-canonical
  body — `jcs` over `{title, slug, content, custom}` (`shared/src/identity/sign-content.ts:54`) —
  fixed in `publicPart` before the EIP-712 signature (`:51-99`), so a ciphertext body still
  satisfies the commitment. The signed item carries `encryption: true`; a note that opts out with
  `encrypted: false` keeps `noOpEncrypt`, so the body is that canonical JSON in the clear. A note
  with neither key is **not** an opt-out: `resolveEncryption` returns `true`, so a missing
  `LIT_USAGE_KEY` or `protocolInfo.pkp` fails the write as a `UsageError` instead of publishing the
  body in the clear because a flag was absent. The stored body sits under a
  key holder's name in the item's `bodies` map — `buildSignedContentItem` writes the `s2s` entry for
  the press — and a reader resolves it with `bodyForKey(item)` rather than by field. Four checks at
  three call sites, in this order, all before any IPFS or chain side effect: `buildEncryptFn`
  resolves the credentials (`author.ts:109` → `encrypt.ts:240`) and a missing or empty
  `LIT_USAGE_KEY`/`protocolInfo.pkp` is a `UsageError`; the downgrade guard runs next
  (`author.ts:112`), so on a plaintext note it has already decided before anything is signed; then
  the write signs and encrypts (`author.ts:154` → `encrypt.ts:254`). `assertCiphertext` carries two of
  the checks in its single call: Lit's swallowed error strings are rejected instead of published, and
  an encryptor that echoes the plaintext back (directly, as a JSON string, or re-serialised) is
  refused rather than publishing the body in the clear under a lying `encryption: true`. It also
  meets the read path's shape: `decrypt.ts:36` does `JSON.parse(body.content)` before handing the
  value to `Lit.Actions.Decrypt`, and the first live run showed `Lit.Actions.Encrypt` returns bare
  base64 with no `dataToEncryptHash`, so a result that is not already JSON text is stored wrapped
  (`JSON.stringify`) — the parse then yields exactly the bytes Lit returned, and the read path needs
  no change. A stored body that is not JSON text was therefore written by something else, and
  `storedBodyIsDecryptable` refuses to offer it. The downgrade guard keys on the identity, `genesis` else `content_id`
  (`author.ts:386`; legacy `content_id`-only notes are covered), and refuses three states, each with
  its own message: the previous item is encrypted (restore `encrypted: true`, or
  `--allow-plaintext`); the previous revision cannot be read, cause-classified — a recorded CID that
  does not resolve gets "fix or remove the stale `cid`", while a timeout or a gateway fault gets
  "re-run …, or pass `--allow-plaintext`", so that first remedy does not name the flag; and an
  identity with no recorded `cid`, where nothing can be checked at all, also a `UsageError`
  naming the flag. No silent plaintext fallback. Whether `Lit.Actions.Decrypt` accepts a bare base64
  ciphertext without its `dataToEncryptHash` is unverified: the encrypt action returns the ciphertext
  only, so the writer has no hash to store. If a read fails to decrypt, the fix is in that action
  (`src/shared/src/lit/actions/encrypt.ts`), which must return the hash the decrypt call needs.
  Reading an encrypted note still has to pass the action's `canRead` gate
  (`protocol/actions/src/libs/gates.ts`: `canPublish(authorSafe)` + `isOwner(signer)` +
  `hasDeal(genesis)`) inside `decryptRaw`, so an author preview renders empty/revoked until a deal
  exists for the note.
- **The label**: frontmatter `label` is a short public name for the manuscript. `parseMarkdownNote`
  fills `ParsedNote.label`, trimmed, with a blank or non-string value resolving to `null` (no label,
  so a displayer falls back to the genesis id). It is a protocol key, not template data, so it stays
  out of the shared `custom` bag, where it would be signed into the body. `author.ts` passes it on as
  `label: parsed.label ?? undefined`, so a non-blank label is written onto the stored public part
  and a `null` writes no key at all. It is unsigned there: it rides on the public part and no
  signature covers it (ADR-003). The tool never writes it back — the frontmatter name is the
  author's. A note whose frontmatter already carried `label` signed it into the body's `custom`;
  the key is stripped now, so the next publish signs a different body and that version's objectId
  differs.
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
  It also writes `encrypted`: the encryption state **that publish actually used**, taken from the
  flag that drove the encryptor rather than from a second read of the file, and written on every
  publish — not only when absent — so the note always states what the last publish did and editing
  the key changes the next one. The value is a real YAML boolean (`encrypted: true` /
  `encrypted: false`), never a quoted string: `'false'` is truthy under `Boolean()`, so a quoted
  value would silently encrypt a note its author meant to publish in the clear. Reading resolves
  `encrypted` first, then the legacy `encryption` spelling (`lib/frontmatter.ts resolveEncryption`,
  the same read-then-rename precedent as `cid`/`kubo_cid`); neither key present means **encrypted**,
  and a key present but blank (`encrypted:`) means `false`, the author's opt-out; the legacy key is
  deleted on the next
  write-back, so a migrated note carries one key and no stale one. The published item's own field is
  unchanged: it stays `encryption: boolean` on `S2SContentItem`. Like `cid`, the key is a protocol
  key, not template data — it is stripped from the `custom` bag before signing, because shared's
  `KNOWN_FRONTMATTER_KEYS` predates the new name and would otherwise sign the flag into the body's
  `custom`. The read side is otherwise untouched: `Boolean(frontmatter.encryption)` in
  `shared/src/authoring/note.ts` still means a note carrying the string `'false'` encrypts, and the
  write-back's `true` then makes the file truthful.
  `propose` re-resolves the note's on-chain identity (`genesis`, else `content_id`) and sends
  the `makeOffer(objectId, cid)` for `--cid` if given, else the stored `cid`; it
  expects `upload` to have run first (no identity — `genesis` or `content_id` — or no CID and no
  `--cid`, → usage error pointing at `s2s author upload`). When the note says `encrypted: true`,
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
  (so they round-trip as strings rather than re-parsing as numbers). `encrypted` is the one boolean
  written back, so it stays unquoted (`upsertFrontmatter` takes `string | boolean` and `Document.set`
  emits a YAML boolean). Both are documented caveats.
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
- **The build resolves its own paths**: `esbuild.config.mjs` takes entry, outfile and the
  `defaults.json` copy from `buildPaths(dirname(import.meta.url))` (`esbuild.paths.mjs`), because
  esbuild resolves relative paths against the *process cwd* — `pnpm --filter … build` and a build
  started from the repo root must land in the same `dist/`, not in `./dist` of whatever directory
  the caller happened to be in.

## Test seams

`pnpm test` (vitest, node env) covers the pure parts: arg parsing (`booleanFlags` never consuming
the next token, value flags, `--`, `-h`), env config defaults/overrides/aliases, `requireSetting`,
`saltNonceFor` (determinism, top-bit-cleared range), `upsertFrontmatter` (upsert, body
preservation, hex quoting), the config-file layer (field-registry coverage, the full
`env > project > custom > legacy > defaults > builtin` precedence matrix against temp dirs, the
`S2S_DEFAULTS_FILE` seam, per-provider field-by-field label merging vs whole-entry replacement on a
provider change, unset tombstones (a marker beating a lower layer, losing to a higher one, and never
silencing the env), the path seams (`userConfigPath`/`projectConfigPath`/`legacyConfigPath`/
`defaultsPath` pin the whole set, and `XDG_CONFIG_HOME` moves the standard locations themselves),
list/enum normalization, file round-trip, secret and URL-credential masking), the bundle's
script-relative paths (`test/esbuild-paths.test.ts`: entry/outfile/defaults derive from the script
directory, never cwd), the `privateKey` file fallback (env and store still
win; one stderr warning per file; `config unset privateKey` removing it, refusing to create an empty
file, and naming a copy left in the legacy file), `s2s setup` (`--accept-defaults` writing nothing
on a non-TTY, pasted values landing only in `custom.json`, never asking about lit/ens/github/
privateKey), and the author store
(`test/authors.test.ts`: file round-trip at mode 0600, XDG path resolution, tolerant reads of
missing/corrupt/malformed files, pet-name validation and case-insensitive uniqueness, one key one
name, switch, active-slot reassignment on `rm`, Safe write-back, the `env > project > store > user`
precedence matrix against temp dirs).

The store commands are tested at two levels: their `run(out, args)` functions directly (with
`XDG_CONFIG_HOME` pointed at a temp dir and `fetch` stubbed, so no real store and no network), and
the `authorStoreCommands` / `findAuthorStoreCommand` table that `cli.ts` dispatches from — it is
imported from `commands/author-store.ts` precisely so a test can reach it without the content
command graph (which drags in the ESM-only Filecoin adapter and will not load under vitest). What
is *not* unit-tested is the dispatch itself: `cli.ts` running a store action before `buildContext`,
per-action `--help`, and the one-document `--json` envelope at that level are covered by the hand
smoke-tests below, because importing `cli.ts` pulls the same graph.

Every test that loads a config passes its own file paths (`userConfigPath`, `projectConfigPath`,
`legacyConfigPath`, `defaultsPath`, `authorsPath`) or points `XDG_CONFIG_HOME` at a temp dir, so no
test reads or writes the developer's real `~/.config/s2s`. Gate:
`pnpm build` = `tsc -noEmit` + esbuild; eslint strict (`--max-warnings 0`) over `src/` and `test/`.

## Live execution notes

Hand smoke-tests that pass in this environment: bare invocation, `--version`, all four help
levels (top, author, publication, config), unknown group/action (exit 2), missing settings (exit
1), and the `--json` error envelope — all clean, with stdout carrying exactly one JSON document.
The `config` group runs with a completely empty environment (no private key, no RPC) — verified
with `env -i`. End-to-end authoring against live RPCs requires the full env surface (private key,
Lit keys, Kubo, bundler) and is the manual-acceptance step.
