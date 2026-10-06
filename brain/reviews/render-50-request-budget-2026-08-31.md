# Render action: root-cause of the "50 HTTP requests per session" failure

- Date: 2026-08-31
- Scope: `protocol/actions/src/render/*`, `protocol/actions/src/libs/*`, `protocol/actions/src/maintain-cache/main.ts`, `shared/src/rendering/sequence.ts`, `shared/src/lit/*`, `shared/src/rendering/helpers.ts`. Read-only investigation — no code changes made.

## TL;DR

The render action blows Lit's hard 50-request-per-session cap because of **three compounding request sinks** that are all active on a normal multi-collection job: (1) per-encrypted-item decrypt gating (`canRead` = 3 eth_calls), (2) two full ENS-module walks with up to ~10 `NAME()` probes each, and (3) on a cold/empty cache, one IPFS `cat` per publication deal. There is **no request-count guard anywhere** in the action or shared libs — the cap is Lit-runtime-enforced and aborts the whole session hard, which (per PR #69 design) also kills the maintain-cache handoff so the cache never bootstraps ("cache not working"). Parallel jobs do **NOT** share one budget: each job and each retry is a separate Lit action execution with its own fresh 50 cap, so the observed failure is a single job already exceeding 50 in one session.

---

## 1. Session / budget semantics (item 2)

- The error string "You may not send more than 50 HTTP requests per session" is a **Lit node runtime error** — a hard, session-scoped cap on the action's own outbound HTTP `fetch` calls. It is **not enforced anywhere in this repo**. A `grep` for `50 | HTTP requests | per session | budget | request-count | MAX_REQUESTS` finds the number only in comments:
  - `protocol/actions/src/libs/evm.ts:13`, `:214-218` ("Lit's hard cap of 50 requests per session")
  - `protocol/actions/src/maintain-cache/main.ts:41` ("its OWN 50-request budget")
  - `shared/src/lit/actions/types.ts:79-82`
  - No counter / guard exists in the action or libs (only the evm.ts **retry** was removed for this reason, but failover across RPC URLs remains — see §3r).
- "Per session" in Lit's model = **per single action execution** (one `executeJs` run of the action code on a node). Each dispatch/retry is a new execution → a fresh 50-request budget:
  - `runAction` → `lit.executeAction` → one POST to the proxy `/lit_action` (`shared/src/rendering/helpers.ts:34`, `shared/src/lit/lit.service.ts:256-268`).
  - `runRenderActionWithRetry` (`shared/src/rendering/sequence.ts:45-82`) retries by re-invoking `runAction` (line 59), so each retry is a **fresh session / fresh 50 budget** (confirmed by the evm.ts comment at `:27` and sequence.ts `:24-30`).
- `Lit.Actions.Decrypt` (`protocol/actions/src/libs/decrypt.ts:20`) and `Lit.Actions.getPrivateKey` are **node-internal operations, NOT counted** against the 50 HTTP cap — they do not issue outbound HTTP. Only `fetch`/`catFile`/`uploadFile`/`evmRead`/`evmWrite`-transport calls count.

**Bottom line for item 2:** cap is Lit-runtime, hard, and per-execution. A retry starts a fresh budget, but if a *single* job needs >50 requests every attempt will fail — which is exactly the observed failure.

## 2. Parallelism — do jobs share one budget? (item 4 critical question)

**No.** `renderwithLitActions` fans out jobs with `Promise.all(jobs.map(... runRenderActionWithRetry ...))` (`shared/src/rendering/sequence.ts:185-215`, `runAction` at `:206`). Each job independently calls `runAction` → one `/lit_action` POST = one Lit action execution = its own 50-request budget. Requests from different jobs are **not summed** against one cap.

Per render invocation the session budget is consumed as follows:
- prep action — 1 execution (`sequence.ts:163`) → own budget.
- N render jobs — N executions (`sequence.ts:185`) → each own budget. Only the **last** job is the cache maintainer (`maintainCache: index === jobs.length - 1`, `:195`).
- update action — 1 execution (`sequence.ts:278`) → own budget.
- maintain-cache action — 1 execution, fired in its own session (`sequence.ts:308-323`) → own budget.

So the budget-blowing is a **per-job** problem: the first (or any) render job already needs >50 requests. Blowing one job's budget aborts *that* execution; the orchestrator retries it (fresh budget) but it will fail again because the profile is structurally over budget.

