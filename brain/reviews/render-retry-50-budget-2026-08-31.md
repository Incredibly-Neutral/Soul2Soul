# Findings — orchestrator render retry vs. Lit's 50-HTTP-request-per-session budget

Scope: read-only investigation of `/home/joera/code/s2s`. Goal: stop (or reduce) the
orchestrator retry loop when a render fails with a *deterministic* budget/limit-exceeded
error (Lit "You may not send more than 50 HTTP requests per session"), while keeping
retries for transient failures.

---

## 1. The exact retry implementation

All of it lives in one file: **`shared/src/rendering/sequence.ts`**, function
`runRenderActionWithRetry` (defined at `sequence.ts:45`, called only by the orchestrator
`renderwithLitActions` at `sequence.ts:185` inside the `Promise.all(jobs.map(...))` fan-out).

Constants:
- **Retry count (3):** `sequence.ts:34` — `const RENDER_RETRY_ATTEMPTS = 3;`
- **Delay (1500ms):** `sequence.ts:35` — `const RENDER_RETRY_BACKOFF_MS = 1500;`
- Per-call attempt count: `sequence.ts:53` — `const attempts = preview ? 1 : RENDER_RETRY_ATTEMPTS;`
  (preview runs on the free Bun gateway with no 50-cap and never retries; the live Lit
  path gets the full 3.)

The loop (`sequence.ts:56-84`):
- `sequence.ts:56` — `for (let attempt = 1; attempt <= attempts; attempt++) {`
- `sequence.ts:57` — sleeps `RENDER_RETRY_BACKOFF_MS` before every attempt after the first.
- `sequence.ts:59` — runs the action via `runAction(preview, lit, cid, inputs, litUsageKey)`.
- `sequence.ts:63` — success gate: `if (actionResult?.ok || actionResult?.success) return actionResult;`

**What "non-ok" means** — it is *not* a thrown exception and *not* a `data.ok` flag. It is
an **envelope whose `ok` field is falsy** (and neither `ok` nor `success` is true). The env
is the `ActionResult<T>` envelope `{ ok, action, trace, data?, error? }`. So
`returned non-ok` = `actionResult.ok === false` (e.g. an error envelope), and `threw` = the
`runAction` call rejected. The render action's *data-level* `data.ok` is not consulted here.

- **"returned non-ok" log line:** `sequence.ts:67`
  ```
  [render job ${job?.id}] attempt ${attempt}/${attempts} returned non-ok; retrying in ${RENDER_RETRY_BACKOFF_MS}ms — ${JSON.stringify(actionResult?.error ?? actionResult)}
  ```
- **"threw" log line:** `sequence.ts:73`
  ```
  [render job ${job?.id}] attempt ${attempt}/${attempts} threw; retrying in ${RENDER_RETRY_BACKOFF_MS}ms — ${err?.message ?? String(err)}
  ```
- Both only print when `attempt < attempts` (i.e. there *is* a retry coming).

**Exhaustion behavior:** after `attempts` tries it builds an `Error` from the last failure
(`sequence.ts:86-94`): `lastFailure?.error ?? lastFailure?.message ?? (string | JSON)`, attaches
the raw failure object as `err.failure` (`sequence.ts:92`), and **throws** (`sequence.ts:95`).
That throw is caught by the fan-out at `sequence.ts:189-193`, which turns it into
`{ success:false, index, error: err?.message }`.

Note on the log prefix: `<plugin:oxo-neutralpress>` is *not* part of this repo's source — it is
the Obsidian/Oxo plugin-host shell prefixing console output with the plugin name. The actual
retry text comes verbatim from `sequence.ts:67/73`.

### Where the caller sees it
`neutralpress/src/render/render.helper.ts:102` calls `renderwithLitActions(...)`; the per-job
retry and its console.error happen *inside* `sequence.ts` before control returns. Retries are
therefore fully internal to the orchestrator — there is no outer retry in the plugin.

---

## 2. Can the retry decision distinguish error classes? — YES.

The failure carries a matchable **string** that reaches the loop in two places:

1. **Non-ok path:** `actionResult.error` is a plain string. `sequence.ts:67` already reads
   `actionResult?.error` for the log, so the string is right there in the loop. On the render
   action this string is assembled from the action's own error buffer:
   - the per-item error buffer is joined at `protocol/actions/src/render/main.ts:375` —
     `error: errors.join('; ')`; and
   - the top-level action `catch` produces the envelope at `protocol/actions/src/render/main.ts:393-395`:
     `error: typeof e === 'string' ? e : ((e as Error)?.message ?? String(e))`.
