---
section: whitepaper-body
protocol: soul2soul
status: merged-draft (GLM 5.3 / neal-stephenson deliverable, persisted 2026-09-09)
source: v1.md sections 2–4 + threat-model notes; authored by neal-stephenson (z-ai-glm-5-3)
note: The GLM runner produced this text but never emitted it to the API/inbox; it was
      recovered from the session view and persisted here. Three surgical cleanups applied
      by the orchestrator, flagged in the change-list. Abstract + Introduction untouched.
---

# Soul2Soul whitepaper — refined body sections (v1 pass)

## ### 2. Authoring

Work begins where the author is. Authoring is local-first: the working copy lives on the author's machine, and nothing in the protocol needs to be reachable to write, revise, or keep a draft. Publication is a later and separate act.

At publication the author signs. The signature asserts authorship in a way that remains verifiable against their account wherever the work later appears, and that account is what a publication's agreements record. The keys beneath it live on the author's machine and are replaceable; an identity that cannot survive a key rotation is an archive hostage to a single secret. The identity is permanent enough to carry a reputation.

An author's account is a pseudonym. The record holds an account, not a legal name, so no party the protocol touches is in a position to expose one. The account itself is public — it stands in the record and in the provenance of every page — so the pseudonym is findable, not hidden; what the protocol does not hold is the name behind it. The default is cooperative: pseudonymity is an option the protocol permits, not a promise it makes, and it separates the identity from infrastructure, not from the people an author chooses to tell.

The account needs funding only as far as protocol fees require — gas, publishing, rendering — and nothing in the protocol requires a fiat on-ramp or off-ramp; how the account is funded, and how value leaves it, are outside its scope.

Editing does not stop at publication. The work remains the author's, so they can revise and reissue it; each version is signed and recorded, so the record shows what changed and when.

Whether a revision appears immediately or waits for the publication is set by the agreement itself. Where the parties know each other, the publication grants standing approval and the author publishes and revises at will. Where trust is still being established, work and revisions are proposed and take effect once accepted. The protocol does not choose between these; it requires only that no change is silent.

Neither side can act unseen. The author's revisions are recorded as they happen, and the publication's refusals are too. The publication cannot rewrite a work — only decline to keep carrying it, on the record. Editorial disagreement is settled by argument, because position is no longer available to either side.

No authoring surface is canonical. What the protocol defines is the interface — hold content locally, authenticate as the author's account, sign at publication — and any tool implementing it qualifies. A shared library rather than an application, so the surface an author writes in never becomes a chokepoint and its maintainer never becomes an owner.

## ### 3. Publication

A publication is not a person holding credentials. It is an account on the same record as its authors, and it decides its own shape: one holder or several, whatever threshold it sets for acting. Governance is a choice the publication makes about itself. What the protocol guarantees is that the shape is explicit and recorded, and that no change to it is silent.

The account governs what the publication is. It decides who may publish and how: whether work is reviewed before it appears, or admitted directly from authors it trusts. It decides what configuration the site runs under, and how the site is built — the templates and design it renders with. Each of these is a decision, not a setting. Redesigning the site or adopting a new template goes through the same act as admitting an author; there is no privileged path to changing what a future render produces.

The record makes the account's decisions public and auditable. Grants and revocations are written down as they happen, so anyone can verify what the publication currently permits and who currently holds keys. Nothing changes silently. Revenue accrues to the publication's own address, and the address, like the decisions, is public — so the record shows what a publication is doing even when it cannot show who is deciding it. The holders of the keys may be pseudonymous; the trail of their decisions is not. Every change they make is on the record, and a persistent observer of the record is a persistent observer of them.

The publication does not own the work, and that is what makes it worth joining. A publication that wants to keep its contributors must persuade them, because departure is always available and always costs it something. The account persists — keys pass to new holders, contributors leave — and a line it can no longer hold by position it must hold by argument.

Content is content-addressed and self-verifying: no host serving it can alter the bytes without the alteration showing. It is not self-preserving. Keeping an archive alive — pinning the content, keeping storage warm — is maintenance someone must choose to perform, and the protocol does not perform it. A third party may keep historical copies, and any party may; but a copy kept by someone else, however faithful, is not authenticated by the publication's name. The name vouches for the current record, not for the past.

The publication is reached by a name it owns rather than rents. It may hold its own domain through its own account, and the domain points to the current record — the agreements in force — so the name is itself a statement of what the publication currently is. Reaching it may still pass through a gateway a reader's network refuses, and a name can be made hard to resolve. The protocol makes the name the publication's own; it does not make it immune to censorship.

