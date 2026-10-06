# Handoff: owner-history module (time-aware key authorization for the Safe)

**Date:** 2026-09-12
**Scope:** Design the "ownership-history" primitive that lets a content signature remain verifiable after Safe owner rotation. Decision fork identified (on-chain vs off-chain verification); thin guard-based recorder sketched. **Investigation + design only — no code touched.**
**Status:** Design agreed with joera. One fork open (see §6) that decides whether the on-chain recorder is built at all. Two stale spec sections need updating regardless (§7).

---

## 1. Why — the full reasoning chain

The Safe (the identity) has no private key, so it cannot produce an ECDSA signature over source material. An owner EOA signs the EIP-712 payload instead. That signature's claim is:

> "an authorized controller of the account signed these exact bytes at time T."

The problem: if "was this signer authorized?" is checked only against the **current** owner set, then every rotation makes every old signature unverifiable. Old work, old deals, and (critically) the off-chain source material all decay. The alternatives — re-sign the world after each rotation, or treat signatures as decorative — are both unacceptable.

The on-chain publication record proves *"the account published contentHash at block N"* — but it does **not** prove *"an authorized controller signed these specific off-chain bytes at time T."* That second claim is what the signature carries, and it needs time-aware authorization to remain checkable.

**Non-goal being defended against:** making signatures durable via a DID. We explicitly dropped DIDs — see §2.

## 2. Context — decisions already made (do not re-litigate)

- **Identity = the Safe (smart account). Full stop. No DID.**
  - No `did:ethr` string, no ERC-1056 registry, no delegate layer, no `did:pkh` debate.
  - The account address **is** the identifier. Rotation swaps keys, never the identity.
  - The "fascination with DIDs" came from wanting non-blockchain audiences to find it acceptable — confirmed to be window dressing, not a requirement.
- **Rotation survival** must be delivered by the Safe remembering its own keys — not by an external registry pretending to be a DID.
- The owner-history module is **distinct** from the author's records module (curated catalog of works). Keys vs. works — do not conflate.
- Signatures over source material remain load-bearing (off-chain content, deals, disputes). The on-chain record does **not** subsume them.

## 3. Safe ecosystem facts (verified)

| What | Exists? | Detail |
|---|---|---|
| Gap-free owner history | **Yes, natively** | `AddedOwner` / `RemovedOwner` / `ChangedThreshold` events emitted in the **same tx** as the owner-set mutation. Single-writer, atomic, never forgets. |
| Off-chain history read | **Yes** | Safe's own indexing service (transaction service / Safe{Wallet}) shows owner changes; raw events are replayable by any indexer. |
| Time-aware on-chain query (`isOwnerAt`) | **No** | Safe's native EIP-1271 `isValidSignature` checks **current** owners/threshold only. No contract or Lit action can replay events inside an `eth_call`. |
| Hook for "observe every tx atomically" | **Yes** | Guard mechanism (`IGuard` / `setGuard`) — called before every `execTransaction`; reverts with the tx. The ecosystem's native "wrap everything" tool. |
| Extension point for account behavior | **Yes** | Modules (`execTransactionFromModule`). |

**Implication:** the *data* needs nothing built. What's missing is the *queryable materialization* — on-chain state that answers "was X an owner at time T." Build that only if a contract or Lit action needs the answer (§6).

## 4. Design — validity windows, borrowed in shape only

Store append-only owner records with validity windows (did:ethr *model*, not its storage — see §5):

- Record = `(owner, validFrom, validTo)` where `validTo == 0` means "still valid."
- Rotation closes the old key's window at `block.timestamp` (optionally + grace overlap) and opens the new key's window at `block.timestamp`. **Old keys are never deleted** — a past `validTo` means "valid then, not now," which is exactly the historical answer.
- Queries:
  - `isOwnerAt(owner, t) → bool` — the primitive every signature check needs.
  - `getOwnersAt(t) → address[]` — the authorized set at a point in time.
  - `isSignatureAuthorizedAt(hash, sig, t) → bool` — convenience: recover + `isOwnerAt`.
- The recorder is a **projection**, not an authority. The Safe's event log is the truth; the module is the queryable cache. A drift can therefore be detected by comparing module state to replayed events (audit), and it has no independent power.

### Attachment point: guard, for completeness

History must have **no gaps** — a gap = an unverifiable window = broken verification. The guard is the only attachment that guarantees this, because it wraps **every** `execTransaction` (even a direct `swapOwner` from the Safe UI), and its storage changes revert atomically with a failed tx. A module that is the *sole* rotation path also works but requires enforcing that no other path exists.

Sketch (`protocol/contracts/`):

