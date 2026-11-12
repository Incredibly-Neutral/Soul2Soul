# ADR-003 — a manuscript's label is public and unsigned

Status: accepted · Domain: AUTHOR (the manuscript envelope) · Satisfies: nothing in the paper

## Context

A publication has to list what it has been offered before it can read any of it. The title
lives in the body, and an encrypted body is opened only by the press on a gate, so a
listing has nothing to show but the genesis id: 64 hex characters, one row per manuscript.
The public part already carries what a publication sorts by — tags, dates, the publication
it was offered to — and it carries no name.

The obvious fix is a signed `title` on the public part. It costs more than it looks. The
EIP-712 type is a fixed field list, so a new field changes the type hash, and with it the
struct hash inside the digest that names the item. That digest — domain separator and struct
hash under the EIP-712 prefix — is the objectId. Every item would need a new struct name and a
new `specVersion`, which means a new branch in every signer and verifier, and every manuscript
that wants a name in a listing would have to be signed again under the author's key.

## Decision

A v2 envelope MAY carry `public.label`: a short name for the manuscript, public and
unsigned. It sits on the stored public part in the clear, and it is absent from
`S2S_TYPES_V2`, so it never enters the signing view. An item's objectId and signature are
the same bytes with it and without it, and the envelope stays `"2"`.

Absent means the genesis id, resolved by whoever displays the manuscript as
`label ?? genesis` at that moment. The resolved value is never stored.

The writer keeps a trimmed, non-blank string and writes the key only when there is one. A
blank, a null, a number or an object is no label: the key is absent, and the item still
verifies. A v1 item never carries one; its bytes are frozen.

## Alternatives rejected

- **A signed `title` on the public part.** A different type hash, hence a new struct name, a
  new `specVersion` for every item, a new branch in every signer and verifier, and a re-sign
  for every manuscript that wants to be listed by name. The label buys a display name; it
  does not buy a format version.
- **Reusing `base` or `position` as a name.** Both already mean something. A name crammed
  into one is a name nothing can trust and a field nothing can read.
- **Putting it in the body.** The body is the part that is encrypted, and the reader this is
  for is the one without a key.
- **Storing the genesis id in the label when no name is set.** Two representations of one
  identity, and the stored one is stale as soon as a version is appended.

## Consequences

- **Nothing verifies the value.** Any relayer, mirror or publication may rewrite it, and no
  reader can tell an author's label from a stranger's. A label is a claim about a
  manuscript, not a claim by its author.
- **No gate, index, cache key or identity may ever depend on it.** Not `canPublish` or
  `canRead`, not a records key, not an `objectId`, not a cache key, not a path. Anything
  that treats the label as authoritative hands a stranger control of that decision.
- **A display can disagree with the content.** Two manuscripts may carry the same label; a
  label may survive a revision that changed the title inside the body. It is a hint, and it
  is wrong by design when its author makes it wrong.
- **This is an explicit exception to the shared spec's rule that the public part has no
  unsigned field.** A display hint earns it because it is the only field whose whole job is
  to be read before anyone can verify anything, and because excluding it from the signing
  view is what keeps identity stable. The exception is recorded against that rule in
  `docs/specs/system/SPEC-shared.md`; any second unsigned field needs its own ADR.