## 3. Every HTTP request the render makes, per job (item 1)

Call sites (all in `protocol/actions/src` unless noted). Each `evmRead` is at least 1 request and up to `len(rpcs)` requests due to **failover across RPC URLs** (`evm.ts:235` `for (const url of urls)`), i.e. a labile transport multiplies the whole RPC count.

| # | Step | Call site | HTTP requests |
|---|------|-----------|---------------|
| A | getProtocolInfo → getProtocolControllerAndModules | `main.ts:104` → `protocol.factory.ts:2` → `ens.factory.ts:38` | 4 eth_calls (nameWrapper L1 `:42`, ownerOf L1 `:50`, parentDomainController L1 `:58`, getModulesPaginated L2 `:66`) |
| A' | …+ per-module `NAME()` probe | `ens.factory.ts:81` | up to 10 eth_calls (loops `modules[0]`, pageSize 10 at `:66`) = `M_pc` |
| A'' | …+ getRecords | `protocol.factory.ts:20` | 1 eth_call (L2) |
| B | archive pointer `getText` | `main.ts:115` | 1 eth_call (L2) — only when `collections.length > 0` (`main.ts:112`) |
| C | getDomainOwnerAndModules | `main.ts:142` → `ens.factory.ts:104` | 3 eth_calls (nameWrapper L1 `:113`, ownerOf L1 `:122`, getModulesPaginated L2 `:130`) |
| C' | …+ per-module `NAME()` probe | `ens.factory.ts:152` | up to 10 eth_calls = `M_dm` |
| D | fetchById → getLatestEntry + cat | `main.ts:150` → `module.factory.ts:151` | 1 eth_call getLatest (`:119`) + 1 IPFS cat (`:156`) |
| E | getConfig → cat config | `main.ts:159` → `config.ctrl.ts:14` | 1 IPFS cat (`:18`) (configCid given; if absent +1 eth_call getRecord `:16`) |
| F | initTemplateData → decrypt main body (only if `body.encryption`) | `main.ts:165` → `data.ctrlr.ts:82` → `decrypt.ts:14` → `gates.ts:21` | 3 eth_calls (canPublish `:25`, isOwner `:28`, hasDeal `:31`) |
| G | revoke `hasDeal` (only if `triggeredIds` includes job.id and path exists) | `main.ts:208` → `main.ts:41/49` | 1 eth_call (L2) |
| H | fetchCollections | `main.ts:229` → `data.ctrlr.ts` | see below |
| I | per-collection decrypt of encrypted items | `main.ts:250-283` → `decrypt.ts:14` → `gates.ts:21` | **3 eth_calls per encrypted item** (canPublish, isOwner, hasDeal) — `gates.ts:25,28,31` |
| J | renderHTML → fetchTemplateBundle + partials | `main.ts:298` → `html.ctrlr.ts:139` | 2 IPFS: dag/get template array `:22`, cat template file `:52`; + 1 IPFS cat **per partial** (`handlebars.factory.ts:688`) = `2 + N_partials` |
| K | uploadFile | `main.ts:332` → `ipfs.factory.ts:38` | 1 IPFS POST (`/api/v0/add`) |
| L | addAndSignMetadata | `main.ts:327` → `metadata.ts` | 0 HTTP (Lit in-enclave signing) |

**Item H detail — the collection/archive fetch** (`data.ctrlr.ts`):
- Archive-pointer **empty / bad** (cold cache — the observed failing state): `fetchByPublicationDetailed` (`data.ctrlr.ts` no-archive branch → `module.factory.ts:198`) = 1 eth_call `getDeals` (`:202`, +1 per 100-page) **+ 1 IPFS cat per deal** (`:208`) = `1 + P`.
- Archive **present** (`fetchCollectionsFromArchive`, `data.ctrlr.ts:307`): 1 IPFS cat of the archive (`:314`) + 1 eth_call `getDeals` (`:322`) + 1 IPFS cat **per `needsFetch` (MISS/STALE) entry** (`:332`). Steady state = `2`; cold/empty-local = `2 + P`.

**Total per job (no-archive / cold path — the observed failure), parameterised:**