2. **Thrown path:** `err.message` (the action threw through `runAction`, e.g. `evmRead`
   aggregating RPC failures — see §4).

So the budget message ("You may not send more than 50 HTTP requests per session") **is
available in the failure object** as a substring of `actionResult.error` (non-ok) or
`err.message` (thrown). Shape: it is a plain `string` (either verbatim from the Lit layer, or
embedded inside a larger prefixed string — see §6).

**Surfacing of the budget message:** the session-proxy budget error originates *inside* the
Lit session and is captured by the action. In the render action it lands in the envelope's
`error` field via the per-item catch at `protocol/actions/src/render/main.ts:271-273`
(`Decryption error for item <id>: <msg>`) or the top-level `catch` at `:393-395`. From there it
flows unchanged into `runRenderActionWithRetry` as `actionResult.error`. The loop never
truncates: `sequence.ts:67` prints `JSON.stringify(actionResult?.error ?? actionResult)`, and a
string field serializes in full. So a stable substring match is reliable (no truncation at this
layer).

---

## 3. Minimal change to NOT retry on budget-exceeded

Located in `runRenderActionWithRetry` (`sequence.ts:56-84`). The cleanest, smallest change:
in the `!actionResult?.ok` branch, before scheduling the retry, detect the deterministic
budget class and **break/return immediately** instead of continuing the loop.

Concretely, at `sequence.ts:66` (the `if (attempt < attempts)` retry gate), add a guard that
recognizes a budget/limit-exceeded failure and skips retrying:

```ts
const msg = String(actionResult?.error ?? '');
const deterministic = /more than\s*\d+\s*HTTP requests per session/i.test(msg)
  || /requests?[- ]per[- ]session/i.test(msg)
  || /budget/i.test(msg);
if (deterministic) {
  console.error(`[render job ${job?.id}] attempt ${attempt}/${attempts} failed with a deterministic session-budget error; NOT retrying — ${msg}`);
  break; // or return; exhaustion path below throws with lastFailure preserved
}
```

Placement options:
- After `sequence.ts:63`'s success gate, in the non-ok branch (`sequence.ts:65-70`).
- The same guard belongs on the **thrown path** (`sequence.ts:71-78`) if a budget error can
  surface as a reject (it currently reaches the loop as `err.message`); apply the same regex to
  `err?.message`.

Because the exhaustion path (`sequence.ts:86-95`) preserves the real failure (`lastFailure.error`
→ `err.message`, plus `err.failure`), a `break` yields the exact same thrown failure as 3 wasted
retries — but immediately, with zero extra spend. This is exactly what "we don't need 3 retries"
implies for this class: **retries = 0** here. (If you'd rather keep it configurable, turn the
hard-coded `RENDER_RETRY_ATTEMPTS` at `sequence.ts:34` into an options param/option object and
add a `noRetryOn` matcher list; but for a hard, stable system error a hard-coded fast-fail is
the right default.)

Manual/1-shot escape hatch (no code): run with `preview = true` → `attempts = 1`
(`sequence.ts:53`), which bypasses the 50-cap entirely (Bun gateway) and never retries. Useful
as a workaround today, but not the fix for the live path.

---

## 4. Matchable error classes: deterministic (do-not-retry) vs transient (retry-worthy)

Error strings that reach the loop as `actionResult.error` or `err.message`:

**Deterministic / should NOT retry (re-running re-burns budget or re-fails identically):**
- `more than 50 HTTP requests per session` — the Lit session-budget cap. Deterministic by
  construction: each session caps at 50, so a render that needs >50 requests will always fail.
  **Stable substring to match: `more than 50 HTTP requests per session` (or the looser
  `HTTP requests per session`).**
- `Receipt ... not confirmed within` / receipt-timeout — build-time bound; retrying an
  already-west write could double-write (see `shared/src/rendering/sequence.ts:30-33`, which
  already deliberately excludes the EVM-update action from retry).
- `hasDeal read failed` — handled internally (conservative, no throw); not normally seen here.

**Transient / retry-worthy (keep retrying):**
- `RPC call to <url> failed: ...` — aggregated in `evmRead` when every RPC URL fails
  (`protocol/actions/src/libs/evm.ts:236-248`). This is the *intended* retry case: fail-fast
  in-session, re-run the whole render in a fresh session/budget (`evm.ts:13-27`,
  `sequence.ts:22-27`).
