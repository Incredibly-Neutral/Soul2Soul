# RFC-004 — media items as first-class content

> Domain: `AUTHOR` · moved from `brain/specs/RFC-media-items-1.md` (2026-11-04); number assigned on the move.

> **Type:** design proposal / forward work (an RFC, not a spec). Captures the *vision* — an image as
> a first-class signed `S2SContentItem` with its own author — so a future agent or human can pick it
> up cold. **Not next.** Recorded so the idea survives; pick up only after the current actions are
> battle-tested at scale. When built, fold settled parts into the relevant SPECs and strike here.
>
> **Near-term build is tracked separately** as `handoffs/handoff-author-images.md` — a minimal,
> no-new-gates path that gets author images content-addressed and tree-resident at `/media`
> *without* the first-class-item machinery. This RFC is the destination that handoff is a stepping
> stone toward; the handoff deliberately defers everything below.
>
> **Origin:** joera direction (2026-08-06): images are the author's choice; can be independently
> owned in the future by a photographer/image-editor role; must be IPFS content-addressed and live
> in the website tree; text and image stay **separate**. The first-class-citizen model is the one
> the system contract already demands — the schema needs zero structural change, only shifted
> semantics.

---

## Why this RFC exists — what `distributeImages` does wrong today

Current path: `neutralpress/src/content/images.ts :: distributeImages`. For each
`<img src="file://…">` in a post it:

1. uploads the binary to **Pinata only** (`main.oxo.ctrlr.pinata.uploadFileFromPath`) — not
   Kubo-canonical, no Filecoin tier,
2. rewrites `src` to a **Pinata path-gateway URL** (`${gateway}/ipfs/${cid}`),
3. **mutates the author's note destructively** (HTML→markdown via Turndown; structure destroyed,
   written back via `vault.modify`), and
4. bakes that Pinata URL **into the post's `content` string**.

Each step contradicts the system contract:

- image has **no `S2SContentItem`, no `proof`, no `did:ethr` author** → violates the Component 2
  minimum guarantee ("every item is author-signed, content-addressed, verifiable by anyone") and
  Component 8 provenance.
- Pinata path-gateway URL baked into content → violates **INV-11 / OPEN-TASK-1** (root-absolute
  paths, **origin-per-CID** serving; a `/ipfs/<cid>/…` path gateway breaks `/assets/…`-style
  root-absolute references).
- Pinata-only, not Kubo+Filecoin → violates **§3.2 storage tiers / INV-13** (CID parity across
  tiers; Kubo `rootCid` is canonical).
- destructive note mutation → violates **DR-1.1** (local-first, non-coercive authoring surface).

So `distributeImages` is a pre-content-item-era shortcut. The near-term handoff corrects the worst
of it (Pinata-path-URL + destructive mutation) without the first-class machinery; **this RFC** is
the full correction — the image *becomes* a signed, attributable, deal-able object in its own right.

---

## The vision — image as a first-class `S2SContentItem`

> **Settled since 2847c81:** the author form is the author Safe's bare `0x` address; the `did:ethr` author this section and the complaint above name is retired, and nothing writes it.

The schema already supports this with **zero structural change** — only the *semantics* of existing
fields shift:

| field | text post (today) | image item (vision) |
|---|---|---|
| `postType` | `post` / `page` | `image` (or `media`) |
| `mediaType` | `text/markdown` | `image/jpeg` etc. |
| `body` | `{title,slug,content,custom}` JSON | `{cid, alt, caption, width, height, mediaType, …}` JSON |
| `encryption` | per-item bool | per-item bool (same ownership semantics, DR-2.2) |
| `author` | did:ethr of writer | did:ethr of **photographer** (independent) |
| `proof` | EIP-712 over `public` | same — signs the image's metadata |
| `objectId` | EIP-712 digest | same — exists pre-CID (DR-2.3) |

A photographer is just *an author whose `postType` is `image`*. They `proposeNote`/`offerDeal` it
to a publication via the **existing** Component 4 deal lifecycle — **no new contract surface**.
Licensing/rights (DR-2.Y historical) lands here naturally: a photo *licensed* to a publication is
exactly an image-item + a deal. Per-item `encryption` (DR-2.2) gives the photographer an ownership
boundary vs the publication, reusing Component 3 unchanged.

### Two CIDs (the bit to get right)

An image has **two** content addresses; do not confuse them:

- **CID_P** — the **pixels** (raw binary on IPFS). Self-certifying: the CID *is* the hash of the bytes.
- **CID_I** — the **signed item** (metadata + proof + body-ref). The provenance-bearing object.

The item's `body` names `cid: CID_P`. Because `plaintextHash = keccak(canonicalJSON(body))` is
signed (DR-2.4), **the signature commits to CID_P** — and since CID_P commits to the pixels, the
chain is integrity-complete: *who claimed it* (proof) + *which pixels* (CID_P, transitively hashed).
No need to sign the binary. The **post references CID_I** (the item), not CID_P; the renderer
follows `item.body.cid → CID_P` at build time. CID_I is what's stable, attributable, and deal-able.