```
evmReads  = 12 + M_pc + M_dm + (3·E)     # A(5)+A'(M_pc)+A''(1)+B(1)+C(3)+C'(M_dm)+D(1)+E(0)+F(0 if plaintext)+G(1)+H-getDeals(1)+I(3E)
IPFS      =  5 + P + N_partials          # D cat(1) + E cat(1) + H cats(P) + J(2+Np) + K upload(1)
TOTAL     = 17 + M_pc + M_dm + 3E + P + N_partials
```
(`F` adds +3 eth_calls if the main body is itself encrypted.)

**Worked example — "typical" 2-collection job, 8 items each, cold cache:** assume `P = 8` deals, `E = 8` of them encrypted, `M_pc = M_dm = 6` modules each, `N_partials = 4`:
`evmReads = 12 + 6 + 6 + 24 = 48`; `IPFS = 5 + 8 + 4 = 17`; **total = 65 → over 50.**

**Worst case** (10 modules each, all 16 items encrypted, 16 distinct deals): `evmReads = 12+10+10+48 = 80`; `IPFS = 5+16+4 = 25`; **total = 105.**

**Even with a WARM archive (steady state, `needsFetch = 0`)** the evmRead side is unchanged (`12 + M + 3E`), so only IPFS drops to `≈10`:
- E=8 warm: `48 + 10 = 58` → **still over 50.**
- E=4 warm: `36 + 10 = 46` → marginal / at risk.

**Conclusion:** the cap is blown by **RPC (eth_call) volume, not IPFS** — dominated by `3·E` (encrypted-item decrypt gating) and `M_pc + M_dm` (ENS NAME probes), with the cold-cache `P` cats pushing it decisively over.

### Redundant / avoidable requests (item 1 continued)

- **`canRead` re-reads `hasDeal` that getDeals already established.** The collection items were obtained from `getDeals()` (which returns active deals) or the archive built from it, yet `decrypt` (`gates.ts:31`) issues a fresh `hasDeal` eth_call per encrypted item, *and* `canRead` combines it with `canPublish` + `isOwner` (`gates.ts:25,28`) — 3 reads/item where the deal-membership fact is already known → **≥1 redundant eth_call per encrypted item** (`E`).
- **`hasDeal` checked twice for the same genesis.** The revoke check (`main.ts:49`) and each encrypted item's `canRead.hasDeal` (`gates.ts:31`) can both hit the same genesis → duplicated `hasDeal` calls.
- **Dual, near-identical ENS walks.** `getProtocolInfo` (`ens.factory.ts:38`) and `getDomainOwnerAndModules` (`ens.factory.ts:104`) each do `nameWrapper()` (`:42`/`:113`) on the same registry plus up to 10 `NAME()` probes (`:81`/`:152`). The `NAME()` probe fan-out alone is up to **20 eth_calls per render** and is redundant work for a render that already resolves the modules. Applies to **maintain-cache too** (§4).
- **`getDeals` enumerates every deal even when collections only use a few.** `fetchCollections` fetches *all* deals and cats every `needsFetch` cid (`module.factory.ts:202,208`; `data.ctrlr.ts:322,332`), regardless of which deals the 2 collections actually filter to. On a cold cache that is `P` cats for what may be an 8-deal subset.
- **Per-item cats are not batched.** `fetchByPublicationDetailed` / `fetchCollectionsFromArchive` issue one `cat?arg=cid` per entry (`module.factory.ts:208`, `data.ctrlr.ts:332`) — there is **no multi-get / batch endpoint** used anywhere (kubo `/api/v0/` has none; each cid is one request).
- **Template + partials re-fetched every job.** `renderHTML` dag/gets the template array, cats the template, and cats every partial (`html.ctrlr.ts:22,52`; `handlebars.factory.ts:688`) on *every* render. Because each job is a separate session there is no cross-job HTTP reuse.
- **RPC failover multiplier.** `evmRead` brackets each call site in `for (const url of urls)` (`evm.ts:235`); a transport failure that makes 2 URLs both "fail" still resolves by issuing the next call, but on a flaky Base RPC the effective count can approach `2×`, and the comment history (`evm.ts:13-20`) shows a prior in-session retry (up to 6 requests/read) had to be stripped for exactly this reason. Failover remains a hidden multiplier.

## 4. maintain-cache action request profile (item 3)

