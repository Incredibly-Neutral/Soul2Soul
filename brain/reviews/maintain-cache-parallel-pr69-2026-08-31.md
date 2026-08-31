# Review — PR #69: Parallel maintain-cache action (fix/maintain-cache-parallel-action)

**Date:** 2026-08-31
**Reviewer:** DeepSeek V4 Flash 0731
**Base/Head:** main ← fix/maintain-cache-parallel-action
**Scope judged:** PR diff (774 lines) + persisted contract. No source edited; branch files read via `git show origin/fix/...`.

**Gates (re-confirmed this run):**
- `pnpm -C shared run build` → **EXIT 0** (validates the `_AssertMaintainCacheInputMatches` sentinel + all type/schema edits compile).
- `vitest run src/rendering/action-io.test.ts` → **41/41 passed**.
- build-actions.cjs emits `dist/maintain-cache/main.js` entry (see §5).

---

## Acceptance contract — verdict per item

### 1. protocol/actions/src/maintain-cache/main.ts — **MET**

New self-contained action (202 lines). Verified against branch bytes:

- **Self-contained re-derive:** `requireFields(input, ['publication','signature','authorSafeAddress','endpoints'])` (line 62); `getDomainOwnerAndModules` → `getProtocolInfo` → `getDeals` (113) + `catFile(parseArchive)` (114) + `reconcile(deals, archive)` (115). Imports the exact `libs/archive.factory` surface (`parseArchive, reconcile, mergeArchive, serialize`), `libs/module.factory` (`getDeals`), `libs/ipfs.factory` (`catFile, uploadFile`), `libs/evm` (`evmRead, evmWrite, toHexString`), `libs/gates` (`canPublish`), `libs/helpers` (`requireFields`).
- **Fetch+merge only drifted FULL items:** `needsFetch` drives a `Promise.all` that `catFile`s each drifted `entry.cid` and parses it into a full `S2SContentItem` in a `Map` (lines ~136-146); `mergeArchive(archive, deals, refreshed)` + `serialize` + `uploadFile` pin (154-155).
- **Pin + pointer write:** `evmWrite('L2', pkp, ensRecords, RECORDS_CONTRACT_ABI, 'setText', [node, cacheKey, toHexString(newCid)], true, rpc)` — `confirm:true` correctly lands in the 7th positional slot of `libs/evm.ts` (signature `(chain, pkp, contractAddress, abi, method, args, confirm=false, rpc?)`), and `cacheKey = content_cache_${publication}` matches the render/update pointer name. Mirrors the provably-reliable update `contenthash_wrapped` write.
- **Idempotent — zero writes on steady state:** `needsFetch.length === 0` returns `{ok:true, data:{cid:'',wrote:false}}` before any pin/setText (124-128).
- **Gated by canPublish:** line 80, `if (!preview) { if (!(await canPublish(...))) throw 'cannot publish'; }` — same gate as update.
- **Bootstrap + skip-nothing-fetchable:** empty pointer ⇒ `archiveCid ? parseArchive(...) : null` (114) — mirrors render's bootstrap; if drifted entries are un-fetchable, `refreshed.size === 0` early-returns `{cid:'',wrote:false}` (149-151), no pointless pin/tx.
- **Never throw:** whole body in `try/catch` → `ok:false` envelope (178, 194). Pointer-read failure is additionally wrapped (lines ~100-106) and treated as empty bootstrap.
- **Mirrors render write-back:** byte-equivalent logic to `writeBackArchiveCache` in render/main.ts (reconcile/needsFetch/merge/serialize/pin/setText), except it re-fetches drifted FULL items itself (correct — it has no in-session `drift.fetchedItems`), and it gates+confirms the pointer write (render's is best-effort/optional). Consistent.

### 2. Render inline write-back KEPT + maintainCachePending signal — **MET**

- **`writeBackArchiveCache` untouched** in render/main.ts — diff only *adds* `let maintainCachePending = false;` (render/main.ts:195 area) and `maintainCachePending = shouldFire;` beside `const shouldFire = shouldWriteBackCache(maintainCache, preview, drift);` (~line 458). The inline `await writeBackArchiveCache({...})` block and its try/catch remain. ✅ fallback path intact.
- **Signal surfaced:** success envelope now carries `data: {... , maintainCache: maintainCachePending}` (render/main.ts ~522). Matches `SingleData.maintainCache?: boolean` and `SingleActionOutputSchema.maintainCache: z.boolean().optional()`.

### 3. sequence.ts renderwithLitActions firing — **MET**

- Fires **after the update action completes**: maintain-cache block sits after `const evmAction = await runAction(...)` + `validateEvmUpdateOutput` + `if (validated.ok) cid = ...` (sequence.ts ~278-286 → parallel block from ~289). The two PKP setText writes (update + maintain-cache) are therefore on consecutive nonces — no `getTransactionCount("pending")` nonce collision. Justified and correct.
- **Own fresh session:** `runAction` → (prod) `lit.executeAction` → one `HTTP POST /lit_action` per call (shared/src/lit/lit.service.ts:256), i.e. a brand-new Lit session/budget/provider each run — not wedged into the render's tail. Dev `preview` path is disabled here anyway (`!preview` guard). ✅
- **Gating:** `if (!preview && maintainCachePending && protocolInfo.litActions.maintainCache)` (sequence.ts ~297). `maintainCachePending` derived from any successful render `data.maintainCache === true` (~232). `litActions.maintainCache` is optional/falsy until deployed — safe.
- **Best-effort, never fails publish:** wrapped in `try { ... } catch (err) { maintainCacheResult = {ok:false,...} }`, logged `LOUDLY` on both throw and completion, and only mutated `maintainCacheResult` (the envelope field) — the already-successful `validated`/`cid` publish result is untouched. ✅
- **Result on envelope:** `maintainCache: maintainCacheResult` (sequence.ts ~357) — null when not fired, else the action result.

### 4. Types / schemas / io — **MET (interface ↔ schema MATCH enforced)**

- **types.ts:** `MaintainCacheInput` (publication, signature, authorSafeAddress, preview?, endpoints{ipfsGateway?, rpcs{L1,L2}}) + `MaintainCacheData {cid, wrote}`; `SingleData.maintainCache?: boolean`. Exported via `lit-actions.ts`.
- **action-io.ts:** `MaintainCacheActionInputSchema` / `MaintainCacheActionOutputSchema` (via `ActionResultSchema`, `cid: z.string()` required-but-may-be-empty with `wrote: z.boolean().optional()`), `validateMaintainCacheInput/Output`, and compile-time sentinel `_AssertMaintainCacheInputMatches = MaintainCacheInput extends MaintainCacheActionInput ? true : never`.
- **Interface ↔ schema match:** `MaintainCacheInput` and `MaintainCacheActionInput` agree field-for-field (incl. `L1/L2: string[]` vs `z.array(z.string()).min(1)` — same inferred `string[]`). Sentinel typechecks under `tsc` (shared build EXIT 0). ✅
- **protocolSchema.ts:** `maintainCache: z.string().optional()` added to `litActions`. **S2SProtocolInfo.ts:** `litActions.maintainCache?: string` optional. Both present and consistent.

### 5. Build / deploy wiring — **MET**

- **build-actions.cjs:** new entry `{in: './protocol/actions/src/maintain-cache/main.ts', out: './protocol/actions/dist/maintain-cache/main.js'}`.
- **swap-action.ts:** `validActions = ['prep','render','update','maintain-cache','encrypt']`.
- **update-protocol.ts:** signature gains optional `maintainCacheActionCid?`; `setRecord("lit_action_maintainCache", ...)` only when CID supplied (spread guard → backward compatible pre-deploy); `main()` resolves `maintain-cache` from the group and passes `maintainCache?.cid`. The `lit_action_maintainCache` record name matches protocol/index.ts read key exactly.
- **protocol/index.ts:** `lit_action_maintainCache` added to both the destructure and the `getRecords` keys array (same position/order), surfaced as `litActions.maintainCache: lit_action_maintainCache || undefined`.
- **lit-actions.ts:** exports `MaintainCacheData`, `MaintainCacheInput`.

### 6. Tests — **MET** (runtime-confirmed)

- `action-io.test.ts` adds `validateMaintainCacheInput` (valid + optional preview + rejects missing publication/signature/L2) and `validateMaintainCacheOutput` (ok:true wrote, steady-state wrote:false, rejects missing cid, ok:false envelope) suites, plus `validateSingleOutput` maintainCache:true + omitted.
- Ran locally: **41/41 passed** under vitest v4.

---

## Blocking issues

- **None.**

## Non-blocking notes

1. **Output schema/interface asymmetry (minor):** `MaintainCacheActionOutputSchema` has `wrote: z.boolean().optional()` while `MaintainCacheData` declares `wrote: boolean` (required) and there is **no sentinel on the output** (only input). Harmless today (both call sites always emit `wrote`), but adding an `_AssertMaintainCacheOutputMatches` sentinel would future-proof it.
2. **Not truly concurrent (intentional):** the maintain-cache action is *awaited inline after* the update action, so it serializes into the publish RPC latency rather than running fire-and-forget. This is the correct trade-off per the contract (sequenced nonces, observable result) — just ensure callers aren't expecting near-zero added latency to the publish call.
3. **Named/observable failure only via envelope/log:** the render's inline write-back is still the first-attempt path and the parallel action is a second attempt + fallback; a fully dropped pointer is now logged loudly (better than the old silent fire-and-forget) but there is still no external alerting hook. Fine for this PR's scope.
4. **Latency of `confirm:true`:** the maintain-cache `evmWrite(confirm:true)` awaits the mined receipt (same as update's reliable path) — this is the intended reliability-enhancing behavior; just budget for the added block-confirmation time.

---

## Overall verdict: **APPROVE**

All six acceptance-contract items are MET with explicit file:line evidence above, verified against the actual branch (not just the diff). Shared build passes (sentinel + types compile), the new action-io tests pass 41/41, and the deploy/protocol wiring is consistent (matching `lit_action_maintainCache` record name across update-protocol.ts / protocol/index.ts / protocolSchema / S2SProtocolInfo). No blocking issues. The two non-blocking notes (output-sentinel asymmetry, serialized-not-parallel latency) are worth a follow-up but do not gate this merge.
