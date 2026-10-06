# Soul2Soul Whitepaper — Handoff (2026-09-10)

This file is the handoff for whoever picks up the whitepaper next: where the
current draft lives, how to re-run the reading room, how sub-agent
communication actually works in this deployment, what was cleaned up, and what
is still open.

---

## 1. Current state of the whitepaper

**Canonical file: `/home/joera/code/s2s/brain/whitepaper/v1.md`**

This is the live, current draft. It is NOT the copy in the
`s2s-wt-whitepaper-v1` worktree — that worktree's `v1.md` is stale (it was the
original panel-review target). The reading-room config's default target
(`brain/whitepaper/v1.md` in the repo worktree) points at the stale copy; point
any new run at the canonical path above.

### Section spine (all final / committed)

| # | Section | Status |
|---|---|---|
| — | Abstract | Final (folded 2026-09-10; per-read split removed, optional gate "not yet built") |
| 1 | Introduction | Final (fourth pass, folded 2026-09-10) |
| 2 | Authoring | Final |
| 3 | Publication | Final |
| 4 | Agreements | Final |
| 5 | Gates | Final (three gates: canRerender / deal / canRead-optional) |
| 6 | Protocol | Final (governance + two generator actions) |
| 7 | Verification | Final (ENS domain → record (CID) → content-addressed tree → signed HTML) |

Source material (component docs) lives alongside it:
`00-introduction.md` … `08-authenticity-provenance.md`, plus `whitepaper.md`
(the original framing essay), `../threat-model/` (author.md, publication.md,
protocol.md, README.md), and `../specs/SUMMARY-protocol.md`.

---

## 2. The prompt used to query the reading room

The reading room is an orchestrator agent that convenes persona proofreaders.
There are two layers of "prompt":

### (a) The user-facing query that launches a session

The original request (2026-09-08):

> can you ask reading room to comment on introduction test in
> /home/joera/code/s2s-wt-whitepaper-v1/brain/whitepaper/v1.md

i.e. point the reading room at a document and ask for the panel's comments.
For future runs, the target should be the canonical
`/home/joera/code/s2s/brain/whitepaper/v1.md` (or whatever section is in flux).

### (b) The reading-room orchestrator's own system prompt

Full text lives at `~/.omnigent/agent-configs/reading-room/config.yaml`
(the `prompt:` block). Its core instruction:

