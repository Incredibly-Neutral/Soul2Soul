# Handoff: author images — content-addressed, tree-resident, no new gates (Step 0)

**Date:** 2026-08-06
**Scope:** Replace `distributeImages` with a minimal path that makes author images IPFS
content-addressed (Kubo-canonical) and resident in the site tree at `/media` — using **only** the
storage tiers and `update` action that already exist. **No new gates, no conversions inside the Lit
actions.** The `update` action gets one **additive** pass (extract image CIDs from rendered pages →
`/media`, rewrite `src` root-absolute). Everything else is client-side in neutralpress.
**Investigation only — no code touched.** Ready for implementation.
**Status:** Design agreed with joera (2026-08-06). This is the **near-term build**; the full
first-class-citizen vision (image as a signed `S2SContentItem` with its own photographer author) is
deferred to `specs/RFC-media-items-1.md` and is **not** in scope here. Priority ordering is explicit:
**ship this, then stress-test the current actions at scale before adding any of the RFC's surface
area.**

---

## 1. Why

`neutralpress/src/content/images.ts :: distributeImages` is a pre-content-item-era shortcut that
violates the system contract four ways (full critique in `RFC-media-items-1.md`): Pinata-only (not
Kubo-canonical, no Filecoin tier — §3.2/INV-13), Pinata path-gateway URL baked into post `content`
(INV-11/OPEN-TASK-1), destructive note mutation via Turndown (DR-1.1), and no per-image
`S2SContentItem`/`proof`/author (Component 2/8).

This handoff corrects the two that bite hardest — **gateway URL reaching the rendered site** (no
render-time rewrite) and **destructive mutation** — and gets images onto the canonical storage
tiers + into the tree, **without** the first-class-item machinery. The goal is to unblock author
images *and* keep the
action surface unchanged so the current actions can be tested at scale. Per-image provenance,
photographer role, deals, and encryption for images all stay deferred to the RFC.

## 2. Design principle — CID is load-bearing, gateway host is a hint, bytes in tree, no enclave change

- The image is **content-addressed** (CID_P = the pixels) and **tree-resident** at `/media`, but is
  **not** a first-class signed item. Provenance for the page still comes from the post's own item
  (Component 8); the image is attributed transitively via the post that includes it.
- **Reuse existing storage tiers** (§3.2): Kubo canonical at authoring time (synchronous — the CID
  must be known before the post is signed), Filecoin + Pinata as async durability (INV-13 CAR parity
  via `unixfs-v1-2025`).
- **Reuse the existing `update` action** with one additive pass. No new gate, no new conversion of
  signed items, no change to the signing/decryption flow. Storage inside the action stays
  **Kubo-only** per §3.2 ("Rendered HTML" row).
- **No custom URL scheme, no publish-time transform.** The signed post body is the markdown the author
  wrote — a standard markdown image whose URL has the CID in the path. The CID is the load-bearing
  part; the gateway host string riding along is a non-load-bearing retrieval hint (if the gateway
  dies the CID is still recoverable from the signed content and fetchable from any gateway). The
  only transforms are (a) authoring-time: local file → Kubo upload → CID stamped into the link
  (non-destructive, one-time), (b) render: exfiltrate `{filename, cid}` from content onto `job.media`
  + emit `<img src="/media/<key>">`, and (c) update: fetch bytes by cid → insert at `/media/<key>`
  (dedup). The path key `<key>` is open (§9).
- **The invariant bites at render output, not the signed input.** The *rendered site* must never
  emit a gateway URL for media — always rewritten to root-absolute `/media/<key>` (INV-11,
  origin-per-CID). This is the sin `distributeImages` committed: it let the Pinata URL reach the
  rendered site. The signed markdown carrying a gateway URL (with CID) is fine.

## 3. The markdown form (decided)

**Layer 1 — what the author types in the `.md` note** (confirmed with joera, 2026-08-06):

```
![alt text](https://ipfs.transport-union.dev/ipfs/<CID>/name.jpg "<CID> | name.jpg")
```

- **Standard markdown image with a title attribute** — renders **natively in Obsidian** (visual
  representation inside the md editor, the stated benefit). Zero custom syntax, zero plugin
  post-processor; the note stays portable.
