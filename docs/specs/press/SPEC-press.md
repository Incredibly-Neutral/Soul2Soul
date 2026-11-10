# PRESS — the only place plaintext is held

Read against: `~/code/polyphony/whitepaper/press.md` (2026-10-29).

Branch: [SPEC-protocol-actions](SPEC-protocol-actions.md) — PREP → RENDER → UPDATE, the I/O contract, the decision tree.

The press is the only party that must hold a manuscript decrypted, and it holds it in order to do
two things: open it to the people a gate names, and turn it into pages. Everything else the press
does is checkable after the fact — the code it ran, the page it built, the root it recorded. Only
the moment of decryption is not, which is why the protocol spends its trust here and nowhere else.

Two things therefore have to hold before anything else in this file matters: the runtime is sealed
enough that the operator cannot see in, and the operators are constituted so that colluding against
an author's or a publication's rights is not a realistic option (PRESS-1, PRESS-2). Neither can be
proven by reading code; both are properties of a deployment, and a reader of this file should treat
them as the assumptions the rest of it stands on.

What *can* be stated as a requirement is what the press must do with the plaintext once it has it
(PRESS-3 to PRESS-9): keep its keys inside, decrypt only on a gate, build only from content the
publication itself put on the ledger, sign what it built, and record one hash for the whole site
against the publication's name.

---

## PRESS-1 — sealed, and able to say which code ran

The press MUST run in a runtime that keeps its code and its keys hidden from everyone, its operator
included, and that MUST be able to attest which code is running.

Note: "attest" is a statement about the code's identity that anyone can check afterwards. It does
not require trusting the operator's word, but it does not by itself prove the hardware kept its
promise — that part is a trust the protocol places and cannot verify from here.

## PRESS-2 — operators that will not collude

An implementation MUST constitute the operators of that runtime so that colluding against the
rights this protocol gives authors and publications is not realistically available to them —
whether by federated governance over a diverse set, or by making defection cost more than it gains.

## PRESS-3 — the keys stay inside

The press's keys for decryption and signing MUST stay inside the runtime. They MUST NOT be
exportable to the operator, and a copy of the code running elsewhere MUST NOT carry them.

There MUST be a way to rotate each key and a way to recover it.

## PRESS-4 — decrypt only on a gate, in the same execution

The gates MUST be part of the code the runtime attests. A manuscript MUST be decrypted for anyone
only in an execution that first asks a gate and gets a pass, against the ledger state read at that
moment (GATES-6).

Note: the requirement is about the order inside one execution, not about policy. Whoever runs the
press cannot skip the gate by asking differently, because the gate is in the code that holds the
key.

## PRESS-5 — pure functions, addressed by their own content

Every function the press runs MUST be pure: given the same input and the same ledger state, the
same output. Each MUST be addressed by the hash of its own code, and the set of them MUST be
published by the implementation's governance.

Note: running a copy of a function MUST NOT get anyone past a gate. What a copy lacks is the key,
not the code.

## PRESS-6 — templates and configuration only as the publication recorded them

The press MUST build a publication's pages only with templates and configuration that the
publication has recorded on the ledger by content address. A request MUST NOT be able to substitute
either.

## PRESS-7 — monetized text is encrypted again under the reader gate

Where an agreement monetizes a manuscript, the press MUST encrypt the rendered text again under the
reader gate before any reader can reach it. What a reader receives MUST NOT be the plaintext the
press decrypted.

## PRESS-8 — a signed colophon for every page

Every page MUST carry a colophon signed by the press. It MUST bind at least: a hash of the page
itself, the manuscript the page was built from, and the agreement under which it was built.

Note: the colophon is what a reader checks (READER). It is a claim *by the press*, and it is worth
exactly what PRESS-1 and PRESS-3 are worth.

## PRESS-9 — one hash for the site, recorded against the name

The press MUST record a single hash covering all of the site's pages and assets on the ledger,
against the publication's name, in a transaction the press signs itself.

Note: how that hash is formed is not specified here — only that one value covers the whole site and
that changing any page changes it. A reader resolving the name to that value is resolving to the
site as a whole, not to a listing of pages that could disagree with it.

---

# This implementation