> You are the s2s Reading Room, an orchestrator that convenes a panel of persona
> proofreaders to review a document. You do not critique documents yourself —
> you run the panel and synthesize their notes.
>
> RUN A SESSION:
> 1. Confirm the target document (default: brain/whitepaper/v1.md in the repo worktree).
> 2. Launch each persona as its own session (sys_session_create with the
>    persona's config path), in parallel, passing the document path.
> 3. Wait for each to finish; read its note from
>    brain/whitepaper/reading-room/<persona>.md.
> 4. Report a synthesis to the human: verdicts side by side, the strongest
>    criticisms, and where the personas agree / disagree.
>
> Never invent a position for a persona; each is research-grounded and must say
> where it has no documented view rather than fabricate one.

Personas are declared via `tools.agents` in that config:
`vitalik, satoshi, max-blumenthal, glenn-greenwald, rebecca-mackinnon,
rana-ayyub, le-guin, doctorow` (note: `neal-stephenson` is deliberately NOT in
the proofreader roster — he is the writer/editor, see §3).

### (c) The per-persona prompt

Each persona has its own system prompt at
`~/.omnigent/agent-configs/reading-room/agents/<persona>/config.yaml` with a
shared shape (vitalik's config is the exemplar):

- **Who you are** — grounding in the real person's documented worldview, not a costume.
- **Research directive** — synthesize the critique from the real person's actual
  positions (essays, talks, interviews); hard rule: never invent a position;
  where there is no documented view, say so and label reasoning as inference.
- **The document** — `brain/whitepaper/v1.md`, read in full first.
- **Critique format** — write to `brain/whitepaper/reading-room/<persona>.md`:
  Verdict / What resonates / Critical readings / Sharpest questions / Suggested
  changes / Sources — then report one short paragraph back to the orchestrator.
- **Style** — write like the persona, quote the draft where criticizing it.

### (d) The per-run brief

Beyond the system prompt, the orchestrator sends each persona a run brief that
names the target file and any scope (e.g. "Introduction only", or the author's
reactions to a first-round critique for a round-2 response). Keep briefs tight
and scoped; a one-section job should say "this task touches ONLY section N" and
embed any needed base text so the persona does not have to re-read the whole
whitepaper (large full-file reads + large writes in one turn are what stalls
the runner).

---

## 3. Sub-agent communication specifics (learned the hard way)

These are the operational rules for talking to sub-agents (personas and Neal)
in this deployment. Do not relearn them:

1. **Artifact first, polish second.** Every deliverable is a FILE, never inline
   reply text. Briefs follow this exact order:
   1. Read the sources, then **immediately write a working draft** to the given
      absolute path — imperfect is fine, it is the starting artifact, not the
      final exam.
   2. **Refine in place** with small edits to that same file.
   3. Reply **only with the file path**; never paste content into the reply.
   Rationale: an imperfect file written early survives every interruption; a
   "perfect" file written never exists. (This is now in the reading-room README
   and in Neal's config — the older config said "return the text to the
   caller," which is exactly what caused the multi-hour merge saga.)

2. **The inbox notice lies.** "completed — no output" is a persistent false
   negative: the runner frequently completes work (on disk or in-session) while
   reporting no output. **Never treat the inbox notice as the source of truth.**

3. **Verify on disk, and don't read too early.** A file existing does not mean
   the task is finished — the write is the FIRST step; refinement happens in
   place after. Check the file's mtime and content AFTER the session goes idle,
   and re-check if it is still running. Reading a file mid-refinement shows a
   half-finished draft.

4. **The source of truth is the sub-agent's own transcript.** Use
   `sys_session_get_history` on the session to see what it actually did
   (reads, writes, final reply with the path). Snoop the chat; don't trust the
   completion notices or my summaries.

5. **Never cancel a running sub-agent.** The "completed" notice is often
   premature and the session is still working (activity timestamps advance).
   Cancelling mid-work has burned real deliverables. Only conclude "stalled"
   after the session is terminal AND the transcript shows nothing was written.

6. **`executor.model` in a config overrides any model passed at spawn.**
   Passing `model=` to `sys_session_send`/`sys_session_create` is silently
   ignored if the config pins its own `executor.model`. To change a persona's
   model, edit or fork the config.

7. **GLM 5.3 vs the working carrier.** The GLM 5.3 runner
   (`z-ai-glm-5-3`) has stalled after reading on many runs in this deployment
   (never emits), but has also delivered on disk on some smaller-task runs.
   The reliably-completing model is `deepseek-v4-flash-0731`. The failure is
   the runner/backend, not the agent config or the task shape alone. Don't
   diagnose "model X is broken" from one run — check the transcript.

8. **Neal is not a registered agent.** He lives only at the worktree path
   `.omnigent/agent-configs/reading-room/agents/neal-stephenson/config.yaml`
   (pinned to `z-ai-glm-5-3`) and is launched via
   `sys_session_create(config_path=<that path>)`. The registered personas are
   launched by their config path too, or via their declared names.

9. **Match carrier to task size.** A one-paragraph reword does not need a
   persona launch. The orchestrator can do small edits directly; spin up a
   persona/writer for substantial passes or when a different hand is wanted.

---

## 4. Cleanup log (2026-09-10)

### Removed (content folded into v1.md, or superseded)

| File | What it was | Where it went |
|---|---|---|
| `merge-neal.md` | §§2–4 merged draft | committed to v1.md §§2–4 |
| `section1-intro.md` | Abstract + Introduction working draft | folded into v1.md (this session) |
| `section3-neal.md` | §3 prose pass (GLM) | committed to v1.md §3 |
| `section3-neal-flash.md` | §3 alternate pass (flash) | superseded by GLM version |
| `section5-gates.md` | §5 first draft (+ REMOVED who-pays block) | committed; who-pays paragraph preserved in §5 below |
| `section5-gates-sharpened.md` | §5 sharpened pass (Neal) | committed to v1.md §5 |
| `section5-gates-sharpen-fallback.md` | §5 alternate flavor | superseded |
| `section5-protocol.md` | §6 working draft | committed to v1.md §6 |
| `section7-verification.md` | §7 working draft | committed to v1.md §7 |
| `vitalik-opinion-sections.md` | section-planning consultation | decision recorded in §6 below |
| `satoshi-opinion-sections.md` | section-planning consultation | decision recorded in §6 below |
| `neal-opinion-sections.md` | section-planning consultation (writer take) | decision recorded in §6 below |

### Kept

- `v1.md` — the canonical draft (current state; ~20KB)
- `00-introduction.md` … `08-authenticity-provenance.md` — component source docs
- `whitepaper.md` — original framing essay
- `../threat-model/` — `author.md`, `publication.md`, `protocol.md`, `README.md`
- `v1.md.bak-20260908-161605` — backup from before the rewrite arc (untouched)
- Worktree `s2s-wt-whitepaper-v1/brain/whitepaper/reading-room/` — the 8 persona
  notes + README (the durable critique record; leave in place)

---

## 5. Pending note — who pays for the infrastructure

Removed from §5 Gates (it is machinery economics, not a gate). Preserved here
per the author's instruction. Candidates for placement: closing of §6 Protocol
(machinery/continuity), or the Abstract/Introduction money pass.

> Running a publication costs something — the storage that keeps content
> retrievable, the nodes that render it, the record writes that publish it.
> None of it is free, and the protocol does not pretend otherwise. A
> publication meets the cost one of two ways. On the serviced path it pays
> protocol fees, and the protocol's machinery — storage, rendering, resolution
> — does the work. On the bring-your-own-keys path it runs its own keys and its
> own infrastructure, at the cost of running them. The protocol permits both
> and promises neither: not free infrastructure, and not machinery that keeps
> itself alive.

---

## 6. Section-planning decision (from the three consultations)

Consensus of Neal (writer), Vitalik, Satoshi on which component topics earn a
whitepaper section under the protocol-vs-implementation filter:

- **The gate (03 encryption & access control) — IN, standalone.** Now §5 Gates.
  The paper's headline confidentiality claim ("no single operator can read").
- **Authentication-in-HTML / read-path authenticity (08) — IN, standalone.**
  Now §7 Verification. Reframed guarantee-first (the reader's "verify" act
  closes the loop the supply-side sections open).
- **Content schema (02), hosting (06), domain resolution (07) — OUT.** Spec
  material; at most single-sentence residues. Hosting/resolution survive only
  because content carries its own proof (verification is what makes untrusted
  storage/naming acceptable).
- The gate sits before Protocol; Verification closes the paper.

---

## 7. Open items

1. **Who-pays paragraph placement** — §5 above; decide where it lands (or
   leave it out of v1 entirely and keep it in the threat model).
2. **Stale Model-policy note.** The reading-room README says Neal is pinned to
   `deepseek-v4-pro-0813`; the live config currently pins `z-ai-glm-5-3`.
   Reconcile whichever is intended.
3. **Stray checklist line.** `- [ ] buy groceries` sits at the top of v1.md —
   an editing artifact; remove it on next touch.
4. **Worktree staleness.** `s2s-wt-whitepaper-v1/brain/whitepaper/v1.md` is
   out of date vs the canonical file. If the worktree is only used as the
   reading-room launch target, either point future runs at the canonical path
   or refresh the worktree copy before a panel run.
5. **Abstract/Intro reconciliation** — done as of this handoff (per-read split
   removed; optional gate "not yet built"); any future payment-model prose must
   stay consistent with §5's "optional, not built" status.
