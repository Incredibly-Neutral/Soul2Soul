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

## 0.1.4 — unreleased

Group `s2s@0.1.4`, id `24`. Document
`0x80b2ba805a11bf544259f3f8ed6d3b6e3c70f1ce324e32295eb90c560f4b1006` (nonce 766), proposed and
unfiled: a publication Safe owner approves it, then `pnpm update-protocol 0.1.4` runs again to check
the filed document and the publication pin. All seven action CIDs differ from 0.1.3, so the group is
fresh and the build needs a release. Filing the document moves no publication: each one reads the
manifest at its own `manifest_version` record, so pinning this build to a publication stays a
separate human step. Tag: the commit that records the filed pin in `config/0.1.4.json`.

- `prep`: `Qmdb1wJ8AAWQbXUnNZhbADQ7a8K9sXDrbGjyKNeVPUivYo`
- `render`: `Qmcc8ZGmy2Tyz66Q2jB7bT9LwzQFfDZ8uBCJP8BVKLXmDT`
- `update`: `QmUtUTtHkfMsMH72tiMvYjBaZF8GnBVWAHDMqNEwvuDJQY`
- `maintain-cache`: `QmQGUxqiAHh1Mpc8Xi22FUAirSerRQ3GmJsy3go6vUs2tE`
- `repoint-archive`: `QmYQrvkYecoPwJzagX15r48ug1v8xVn9bNLkVzNMiRnfed`
- `encrypt`: `QmT84SLuQWzbNrm5j1oRLj889mpSjP4jkmVFMeRUknWCcK`
- `decrypt`: `QmZykRkdpeJBbjE3tEkrkocQNEEpzj6geGj4FfmenxnkTY`

### press

- Preview renders encrypted manuscripts and leaves the page unsigned, on a publication whose pinned
  action supports it
  ([eb536eb](https://github.com/Incredibly-Neutral/Soul2Soul/commit/eb536eb)).
- Preview opens for a listed reviewer, the manuscript's author, or an owner of the publication Safe,
  and an offered manuscript can be previewed instead of reading as revoked
  ([e38240b](https://github.com/Incredibly-Neutral/Soul2Soul/commit/e38240b)).
- A missing template, partial or signature now fails the page instead of publishing the input
  ([1a9135d](https://github.com/Incredibly-Neutral/Soul2Soul/commit/1a9135d)).
- Collections sort by date correctly, and a publication can choose ascending or descending order
  ([3decea6](https://github.com/Incredibly-Neutral/Soul2Soul/commit/3decea6),
  [2a66269](https://github.com/Incredibly-Neutral/Soul2Soul/commit/2a66269),
  [0c2eb88](https://github.com/Incredibly-Neutral/Soul2Soul/commit/0c2eb88)).
- A bulk build fits the request budget, and a page whose current content cannot be confirmed is
  refused instead of overwritten
  ([4cecb8d](https://github.com/Incredibly-Neutral/Soul2Soul/commit/4cecb8d),
  [fb7c0ac](https://github.com/Incredibly-Neutral/Soul2Soul/commit/fb7c0ac),
  [a8ddc4a](https://github.com/Incredibly-Neutral/Soul2Soul/commit/a8ddc4a),
  [e503f31](https://github.com/Incredibly-Neutral/Soul2Soul/commit/e503f31)).
- Revoking a manuscript removes its page wherever the publication's template placed it
  ([1c269c3](https://github.com/Incredibly-Neutral/Soul2Soul/commit/1c269c3),
  [77e0054](https://github.com/Incredibly-Neutral/Soul2Soul/commit/77e0054)).
- The colophon names the publication, its ENS name and its Safe address
  ([60a9761](https://github.com/Incredibly-Neutral/Soul2Soul/commit/60a9761)).

### publication

- Render site renders only the agreements you select, with a checkbox per row and a select-all
  ([1a63ea5](https://github.com/Incredibly-Neutral/Soul2Soul/commit/1a63ea5)).
- A row has one Preview action, and offers preview too
  ([e38240b](https://github.com/Incredibly-Neutral/Soul2Soul/commit/e38240b)).
- A preview tab says it is rendering and keeps its failure visible
  ([deb9e5f](https://github.com/Incredibly-Neutral/Soul2Soul/commit/deb9e5f)).
- After a publish render the header follows the new site root, and rows awaiting publish survive a
  tab switch
  ([111efaf](https://github.com/Incredibly-Neutral/Soul2Soul/commit/111efaf)).
- The render sweep is labelled Render site, and reviewers can be added in the Whitelists tab
  ([7122c9d](https://github.com/Incredibly-Neutral/Soul2Soul/commit/7122c9d)).

### author (cli)

- A folder can be published as one collection manuscript
  ([c3a4898](https://github.com/Incredibly-Neutral/Soul2Soul/commit/c3a4898)).
- Shorter commands: `s2s publish <note>` works the same as `s2s author publish <note>`
  ([08d4298](https://github.com/Incredibly-Neutral/Soul2Soul/commit/08d4298)).

### repo

- The build strips action comments through the parser, so a comment cannot break a bundle; every
  action CID changes, so this needs a fresh group
  ([685dcb9](https://github.com/Incredibly-Neutral/Soul2Soul/commit/685dcb9)).
- The release command names its test publication once, in `.env`, and prints the pin for the Safe
  owners instead of proposing it
  ([51fe2e9](https://github.com/Incredibly-Neutral/Soul2Soul/commit/51fe2e9)).
- The repo is Apache-2.0
  ([0b0fd97](https://github.com/Incredibly-Neutral/Soul2Soul/commit/0b0fd97)).

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