`protocol/actions/src/maintain-cache/main.ts`, per execution (its own 50 budget):
- `getDomainOwnerAndModules`: 3 eth_calls + `M_dm` NAME probes (`main.ts:70` → `ens.factory.ts`).
- `canPublish` (unless preview): 2 eth_calls (`main.ts:78-84` → `gates.ts:47,51`).
- `getProtocolInfo`: 5 + `M_pc` eth_calls (`main.ts:88`).
- pointer `getText`: 1 eth_call (`main.ts:99-107`).
- re-derive drift: `getDeals` 1 eth_call (`main.ts:114`) + archive cat 1 IPFS (`:115`) + `cat` per `needsFetch` (cold = P, steady = 0) (`:126-133`).
- steady-state (no drift) → **zero writes** (`:119-124`).
- write path: `uploadFile` 1 IPFS (`:151`) + `evmWrite` setText confirm:true (`:158-167`):
  - `getTransactionCount` + `estimateGas` + `sendTransaction` = **3 more eth_calls** (`evm.ts:117-217`), **plus unbounded `getTransactionReceipt` polling** in `waitForReceipt` (`evm.ts:62-97`) — each poll is an HTTP request, backing off 250ms→10s up to a 90s budget, i.e. potentially several-to-tens of requests if the base network is slow.

**Steady state** (cache working, no drift): `≈ (3 + M_dm) + 2 + (5 + M_pc) + 1 + 1 + 0 + 0 + 3 + polls` = `≈ 15 + M_pc + M_dm` eth_calls + 1 IPFS. With `M ≈ 6` each ≈ **28 + polls** → safely under 50 *provided the receipt confirms promptly*.

**Cold state** (must re-cat all `P` items to seed the archive): adds `P` IPFS cats → e.g. P=8 ≈ **36 + polls** → still under 50 typically, *but* the unbounded `waitForReceipt` polling (`evm.ts:88-97`) is the one consumer that can silently burn the budget on a slow Base RPC. **Recommendation: bound the receipt poll to a hard request count, not just a time budget.**