Built as actions executed inside a TEE enclave (Lit V3, Chipotle): the key is derived in-sandbox and
never leaves it, and the key, the permitted action CIDs and the usage key are bound on the ledger as
a Lit Group on Base. The actions are bundled deterministically and registered by the hash of their
build.

## Readings

- **PRESS-8's colophon** is the signed JSON-LD block the renderer injects into every page: a SHA-256
  of the hashed page region, the manuscript's genesis and CID, the author's own EIP-712 proof, the
  publication's identity, and the publication module as the licence. The hash covers the page
  *without* the colophon, and the colophon is inserted outside the hashed region by construction, so
  signing does not invalidate the hash it carries.
- **PRESS-9's "one hash"** is an IPFS directory root: the press assembles the site as a directory in
  a mutable filesystem, pins it, and writes the resulting root CID as `contenthash_wrapped` on the
  publication's name. The directory CID is a Merkle root over every page and asset, which is the
  property PRESS-9 asks for; the press does not assemble a Merkle tree of its own.
- **PRESS-3's "the press signs itself"** — the write transaction is signed by the press's own key,
  never by an operator's, and the same key signs the colophon.

## Additions

Things this implementation does that the protocol does not require. Recorded here; deliberately
absent from the public docs.

- **Deterministic builds.** The same sources produce byte-identical bundles, so the hash a reader
  sees attested can be re-derived by anyone from the repository. This is what makes PRESS-1's
  attestation checkable rather than trustable; it is not a protocol requirement, since a protocol
  cannot require a particular build system.
- **A page may be built with parts missing.** Data failures are classified (config, template,
  content) and only config and template failures fail the build; unavailable content items are
  dropped from the page and reported. The protocol says nothing about partial pages — it says a page
  carries a valid colophon, which this still satisfies.
- **Removal, and the condition on it.** Withdrawing a manuscript renders an empty page for its path
  and the update removes that path from the tree — but only after checking on the ledger that no
  agreement is in force over it. Removal is not a protocol requirement; it is what GATES-4's "has
  carried" is for.
- **A path gate.** Before a page is written to a path, the incumbent page is read and the write is
  refused when the incoming page's signature does not bind the body it publishes. This exists
  because earlier pages signed a skeleton rather than the page; it is a repair, not an invariant.
- **One root, several names.** A publication may list aliases, and the same root is written to each
  name in a single batch; removing an alias clears its record. The protocol speaks of *the*
  publication's name; this treats extra names as additional doors to one root.
- **A cache pointer.** A second text record per publication points at a content archive the render
  reads collections from. It is a performance path and is explicitly non-authoritative: a failed
  read degrades to fetching each item, and correctness never depends on it.
- **Preview builds.** A request may ask for a build that skips the provenance gate and the ledger
  write. Useful for authors; not a guarantee, and never reachable as a published page.
- **Publication-owned tree reset.** Recorded in `gates.md` — a holder may clear the site outright.

## Gaps without a proposal

- **PRESS-7 is unbuilt.** Nothing in the press encrypts a rendered page; `canRead` is checked before
  *decryption*, and the resulting HTML is uploaded and pinned in the clear. A monetized manuscript is
  therefore protected where it is stored and not where it is read: the page that carries it is
  public, and the reader gate never sees it. The invariant stands; the implementation is behind it.
- **PRESS-6 is unbuilt for configuration.** The renderer prefers the config recorded on the module
  when no CID is supplied, but it accepts a config CID from the request and never compares it with
  the recorded one. Everything the config controls — templates, assets, locale paths, aliases — can
  therefore be chosen by whoever triggers the build, and the page that results still carries a valid
  press signature. The templates themselves are fetched by content address, as required; it is the
  choice of *which* config that is unguarded.

## Not yet established

- **PRESS-1's sealing.** That the code hashes are bound on the ledger and named in every page is
  checkable, and is implemented. Whether the runtime keeps the code and keys hidden from its
  operator is a property of the deployment, not of this repository.
- **PRESS-2's operator set.** Who runs the runtime, how they are chosen and what makes collusion
  unrealistic is a governance fact. Nothing in the repository selects or constrains them.
- **PRESS-5's "published by governance".** The registration path exists — builds are pinned, hashed
  and added to the account in a batch signed by the protocol's safe — but whether that counts as
  publication by governance is a process question this repository cannot answer.
