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

## 0.1.3 — unreleased

- `fix(press): contenthash_wrapped is always CIDv1` — uncommitted, PR to follow. A tree reset or a
  from-zero render could get a CIDv0 root back from `files/stat` and write it as-is, producing
  `0xe3010070…`, which no standard contenthash parser accepts. eth.limo rejected the record and
  refused the name, which the browser reported as `ERR_SSL_PROTOCOL_ERROR` (`test.soul2soul.eth.link`,
  a publication reset in the window after 2026-08-25). `toHexString` now normalises with `toV1()`:
  same multihash, so the same blocks, and a readable record. `reset.test.ts` pins the value the
  reset path writes; `evm.test.ts` pins the bytes. Needs an action rebuild before it has any effect.
- Records already written as `0xe30100…` stay broken until they are rewritten — `test.soul2soul.eth`
  now holds
  `0xe301017012205a3706a8f738938877ee9413b22d0de101006c11260acd8b2858952b3368dd98`, the v1
  encoding of the same root. Anything else rendered in that window needs the same check.

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