So maintain-cache can stay under 50 (and its profile is the mirror of the render's — it too wastes the `M_pc + M_dm` NAME probes).

## 5. Where the budget is blown (item 5)

For the observed failure (first render job already > 50; cache not bootstrapped, so the **no-archive cold path** is active) the dominant consumers, in order:
1. **`3·E` decrypt-gating eth_calls** (`main.ts:250-283`, `gates.ts:25-31`) — largest RPC sink, present even with a warm cache.
2. **`M_pc + M_dm` ENS NAME probes** (`ens.factory.ts:81`,`:152`) — up to ~20 eth_calls.
3. **`P` cold-cache per-deal IPFS cats** (`module.factory.ts:208` / `data.ctrlr.ts:332`) — the volume that pushes a marginal render decisively past 50.

With the worked example (65 requests) it is blown before the final `uploadFile`. Every retry re-blows it (fresh budget, same profile), and because the render returns `ok:false`, `successful` stays empty → `maintainCachePending` never true (`sequence.ts:234-236`) → maintain-cache never fires → pointer never written → cache stays cold → every subsequent render re-takes the expensive cold path. This is the "cache not working" **feedback loop**.

## 6. Concrete, ranked options to get under 50 (item 4)

**Ranked by impact : risk.**

1. **Cap/remove the redundant `NAME()` probe fan-out (S-tier, low risk).** Both ENS walks probe up to 10 modules (`ens.factory.ts:81`,`:152`). Merge the two walks (both already read `nameWrapper` + `ownerOf`) and short-circuit the module search once both `configModule`/`publicationModule` are found, or probe lazily. Realistic saving: ~20 → ~4-8 eth_calls per job.
2. **Cheap out the decrypt gate when membership is already known (S-tier, low risk).** `canRead` issues canPublish + isOwner + hasDeal per encrypted item (`gates.ts:25-31`), but collection items come straight from `getDeals()` / the archive, so `hasDeal=true` is already implied → drop the `hasDeal` read (saves `E` eth_calls) and/or add a **session-local memo** keyed by genesis so the same item isn't re-gated in step F and step I / revoke. Saving: ~`E`–`2E`–`3E` eth_calls.
3. **Add an in-action request-count guard that fails fast / degrades (A-tier, medium risk, directly requested).** Since there is no guard today, the Lit runtime aborts the whole session at 50 with a cryptic error and (per §5) defeats the retry + cache handoff. A lightweight counter at the transport layer (wrap `evmRead` in `evm.ts:222` and `catFile`/`uploadFile` in `ipfs.factory.ts`) that (a) fails fast with a named "budget exhausted" error when near the cap so the orchestrator can skip rather than waste, and (b) lets the orchestrator try a cheaper degraded render (e.g. skip collections / skip revoke / skip partials) is strictly better than an opaque abort. Must keep the guard at/below ~48 so the final `uploadFile`+sign always fit.
4. **Add a cheap degraded path when `ok:false` is budget-related.** Because each retry is a fresh budget with the same profile, retrying is useless for *budget* blowouts (it only helps *transient transport* failures — `sequence.ts:24-30`). Have the render signal "over budget" distinctly (guard #3) so `runRenderActionWithRetry` (`sequence.ts:45-82`) can either skip extra attempts or fall back to a minimal render that drops farther from budget (fewer partials, N-archived items, no per-item decrypt by skipping gates it can defensively default).
5. **Eliminate redundant cats/reads (B-tier, low risk):** (a) skip the per-item `hasDeal` re-check (§3r); (b) don't enumerate/cat deals that no collection filters to — push the `filterCollection` predicates down so `getDeals`/cats only cover the wanted subset; (c) memo the resolved `protocolInfo`/ENS modules per session (each job is a fresh session, so this must live inside the job, not across jobs).
6. **Skip the archive cat on the hot path only when truly needed (C-tier, nuanced).** The archive cat is already gated to `collections.length > 0` (`main.ts:112`) and already degrades to no-archive on failure (`data.ctrlr.ts:318-320`). Don't skip it blindly (it is the correctness-vs-performance trade that keeps steady-state cheap) — the real win is *getting the archive bootstrapped* (via maintain-cache) so `needsFetch` and thus step-H cats shrink, then keeping warm with maintain-cache.
7. **Batching / multi-get: not available.** kubo `/api/v0/` (the gateway) exposes no multi-get; every cid is one request (`ipfs.factory.ts:66-77` catFile). Could batch via a single `dag/get` of a wrapped directory or a gateway-side aggregation, but that's a bigger infra change — not a quick win inside the action.

**Critical answer to the "parallel jobs share one budget?" question (restated): they DO NOT.** Each job/retry/action gets its own fresh 50-request session (`sequence.ts:185-215` + `helpers.ts:34`). The fix is therefore *per-job*: reduce a single job's request count below 50 (options 1–5), not to think of the fan-out as one pooled budget.

### Guard recommendation (option 3, concretely)
Add a monotonic counter in the transport layer (ideally one shared module imported by `ipfs.factory.ts` and `evm.ts`) incremented in `catFile`/`uploadFile`/`evmRead`; check it before each request and throw `RequestBudgetExceeded` at ~48. Then: (a) render returns a clear `ok:false error:'render budget exhausted'` instead of Lit's opaque abort; (b) `runRenderActionWithRetry` can recognize it and skip Useless retries / fall back to a cheaper render; (c) `maintainCachePending` logic in `sequence.ts:234-236` can still be driven even when only partially successful, so the cache has a chance to bootstrap and break the cold-cache feedback loop.

## Key file:line index
- Budget-blowing code: `main.ts:104,115,142,150,159,229,250-283,298,332`
- `gates.ts:24-37` (canRead = 3 eth_calls/item), `gates.ts:46-56` (canPublish)
- ENS NAME probes: `ens.factory.ts:81`, `:152`; walk heads `:38`, `:104`
- Cold-cache cats: `module.factory.ts:202-210`; archive path `data.ctrlr.ts:307-349` (cat `:314/:332`, getDeals `:322`)
- Template/partial fetch: `html.ctrlr.ts:19-57,139-149`; `handlebars.factory.ts:679-705`
- Render retry / fresh session: `sequence.ts:45-82,185-215`; `helpers.ts:34`; `lit.service.ts:256-268`
- Maintain-cache: `maintain-cache/main.ts:70-167`; receipt poll `evm.ts:62-97`
- Submit FIFO / no in-repo guard: `grep` result (comments only), `evm.ts:13,214-218`
