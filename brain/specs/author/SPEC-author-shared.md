# SPEC-author-shared — the authoring seam in `shared`

> **Parent:** [SPEC-author](../SPEC-author.md) — the authoring front door. Canonical catalog:
> [SPEC-shared](../SPEC-shared.md) (this file does not repeat it — it describes the *seam* the
> authoring hosts import through).
>
> **Type:** seam spec. It exists because "authoring" is the one thing every host does and no host
> owns: the pure half lives in `shared`, and the rule for what may enter that half is the load-bearing
> part.
>
> **Audited against live code:** 2026-10-29.

---

## Responsibility

`shared` holds the **pure orchestration and primitives** for authoring: note parsing, tag → publication
resolution, signed-content building, revoke-path derivation, publication-safe deployment sequencing,
the render orchestrator, and the injected-dependency interfaces. It holds **no** runtime adapters —
no env, no key handling, no chain client, no process, no filesystem. Each host supplies those.

The `authoring/` module (`shared/src/authoring/`, added 2026-10-18 with the binary) is the host-agnostic
core of that: it was extracted so `neutralpress` and `author-cli` stop carrying separate copies of the
same note/tag/revoke logic.

## The `authoring/` module

| file | role | consumers |
|---|---|---|
| `note.ts` | `parseMarkdownNote` — frontmatter + body → `{ title, slug, objectId, publicContent, toEncrypt }` | neutralpress, author-cli |
| `tags.ts` | `--s2s` publication tags in frontmatter → target publication | neutralpress, author-cli |
| `links.ts` | publication/site link derivation from resolved config | author-cli (lint/validate paths) |
| `revoke.ts` | `revokedPathFor` + the locale-prefix fallback | neutralpress (revoke), author-cli |
| `publication.ts` | `resolvePublicationSafe` / `resolvePublicationModules` / `subdomainOf` — ENS name → Safe, module sniffing | all hosts |

Reachability rule: `authoring/` is exported **only** from the root barrel (`shared/src/index.ts:8`)
and deliberately **not** from `./lit-actions` — it pulls `yaml`/`marked`/`slugify`, and the action
entry must stay runtime-free and zod-free (INV-7). Verify against the resolved action bundle, not
the import list, when adding anything here.

## Entry points (the wrong import is a wrong bundle)

| import path | what an authoring host gets | who |
|---|---|---|
| `@s2s/soul2soul-shared` | everything, including `authoring/`, identity, rendering, publication, ABIs | neutralpress, 0xobsidian (esbuild), author-cli (esbuild) |
| `@s2s/soul2soul-shared/safe-app` | `getProtocolInfo`, `LitService`, types, `cid-view/`, `ConfigBuilder`/`AssetsBuilder`, `S2SIPFSMethods` | safe-app (Vite) |
| `@s2s/soul2soul-shared/lit-actions` | types + ABIs only | protocol actions |
| `@s2s/soul2soul-shared/rendering/action-io` | zod runtime schemas | one action (`render`) |

## What each host actually imports

- **`0xobsidian`** — `LitService`, the type catalog (`S2SContentInfo`, `S2SPublicationConfig`,
  `S2SRipple`, `S2STemplateConfig`), Lens helpers, content types. It is an opaque dependency supplier
  to the rest: `shared` treats it as `any` at the `createTxRunner(oxo, chain)` seam
  ([SPEC-author-hosts](./SPEC-author-hosts.md) AD-1).
- **`neutralpress`** — `getProtocolInfo`, `renderwithLitActions`, `pinCidFromRemote`,
  `postToLens`/`updateToLens`, content types, `runFilecoinLeg`, `newPublicationSafe` +
  `buildNewPublicationDeps`, `createL1Runner`/`createL2Runner`.
- **`author-cli`** — `parseMarkdownNote`, `extractFrontmatter`, `buildSignedContentItem`, `noOpEncrypt`,
  `renderwithLitActions`, `revokedPathFor`, `runFilecoinLeg`, `toDidEthr`, `toPreviewLabel`,
  `resolvePublicationSafe`, `resolvePublicationModules`, `subdomainOf`, `newPublicationSafe` +
  `buildNewPublicationDeps`, `S2SPublication`, `TxRunner`, `buildFallbackRpcs`, the generated ABIs,
  `toBytes32Id`. Nothing else — the blank-slate rule forbids importing `neutralpress`/`0xobsidian`
  internals, and the CLI writes its own node adapters.
- **`safe-app`** — read-only surface (`/safe-app` entry): protocol info, types, cid-view, IPFS methods,
  config/assets builders.

## The injected-dependency seams

Authoring is parameterized by narrow interfaces, never by concrete clients:

| seam | shape | hosts supply |
|---|---|---|
| `TxRunner` | read/write tx dispatch, `createL1Runner`/`createL2Runner` bridge | oxo EOA runner, Pimlico Safe runner, SafeAppsSDK proposer |
| `TypedDataSigner` | EIP-712 signing for `buildSignedContentItem` | viem account, oxo signer, (safe-app: none — it proposes) |
| `S2SIPFSMethods` | add/cat/dag + `backupToProviders` + `runFilecoinLeg(onFailure)` | kubo clients per runtime |
| `FilecoinCarBuilder` | browser/node subpath split | safe-app browser builder, node builder in the CLI |
| `LitService` | Chipotle REST client + usage keys | shared, constructed by the host with its own env |

**Extension rule (blank-slate, AD-2):** do not grow a universal host abstraction until a *second*
host needs it. The binary was written as a fresh adapter set on purpose; reuse-everything made the
design worse, and the existing seams are the whole permitted surface.

## Gotchas

- **`@filoz/synapse-sdk`** (transitive via the Filecoin module) has no `exports`/`main`, which node ESM
  resolution rejects. Fine under esbuild (bundled) and node CJS; **any vitest test that imports the
  Filecoin adapter fails to load**. Keep Filecoin-free logic in its own module so unrelated tests never
  pull that graph (this is why the CLI isolates frontmatter writes in `src/lib/frontmatter.ts`).
- **`parseMarkdownNote` uses the filename as the fallback title** and slugifies it. Pass the
  **basename**, not an absolute path, or the slug becomes the path with `/` stripped
  (`/home/…/whitepaper-author.md` → `homejoerawhitepaperauthor`) and that becomes the rendered path.
- **`res.path` from the render pipeline is already root-absolute** (`/1-introduction/`). Join, do not
  concatenate, when building preview/prod URLs.
- **`runFilecoinLeg` fails open by design** — an unresolvable publication degrades to a warning, so an
  upload never fails on the durability leg. Do not "fix" that into a throw without checking the hosts.
- **`authoring/` is not the identity layer.** Signing lives in `shared/src/identity/`
  (`jcs`, `sign-content`, `verify-content`, `contract-id`); the `authoring/` module never signs.