## ### 4. Agreements

An agreement is between an author and a publication, over a single work. It records who wrote it, that the publication may render it, and how revenue divides between them. It is entered by both parties and can be ended by either.

Agreements are recorded on a public blockchain: neither party operates the record, neither can rewrite it, and there is no host to pull. This is what makes ending an agreement a fact rather than a request.

The set of agreements currently in force is what the publication consists of. There is no separate list of articles: a work is published because an agreement covers it, and ceases to be published when that agreement ends. Adding a work and permitting it are the same act.

Neither party owns the record. An author appends a work and can retract it; a publication admits a work and can decline to keep carrying it. Each version an author publishes is recorded, so a publication can see that a piece has changed and an author can show what they published and when. Only the author of a work may revise or withdraw it; neither the publication nor another author can alter it in the record.

What the record holds is not the work. Source material is stored encrypted and never made public: it exists in readable form only inside the generator, while a page is being produced. What a reader receives is the rendered page, not the source. Anyone can see that a work was revised and when; what is not under a current agreement is not rendered — and this applies to every version of a withdrawn work, not only the latest.

Ending an agreement is a single act with immediate effect. The author does not ask, and the publication does not need to agree. The next rendering is produced without that work, and no signer's standing extends to it any longer. What the ledger settles is what was agreed and when, not whether either party honored it — a page that keeps circulating after a withdrawal is a copy the name no longer vouches for.

---

# Change-list

### Section 2 — Authoring
- **Pseudonymity:** now states the honest limit up front — *the account itself is public and findable* (it stands in the record and in every page's provenance); the protocol withholds the *name*, not the account. Converts an implied "hidden identity" promise into a scoped one.
- **Money:** reworded to scope-claim form — the account needs funding only as far as protocol fees require; on/off-ramps are outside the protocol's scope. No implication that the protocol caps what the account holds.
- **"Neither side can act unseen":** reworded from what each side *cannot* do to what the *record does* — revisions and refusals are both written down.
- **Reputation sentence** ("permanent enough to carry a reputation") moved to the key-rotation paragraph, where the identity discussion lives; the money paragraph now ends cleanly on the scope claim.

### Section 3 — Publication
- **"The collective" → "the publication":** governance shape is a choice (one holder or several), so the prose no longer assumes a collective.
- **Cut "nothing about it depends on one person's continued goodwill"** — overclaims for the single-owner shape. Replaced with what holds for every shape: the account persists, keys pass to new holders, contributors leave.
- **Persistence is now its own paragraph** with the full locked scoping: content is content-addressed and self-verifying but **not self-preserving**; survival is maintenance someone must choose to perform; third-party historical copies are faithful but **not authenticated by the name**. The name vouches for the current record, not the past.
- **Naming:** unchanged in substance; "does not make it immune to censorship" kept as a scope claim. No uncensorability claim anywhere.
- **No-privileged-path** formulation for codebase/design changes kept (grounded in the component decision record).

### Section 4 — Agreements
- **Ending paragraph:** dropped "a publication that renders a withdrawn work is not prevented from doing so" — the license gates block a new render of withdrawn work, so the claim misstated the design. Replaced with the grounded sequence: the next rendering excludes the work, no signer's standing extends to it, the ledger settles what was agreed and when, and *a page that keeps circulating after a withdrawal is a copy the name no longer vouches for* (consistent with the Publication section).
- **Overclaim fix (orchestrator):** "never becomes public … no one outside a current agreement can read any version of it" → split honestly: the **rendered page is public** (that is the point of the protocol); it is the **source material** that stays encrypted inside the generator. Added "What a reader receives is the rendered page, not the source" and scoped the earlier-versions claim to "what is not under a current agreement is not rendered."
- Append/retract/admit/decline mechanics unchanged in substance.

### Cross-cutting
- **Scope claims over outcome claims** throughout; impossibility is kept only where the shared record guarantees it (no silent change, no rewriting).
- **No new architecture facts** — threat-model notes used only to sharpen honest limits.
- Abstract and Introduction untouched (kept for last, per the human).

### Orchestrator cleanups applied while persisting (flagged, not hidden)
1. **Section 3, para 2** — restored the dropped opening sentence "The account governs what the publication is." (the recovered text began with a stray ".". ) and fixed the comma typo after "chokepoint."
2. **Section 4, para 5** — the overclaim fix above (rendered page public / source material encrypted).
3. **Section 2** — resolved the writer's own open note ("'is the point' reads odd") by moving the reputation sentence to the key-rotation paragraph; "expose one" confirmed correct as-is.