- `Failed to resolve publication modules`, `Post content not found` — resolved by a later retry
  (a module / milestone that becomes available), retry-worthy.
- `Decryption error for item <id>: <msg>` — *ambiguous:* the prefix is per-item, but if
  `<msg>` is the budget string it is deterministic. **Match on the `<msg>` tail, not the prefix.**

Important: do **not** match on the `Decryption error for item` prefix alone — that class mixes
transient decrypt failures with budget failures. Match on the budget substring inside the message.

---

## 5. Is the 50-budget "per session", and do fan-out jobs SHARE one budget? — NO, each job is its own session.

The fan-out (`sequence.ts:185-186`, `Promise.all(jobs.map(...))`) makes each job call
`runRenderActionWithRetry(... runAction(... lit.executeAction(...)))`. Each `executeAction`
(`shared/src/lit/lit.service.ts:261-276`) is a separate `POST /lit_action` call = a **separate
Lit session = a separate, fresh 50-request budget**. This is stated directly in the code:
- `sequence.ts:22-27` — the comment explaining that orchestrator-level re-issued `eth_calls`
  "do NOT count against Lit's per-session 50-request budget" because they run in a fresh session;
- `sequence.ts:289-292` — the maintain-cache action "fires in its OWN fresh session ... a
  dedicated 50-request budget" instead of the render's tail;
- `protocol/actions/src/libs/evm.ts:13-27, 214-218` — "fail fast... let the orchestrator re-run
  the whole render in a fresh Lit session — a fresh 50-request budget."

So the fan-out jobs run **in parallel but do not share a budget** — each job draws its own
50-request pool. **Consequence:** a render whose *single job* needs >50 requests deterministically
blows that job's own session budget, and **every retry of that job opens yet another fresh
50-budget session and re-runs the same budget-blowing work**. Retries for this class are
therefore pure cost — each retry is a brand-new session, not a continuation of the exhausted one.
This confirms the premise: per-job retries are individually sensible (each retry = a fresh
budget), but pointless when the job's request *count* (not a transient failure) exceeds 50.

**What a retry can and cannot fix:** a retry helps when the 50-budget failure is *incidental* to
a transient error (a flaky RPC burned requests in-session, then the retry in a fresh session
succeeds cleanly). It cannot help when the render's request *count* itself exceeds 50 — the fresh
session deterministically blows again. Matching the budget string and fast-failing is safe for
the transient case too, because a run that *did* fail only due to transport flakiness (not
count-limit) won't carry the "more than 50 HTTP requests" message — it'll carry `RPC call ...
failed`. So the substring match cleanly separates the two.

---

## 6. Verbatim vs truncated — and the one caveat

The budget string is surfaced **verbatim** (no truncation between the Lit layer and the loop):
- Non-ok envelope: `protocol/actions/src/render/main.ts:393-395` copies `error.message` as-is
  into `actionResult.error`; `sequence.ts:67` JSON-serializes it fully.
- In the `Decryption error for item ...` path (`render/main.ts:271-273`) the budget string is a
  *suffix* (`...: <msg>`), still verbatim and fully matchable as a substring.

**Caveat to verify at runtime:** confirm the exact capitalization/wording of the session error
string Lit emits (the observed log shows "...more than 50 HTTP requests per session..."). Because
the message is copied verbatim, matching on a short case-insensitive substring such as
`requests per session` (or `HTTP requests`) is more robust than the full sentence, and still
specific enough not to collide with transient RPC errors. Recommend pinning the exact string from
a capture in `sequence.ts:67`'s log output before finalizing the regex.

---

## TL;DR

- Retry loop: `shared/src/rendering/sequence.ts:56-84` (`runRenderActionWithRetry`); 3 attempts
  (`:34`), 1500ms (`:35`); "non-ok" = envelope `ok === false`; log at `:67` (non-ok) / `:73`
  (threw).
- The budget failure string is matchable: `actionResult.error` (non-ok) or `err.message`
  (thrown), verbatim, no truncation.
- Minimal fix: in `runRenderActionWithRetry`, detect the budget string and `break` out of the
  loop immediately (retries = 0 for this class); exhaustion path already preserves and throws
  the real failure, so nothing downstream changes.
- Each render job is its own Lit session with its own 50-budget (fan-out does NOT share one
  budget), so every retry opens a fresh session and re-burns; retries for a deterministic
  count-limit are pure cost.