- Carries **both CID and filename** — the stated reason: so the `update` action can place the bytes
  in the tree. Note the URL path *already* contains `<CID>/name.jpg` authoritatively; the title
  `"<CID> | name.jpg"` is **human-readable redundancy** (shows on hover) + a robustness copy. The
  action **parses the URL path** for CID + filename (authoritative), not the title.
- This is **not** the bad `![alt](https://example.com/image.png)` form: that URL has no CID (mutable
  host). A gateway URL with the CID in the path is content-addressed; the host is just a fetcher.
- Declined alternative: `![alt] [cid bafy] [filename name.jpg] (url)` — does not render natively in
  Obsidian (CommonMark reads `![alt]` as a broken image + loose bracketed text), would need a custom
  post-processor, note non-portable. The title-attribute form gets the same information across with
  native rendering.

## 4. Two layers (markdown signed, HTML rendered)

An image reference lives in two places; the form differs. **No intermediate scheme,
no publish-time transform** — the signed body is the authored markdown.

| layer | what it is | form |
|---|---|---|
| **1. Markdown source = signed body** — `.md` note the author types; this is what gets signed as `body.content` | `![alt](https://gateway/ipfs/<CID>/name.jpg "<CID> \| name.jpg")` — standard markdown image; renders natively in Obsidian; CID + filename ride in the URL path (title is human-readable redundancy + robustness copy) |
| **2. Rendered HTML** — site output | `<img src="/media/<key>" alt="…">` — root-absolute (INV-11); path key `<key>` is open (§9: filename vs CID vs CID+filename-for-MIME) |

**Mapping (authoring assist → render exfiltrates → update inserts; no publish transform, no new gate):**

```
author includes local image
       |  authoring assist (on include): Kubo upload -> CID known -> stamp into link
       v
markdown note = signed body:  ![alt](https://gateway/ipfs/<cid>/name.jpg "<cid> | name.jpg")   <- layer 1, renders in Obsidian; signed as-is
       |  SINGLE/render: exfiltrate image refs from content -> job.media[] = [{filename, cid}]
       |                 emit HTML <img src="/media/<key>" alt="...">   (key: see 4a)
       v
rendered HTML (per job):  <img src="/media/<key>" alt="alt">
       |  MERGED/update: aggregate job.media across all jobs; dedup ("when not present already");
       |                  fetch each cid from Kubo; cp bytes into /media/<key> in MFS tree
       v
site tree:  /media/<key>  (bytes present, root-absolute; INV-11)
```

- **Authoring assist (local → gateway URL with CID):** non-destructive, one-time, done at the moment
  of include (same moment as the Kubo upload, §5). This replaces `distributeImages`' destructive
  Turndown `vault.modify` mutation. The note stays a valid markdown note.
- **No publish-time transform.** The signed `body.content` is the markdown exactly as authored
  (gateway URL + CID + filename). `plaintextHash = keccak(canonicalJSON(body))` commits to those
  bytes. Migrating gateways later would require re-signing (new version, new objectId) — accepted:
  the CID is stable, the host string is not load-bearing.
- **Render = exfiltration only (no IPFS, no tree).** SINGLE/render already has the decrypted body
  and produces `job.html`; it is the natural place to scan content for image refs and populate
  `job.media` (§4a). It does **not** fetch image bytes or touch the site tree — render stays cheap
  (a Lit render ≈ $0.20–0.50; §3.2 keeps durability/tree-work out of it). The gateway URL never
  reaches the rendered HTML — render rewrites `src` to root-absolute `/media/<key>`.
- **Update = tree + Kubo only (§6).** MERGED/update already assembles the MFS tree from delta pages
  + `cp config.assetsCid → /assets` (INV-11); the `/media` pass is additive there. It consumes the
  aggregated `job.media`, fetches bytes from Kubo, inserts at `/media/<key>`, dedups.