```solidity
// Installed via Safe.setGuard(address(this)). Recorder only — blocks nothing.
contract OwnerHistoryGuard is IGuard {
    struct OwnerRecord { address owner; uint256 validFrom; uint256 validTo; } // validTo 0 = open
    address public immutable safe;
    OwnerRecord[] public history;                        // append-only, chronological
    mapping(address => uint256[]) public windowsOf;      // indices per owner, for queries

    constructor(address _safe) {
        safe = _safe;
        address[] memory current = Safe(_safe).getOwners();     // seed at install
        for (uint i; i < current.length; i++) _open(current[i]);
    }

    function checkTransaction(
        address to, uint256, bytes calldata data, Enum.Operation,
        uint256, uint256, uint256, address, address payable,
        bytes calldata, address
    ) external {
        require(msg.sender == safe, "only the safe");
        if (to != safe || data.length < 4) return;              // not an owner mutation
        bytes4 sel = bytes4(data[:4]);
        if (sel == bytes4(keccak256("addOwnerWithThreshold(address,uint256)"))) {
            (address o, ) = abi.decode(data[4:], (address, uint256));
            _open(o);                                           // re-add: closes any open window first
        } else if (sel == bytes4(keccak256("removeOwner(address,address,uint256)"))) {
            (, address o, ) = abi.decode(data[4:], (address, address, uint256));
            _close(o);
        } else if (sel == bytes4(keccak256("swapOwner(address,address,address)"))) {
            (, address old_, address new_) = abi.decode(data[4:], (address, address, address));
            _close(old_); _open(new_);
        }
    }
    function checkAfterExecution(bytes32, bool) external {}

    function isOwnerAt(address owner, uint256 t) external view returns (bool) {
        uint256[] storage idx = windowsOf[owner];
        for (uint i; i < idx.length; i++) {
            OwnerRecord storage r = history[idx[i]];
            if (r.validFrom <= t && (r.validTo == 0 || t < r.validTo)) return true;
        }
        return false;
    }
    // _open closes any open window for the address, then pushes a new record.
    // _close sets validTo = block.timestamp on the address's open window.
}
```

Notes:
- The guard records the *intended* mutation in `checkTransaction`; if the tx fails, the record reverts with it — atomic, gap-free.
- Only install on new/known Safes; a malicious owner set replacing the guard is itself an owner-level decision (the guard is governance, not an authority over the Safe).
- Threshold changes (`changeThreshold`) don't alter *who* is authorized — no record needed (but worth one line in the handoff thread: a signature check should use the owner set, not threshold).

## 5. Relationship to did:ethr — model, not a copy

- **Borrowed:** the *model* — time-aware validity, old keys stay resolvable, the question "was this key valid at T."
- **Not borrowed (copying would fail):** ERC-1056's storage is a **single current value + expiry per slot, overwritten on change**, with history only in events. It does **not** provide on-chain historical queries — the exact gap we're closing. Copying it would reproduce that gap.
- **Not borrowed:** per-identity nonces, EIP-191 meta-signed variants (`changeOwnerSigned` etc.), ecrecover authorization — dead weight for a Safe that has no key to sign them. Authorization here is the Safe's `execTransaction`/guard path.
- **Authority:** ERC-1056 is an independently writable registry; this is a single-writer projection on the Safe. That is the whole "one source of truth" requirement.

## 6. The fork — the one decision that gates the build

**Does any contract or Lit action need to verify a signature against historical owners (`eth_call`)?**

- **If yes** (expected — the render/decrypt gates are Lit actions doing `evmRead`, and we want signature verification to be protocol-level): build the guard-recorder (§4).
- **If all verification is off-chain** (our app, our indexers, Safe's API): **do not build the module.** Read the Safe's events and answer "owner at time T" in the indexer. Less machinery.

Recommendation: build the guard-recorder, because (a) Lit actions cannot replay events, (b) a protocol-level, on-chain-queryable answer is the only honest one for a durable signature primitive, (c) the guard is small, native-Safe, and harmless when unused. But the fork should be **explicitly confirmed** with joera before implementation.

## 7. Integration points — stale spec sections to fix regardless

These are wrong **today**, independent of this module, and the §1 Identity rewrite should fold them in:

- `prototype-soul2soul.md` **§1.2** still claims `did:ethr` and DID-first — superseded: identity = Safe, no DID.
- **§1.3 Rotate** — the "[forward] DID-first registry update" framing is dead; rotation is owner swap + this history.
- **§1.4 Recover** — still correct as a **[shortfall]** (no recovery today) — unchanged.
- **§3.4** overstates: the EIP-712 content signature is **present but unverified** in the render path (`verifyAuthorship` has zero call sites; `eoaOf(author)` is stale for the Safe-author model). Content sig should be reframed as a handshake + the object the history module makes durable — not a current-owner check.
- **Gate semantics** (`protocol/actions/src/libs/gates.ts`): `canRead`/`canPublish` check the *signer* EOA's current ownership. This is correct for **access** (contemporary), and must *not* be the mechanism for **authorship**. Keep the two apart.

## 8. Next steps (in priority order)

1. Confirm the §6 fork with joera (on-chain recorder vs indexer-only).
2. Rewrite `prototype-soul2soul.md` §1 Identity: identity = Safe, rotation = owner swap, history = §4 recorder (with fork noted), recovery unchanged, delete DID framing.
3. If building: port the §4 sketch into `protocol/contracts/`, add events per record (they are the audit/truth layer), unit-test atomicity (failed owner change → no orphan record), and expose `isOwnerAt` to the Lit actions as an `evmRead` target.
4. Decide grace-overlap semantics for `validTo` on rotation (overlap recommended: avoids a window between old-key-end and new-key-start for reads in flight).
5. Wire a signature-verification consumer (repair or replace `verifyAuthorship`) once the recorder exists — until then, keep the EIP-712 content sig explicitly documented as **unverified**.