### Authoring (the "register image" command)

A neutralpress command parallel to publish, scoped to `postType: image`:

1. pin binary to **Kubo** (MFS `files/*` + `pin/add`) → CID_P; stage Filecoin via existing
   `FilecoinController` CAR path (INV-13); Pinata async.
2. `buildSignedContentItem(...)` with `mediaType: image/…` and `body = {cid: CID_P, alt, caption, …}`.
3. upload the item JSON to Kubo → **CID_I**.
4. stamp `content_id` (objectId) + `item_cid` (CID_I) back into the image's note frontmatter
   (non-destructive; same pattern the text-publish flow uses).

In a post, reference by **CID_I** (content-addressed, stable, retrievable) — recommend over
`objectId` (objectId is *inside* the item already; CID_I is the fetch address).

### Renderer

Resolve pass between render and MFS-build: scan for the item's CID_I reference in content, `cat` the item, **verify
`proof`**, read `body.cid → CID_P`, `cp` CID_P into `/media/<CID_I>/…` (per-item grouping; room for
item.json + variants), rewrite `<img src>` root-absolute. Optionally drop the item JSON at
`/media/<CID_I>.json` for standalone per-image provenance pages (supports the
photographer-as-independent-role story). INV-7 parity: preview skips/warns proof-verify; prod
verifies.

---

## Open design questions (vision-level; settle when this RFC is picked up)

- **Reference form in post body** — CID_I (the item's content address, gateway-agnostic) vs `objectId` vs Obsidian wikilink. Recommend CID_I. Exact syntactic embedding is an open detail; **no custom URL scheme** (the CID is the address, IPFS is the retrieval).
- **Caption/alt** — signed in `body` (yes; attributable + immutable per version).
- **Licensing/rights** — defer to Component 4 deal lifecycle (DR-2.Y lands here).
- **"Register image" as separate command** vs folded into publish — recommend separate (images are
  authored independently of any post; a photo can be deal-able before any post references it).
- **Encryption for images** — schema permits it (DR-2.2); unencrypted = publication's own
  commissioned art; encrypted = photographer retaining ownership. Per-item, "author's choice."
- **Authoring surface for image-items** — notes (to carry `content_id`/`item_cid` frontmatter) vs
  plain files. The near-term handoff uses plain files in `media/`; this RFC may move to notes so an
  image-item can hold its own signed metadata. Reconsider when picked up.

---

## New invariant worth recording

> *The **rendered site** never emits a provider/gateway URL for media — it always rewrites to
> root-absolute `/media/<CID>` (INV-11, origin-per-CID). The load-bearing part of any media
> reference is the **CID**; a gateway host string may ride along but is never load-bearing.*

This is the lesson `distributeImages` violates (it let the Pinata URL reach the rendered site). Pin
it so it doesn't regress. The invariant bites at **render output**, not the signed input.

- **Near-term handoff (`handoffs/handoff-author-images.md`, Step 0):** the CID rides in a gateway URL
  *in the signed markdown* (`https://gateway/ipfs/<CID>/…`); the host is a non-load-bearing hint.
  Simpler, no transform — but migrating gateways means re-signing.
- **This RFC's vision (Step 1):** goes further — the signed body references **CID_I directly**
  (the item's content address, gateway-agnostic), so signed content survives a gateway change
  without re-signing. The CID is the address; IPFS is the retrieval — no custom scheme needed.
  Enabled by the item layer; not worth the complexity until the rest is battle-tested.

## Cross-references

- **Component 2** (`~/code/polyphony/whitepaper/manuscript.md`) — schema, `body`/`public`/`proof`, DR-2.2/2.3/2.4;
  this RFC reuses the schema unchanged with shifted semantics.
- **Component 4** (`~/code/polyphony/whitepaper/publication.md`) — deal lifecycle; the photographer
  role + image licensing land here, no new contract surface.
- **Component 5** (`~/code/polyphony/whitepaper/press.md`) + **Component 6** (`~/code/polyphony/whitepaper/publication.md`)
  — the `update` action's MFS-tree build; the vision's `/media/<CID_I>` resolve pass lives here.
- **Component 8** (`~/code/polyphony/whitepaper/reader.md`) — page-level provenance today; the
  vision adds per-image provenance (each image carries its own `proof`).
- **SPEC-00** — INV-7 (action runtime-agnostic), INV-11 (`/assets` root-absolute ↔ `/media` parity),
  INV-13 (CID parity across tiers), §3.2 storage tiers (Kubo canonical, Filecoin+Pinata durable),
  OPEN-TASK-1 (origin-per-CID subdomain gateway — unblocks *viewing* once live).
- **Near-term build** — `handoffs/handoff-author-images.md` (minimal, no-new-gates stepping stone).
- **Legacy code** — `neutralpress/src/content/images.ts :: distributeImages` (Pinata-only,
  path-URL-in-content, destructive mutation); also referenced from `note.factory.ts`,
  `content/content.ctrlr.ts`. Removed/bypassed in the near-term handoff.