- The CID here is **CID_P** (the pixels). There is no item CID in this handoff (that's the RFC).

### 4a. The media manifest — `media: [{filename, cid}]` on `S2SJob`

The filename must live somewhere the render/update actions can pick up reliably when building the
tree — not just buried in a URL path or a hover title. **Ride it on the job object.**

`S2SJob` (shared/src/protocol/types.ts) already flows through all three stages — PREP builds
`jobs[]`, SINGLE/render mutates `job.html`, MERGED/update consumes `jobs[]` (verified:
`PrepData.jobs`, `SingleData.job`, `EvmUpdateInput.jobs` all carry `S2SJob`). So one new optional
field threads the whole pipeline for free:

```ts
interface S2SJob {
  id: string;
  templateConfig: S2STemplateConfig;
  path?: string;
  templateData?: S2STemplateData;
  html: string;
  revoked?: boolean;
  media?: { filename: string; cid: string }[];   // <- NEW (Step 0). Per-job image manifest.
}
```

- **Render (SINGLE) populates it** — exfiltration: scan rendered content for image refs, parse each
  URL path → `{filename, cid}`, append to `job.media`. One row per referenced image.
- **Update (MERGED) consumes it** — aggregate `media` across all `jobs[]`, **dedup ("when not
  present already")**, fetch each `cid`'s bytes from Kubo, insert into `/media` in the MFS tree.
  Idempotent across re-publishes and across posts sharing an image.
- **Carrier distinction (why the job, not the config):** `assetsCid` rides the **publication config**
  (publication-level chrome, one per site) → `/assets`. Media is **per-post content** (different
  image set per post) → must ride the **job object** → `/media`. Different scope, different carrier.
  Same root-absolute rule (INV-11), same Kubo-only-in-action rule (§3.2).
- **Open: the tree-path key `<key>`** (the one real decision this surfaces) — see §9.

## 5. Authoring flow (Obsidian / neutralpress)

- A vault section, e.g. `media/`, holds **images directly** (binary files), **not notes**. One
  image = one file. (Joera's explicit choice: "media folder is just images, not notes.")
- The author **links** an image into a post (Obsidian image embed / wikilink to the `media/` file).
- **On link/include, the image is uploaded to remote Kubo immediately** (`ipfs.transport-union.dev`,
  MFS `files/*` + `pin/add`) — authoring-side, per §3.2 "content files" row, **not** a Lit action.
  Kubo is canonical and synchronous here because the CID must be known before the post is signed.
- **Filecoin and Pinata fire async** after Kubo (fire-and-forget durability tiers, same pattern
  `neutralpress` `uploadJson`/`uploadTree` already uses; INV-13 CAR parity via `unixfs-v1-2025`).
- The link in the note takes the layer-1 form (§3). The authoring assist uploads to Kubo and stamps
  the CID into the link (local-file reference → gateway URL with CID), non-destructively, at the
  moment of include. Optionally also stamp the CID into the note frontmatter (mirroring the
  text-publish stamp pattern). The note stays a valid markdown note; this one-time stamp replaces
  `distributeImages`' destructive Turndown `vault.modify`.

## 6. `update` action change (additive `/media` pass; consumes `job.media`)

- When building the MFS site tree, the `update` (MERGED) action **reads the aggregated `media`
  manifest off `jobs[]`** (populated by render, §4a) — it does **not** re-parse HTML for image URLs.
  For each `{filename, cid}`: **if not already present** in the tree, **fetch the bytes from Kubo**
  by `cid` and **`cp` into `/media/<key>`** (key: see §9). Dedup makes it idempotent across
  re-publishes and across posts sharing an image.
- This parallels how `update` already copies `config.assetsCid` → `/assets` (INV-11). `/media` is
  **content** (per-post, author images); `/assets` is **publication chrome** — different classes,
  same root-absolute rule. Different carrier too: `assetsCid` comes from publication config (one per
  site); `media` comes from the job objects (per-post) — see §4a.
- The rendered `<img src="/media/<key>">` is **emitted by render** (§4); update only supplies the
  bytes at that path. Same INV-11 / OPEN-TASK-1 origin-per-CID serving requirement as `/assets`
  (works under subdomain gateway / ENS `.limo`; breaks correctly under path gateways, same as
  `/assets`). **The gateway URL from the signed markdown never reaches the rendered site.**
- **MIME:** depends on the `<key>` choice (§9). If key = filename, the extension carries Content-Type
  naturally. If key = CID (no extension), the action sets `Content-Type` at serve time (derived from
  `filename` in the manifest, or sniffed from bytes).
- **No new gate, no new conversion of signed items, no change to signing/decryption.** The pass
  reads `job.media` (already exfiltrated by render) and places bytes in the tree.
- **INV-7 parity:** runs identically under the Bun shim (preview: skip/warn on missing bytes) and
  Lit (prod). Storage inside the action stays Kubo-only (§3.2).

## 7. Remove `distributeImages`

`neutralpress/src/content/images.ts :: distributeImages` is removed (or bypassed). Call sites:
`note.factory.ts`, `content/content.ctrlr.ts`. Its job is split three ways: Kubo upload +
CID-stamping into the link → authoring assist (§5); image-ref exfiltration → `job.media` in render
(§4a); bytes-into-tree + dedup → `/media` pass in `update` (§6). No Turndown, no `vault.modify` note mutation, no Pinata path URL reaching the rendered site. There is
**no publish-time transform** — the signed body is the authored markdown.

## 8. Acceptance

- `distributeImages` gone: no destructive note mutation; no Pinata-only upload (Kubo canonical).
- **`job.media` manifest** populated by render (exfiltration) and consumed by update (insert+dedup)
  — the render→update seam for images, parallel to `job.html` for page content.
- The **rendered site** emits root-absolute `/media/<key>` for all author images — **no gateway URL
  in any rendered page** (the rewrite invariant). (The signed markdown may carry a gateway URL with
  CID; that's expected and fine.)
- Pixels are Kubo-canonical with Filecoin + Pinata as async durability (INV-13 parity asserted).
- No new gate, no new conversion inside the Lit actions; the `update` change is purely additive.
- Image renders natively in the Obsidian md editor (layer-1 form, §3).

## 9. Open questions (settle during implementation)

- **Tree-path key `<key>` — the one real decision the manifest surfaces.** Render emits
  `<img src="/media/<key>">`; update inserts bytes at `/media/<key>`; dedup keys on whatever `<key>`
  is. Options:
  - **`<key>` = filename** (`/media/hero.jpg`) — human-readable, extension carries Content-Type
    naturally. Collision risk across posts with same-named images (author's own vault → likely fine;
    multi-author → namespace or accept last-wins). Dedup by filename.
  - **`<key>` = CID** (`/media/<cid>`) — collision-free, pure content-addressing (joera's earlier
    `<img src=/media/bafy>`). No extension → MIME via `filename` in the manifest at serve time.
    Dedup by CID (cleanest idempotence).
  - **`<key>` = CID, filename kept in manifest for MIME** — reconciles both: collision-free path +
    reliable MIME from the manifest's `filename`. Likely the right call; confirm.
  Render and update must agree on `<key>` (render emits it, update inserts at it).
- **`body.content` format** — confirm whether the published `body.content` is HTML or markdown
  today; render's exfiltration must parse the right form (the layer-1 example assumes markdown; if
  body is HTML, render parses `<img src="https://gateway/ipfs/<CID>/name.jpg">`).
- **Exfiltration scope** — does render scan `body.content` only, or also template/partials? Author
  images live in body; confirm templates don't carry author images (they shouldn't — that's `/assets`).
- **When Kubo upload fires** — confirm the trigger is link/include in Obsidian (joera's direction:
  "uploaded to remote Kubo immediately" on link), not a separate "register" command.
- **Gateway migration / re-signing cost** — accepted: changing the gateway host string in signed
  content requires re-signing (new version). Confirm acceptable for Step 0; the CID stays stable
  across it. (The RFC's vision avoids this by referencing CID_I directly — gateway-agnostic.)

## 10. Cross-references

- **`specs/RFC-media-items-1.md`** — the deferred vision this handoff is a stepping stone toward
  (image as first-class signed `S2SContentItem`, photographer role, two-CID model, per-image
  provenance/encryption/deals).
- **SPEC-00** — INV-7 (action runtime-agnostic), INV-11 (`/assets` ↔ `/media` root-absolute parity),
  INV-13 (CID parity across tiers), §3.2 storage tiers (Kubo canonical; Filecoin+Pinata durable;
  Lit actions Kubo-only), OPEN-TASK-1 (origin-per-CID subdomain gateway — unblocks *viewing* once
  live; previews need `preview.transport-union.dev`, still unwired).
- **Components 2/5/6/8** (`whitepaper/02,05,06,08`) — schema, `update` MFS-tree build, provenance.
- **Legacy code** — `neutralpress/src/content/images.ts :: distributeImages`; call sites
  `note.factory.ts`, `content/content.ctrlr.ts`.
