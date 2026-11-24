# releases

One section per manifest version, newest first. Versions stay in `0.x` until the protocol
leaves alpha; `1.0.0` is that signal and nothing else, so a release number is never a
scheduling decision. A section accumulates while the version is being
built and is closed when `pnpm update-protocol <version>` pins it: `config/<version>.json` is the
machine record of what that run pinned, this file is the human one.

An entry names the change and then says what a reader gets. The reference is the PR that carried it
(a task is one PR) or, for a mechanical change merged straight to `main`, the commit. Entries are
written when the change lands, not when the version is pinned — the point is to hold the list before
the manifest moves.

A change that needs a deploy step says so in its entry. An action change needs a rebuild and a
release; a contract change needs a Safe batch; a doc or spec change needs neither.

A build under test is pinned as `d.<major>.<minor>` (`d.0.1`) and gets no section here. The manifest
module keeps that lane out of the release order: it is never the live document, so nothing unpinned
reads it, and the next release is judged against the last release rather than against the test.

## 0.1.4 — 2026-11-24

- `render` honors the `unsigned` input: an unsigned run skips only the PKP key read, keeps the
  whole colophon, and uploads the page with the proof options present and no `proofValue`. Absent
  or false keeps the signing attempt.
- `preview` runs the render stage on Lit, the only runtime with `Lit.Actions.Decrypt`, so a gated
  body decrypts; `dev` stays on the runner.
- The manifest advertises `capabilities.unsignedRender`, so the shared layer will run a preview on
  a publication pinned to this build.
- Filing the document moves no publication: each one reads the manifest at its own
  `manifest_version` record, so pinning this build to a publication stays a separate human step.

## 0.1.3 — 2026-11-19

Group `s2s@0.1.3`, id `5`. Batch
`0x509b9e7befde34cfdf110056a7e98a42834238a9e84569387a9c3c547573a1a3` (nonce 723), document
`0x0a9657b191e6dc6fa38b1d86eef8882f6a0616b6ad95e8aff9909b14aced9916` (nonce 724, filed). Tag: the
commit that records the pin in `config/0.1.3.json`.

- `prep`: `QmaqBDoP47Hd4wfSBNneKd5KZZk5D9rNUtsipAMgdvZHxu`
- `render`: `QmUSupjU1h5znM1CwL6TXT8LHyfZfCYpYvGZbP77ah7jKS`
- `update`: `QmXsqXupCwVPDkMrDmrKZrgFFnUa4ERzVm3B41VMZZfy5s`
- `maintain-cache`: `QmVuBSq8RHAy22zzcHpGpmqocPdNvT7vmCVdR3zFcHYTEz`
- `repoint-archive`: `QmR2BDTCR69L7zQEUWWvhPvTYsFT9uupf1P3o5YxKpaFJs`
- `encrypt`: `QmQNnefQsHQoUGyLaGJHMNhTaRtEYGfccejPsQXhJn7Rsh` (unchanged from 0.1.2)
- `decrypt`: `Qmed1FSkLzUJa7sXAyHt3nCn5yVQqvhvBrRB9JLKoq4hQZ`

- `contenthash_wrapped` is normalised to CIDv1, so a reset can no longer write `0xe3010070…`, which
  eth.limo refuses. `evm.test.ts` and `reset.test.ts` pin the bytes and the written value.
  Uncommitted, PR to follow.
- Records already written as `0xe30100…` stay broken until rewritten. `test.soul2soul.eth` has been
  re-rendered and now holds the v1 form of `bafybeifxybv6u74f5l6ucn53oihvirzjm22wri42x54e2jz5zy7ubrktay`,
  a well-formed record that eth.limo still will not serve: the name carries its own resolver,
  `0xF60CBa0C0C13b50C2ce1F83d0C2fb06C9e5AE534`, whose `baseRecordsContract` is the retired
  `0x32D75C02008ABC920D85D9b9058582c7217d1dC3`, so it answers empty for every key. A name with no
  resolver of its own (`s3nl.soul2soul.eth`) inherits the parent wildcard and resolves correctly.
- `update` names an unreachable previous root and no longer reads a refused `pin/add` as success, so
  a tree the node does not hold says so and asks for `reset` (#237).
- `author-cli publish` refuses an author whose append would be an offer, before anything is signed,
  encrypted or pinned, and points at `s2s author offer` (#238).
- `update-protocol` signs and posts the proposal itself, so a refusal prints the service's answer
  with the nonce, target and the proposals queued against it (48df54d, 9498e8f), and it does not
  rebuild a version that is already pinned (5f70b23).
- The document batch names the manifest module as its target; without one it went to the diamond
  (#236).
- safe-app: a deals row shows the render it owes, a failed render returns the row with its reason,
  and the sweep covers offers (#239).
- safe-app: actions on one line, short column headers, and dates read from the v2 shape (#240).

## 0.1.2 — 2026-11-18

Replaces the old naming on the read path: `getDeals` → `getAgreements`, `hasDeal` → `hasAgreement`,
in the action bundles, the archive scripts, `shared`'s out-of-force gate and the safe-app wrapper.

- `author-cli`: bundle rebuilt against the manifest module. It had still been reading flat
  `lit_action_*` records. Creating a publication through the CLI remains broken.
- `update-protocol`: proposes only the step that is missing, and takes the group id from the facet
  instead of predicting it.

Group `s2s@0.1.2`, id `4`. Seven actions, six new CIDs (`prep`, `render`, `update`,
`maintain-cache`, `repoint-archive`, `decrypt`). Document filed.

Publications move by setting `manifest_version` to `0.1.2` on their records module.
`test.soul2soul.eth` is still on `0.1.1`.

Tag `a7fb34c`, the tree that was pinned; `config/0.1.2.json` was written after it and carries the
`safeTxHash`.

## 0.1.1 — 2026-11-17 (tagged 2026-11-18, backfilled)

The first version the tooling produced end to end: a manifest document with its own number, its own
Lit group, and action CIDs nothing later may change. Tag `13e90bf`, the last commit that wrote
`config/0.1.1.json`; the pin itself is that file's `safeTxHash`.
`0x40286471030e13cc1b5bac2c860811900b065d12952eeed2120df0b038047d35`, group `s2s@0.1.1` id `2`,
seven actions.

- The manifest document moved off the records module's flat keys into `S2SManifestModule`, write-once
  per version; `shared` and the action bundle's `getManifest` both read it there.
- A new publication pins `manifest_version` on its own records module, in the batch that enables its
  modules, and only when absent.
- One Lit group per version, because `removeAction` would strip hashes an older publication still
  calls; `actions:group` writes `config/<version>.json` and refuses a version that already exists.
- `NAME` says the role, `VERSION()` says the build: `0.1`, with older `V<n>` names still accepted.
