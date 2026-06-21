# Handoff B — 0xobsidian: DID-first identity (`did:ethr`)

> **For:** the agent/human implementing Track B from `RFC-0xobsidian-identity-key-custody.md`.
> Read the RFC first for reasoning; this sequences the build. **Independent of Track A** (the
> keystore) — can be done before, after, or without it.
>
> **No test suite is assumed here.** Every verification step below is a small standalone script you
> run and read the output of by hand — not an addition to `shared`'s Vitest suite. If a real test
> suite for this exists later, great, but this handoff doesn't depend on one existing.

**Goal:** the author's durable identity becomes a `did:ethr` DID; the EOA becomes a *rotatable
credential under it*, not the identity itself.

## Settled already (from the RFC — don't re-litigate)

- Method = **`did:ethr`** (not `did:pkh` — welded to the EOA, breaks on rotation; not `did:key` —
  immutable). Stack = **Veramo**.
- Rotation lives in the **ethr-did-registry** contract, with **time-aware resolution** (resolve
  as-of-signing-time) so a later rotation doesn't invalidate prior provenance.
- **The DID names the owner EOA directly** (`did:ethr:0xKEY`) — settled, not a live decision.
  Reverse-lookup is free (recovered signer *is* the DID's key, just prepend `did:ethr:`); rotation
  happens in the registry. If gasless/paymaster support is later needed for authors, that's solved
  by giving the EOA a smart account to transact *through* — the smart account is an execution
  vehicle the EOA controls, not a new identity, and it does **not** change what the DID names. The
  DID continues to name the EOA regardless.
- **Provenance must be self-describing.** Embed the DID itself in `S2SContentInfo`, don't rely on
  reverse lookup. This is a different DID from the PKP's `did:pkh` (protocol identity) — don't
  conflate the two.

## B1 — Add Veramo, create the DID (no behavior change)

- Add `@veramo/core`, `@veramo/did-manager`, `@veramo/did-provider-ethr`, `@veramo/key-manager`
  (+ resolvers) to `0xobsidian`'s deps.
- On `OXOUser` creation, after the EOA exists: create `did:ethr:<chainId>:0x<EOA>` via Veramo's DID
  manager. Store the DID string alongside the existing user record. **Additive only** — nothing
  else reads or depends on it yet.

**Verify (script, not suite):** create a DID, resolve it, confirm the resolved key matches the EOA.
```ts
// scripts/verify-did-create.ts — run once by hand, read the printed output
const did = await agent.didManagerCreate({ provider: 'did:ethr', ... });
const doc = await agent.resolveDid({ didUrl: did.did });
console.log(did.did, '→', doc.didDocument.verificationMethod[0].blockchainAccountId);
// confirm by eye: the address matches the EOA you started with
```

## B2 — Prove rotation survives (the one property this track exists for)

Before touching anything else, confirm rotation doesn't break old signatures — this is what makes
`did:ethr` worth using over the status quo, so prove it in isolation before building on it:

```ts
// scripts/verify-did-rotation.ts
// 1. sign something with K1, note the timestamp T1
// 2. rotate the DID's key in the registry to K2
// 3. resolve the DID as-of T1 → must print K1
// 4. resolve the DID now → must print K2
```
Read the four printed values by eye. If step 3 doesn't return K1, **stop** — the registry/resolver
isn't behaving as assumed, and nothing past this point should be built yet.

## B3 — Embed the DID in provenance (read side only)

In `single/metadata.ts` (where `S2SContentInfo` is built and signed): add the author's `did:ethr`
as a field, alongside (not replacing) the existing PKP `did:pkh` verificationMethod.

**Verify:** publish one piece of real content, open the resulting metadata, confirm the author DID
is present and a manual `resolveDid()` call on it returns the expected key. That's it — eyeball it.

## B4 — Gate change (smallest possible diff, do last)

Only after B1–B3 are confirmed by hand. In `libs/gates.ts`: replace the `isOwner(signer,
authorSafe)` leg with "recovered signer == the key `did:ethr` currently resolves to." This is the
**only** code change to the actual checks. Everything else in the gate stays the same.

**Verify:** one real `canPublish` call, signer matching the DID's current key → passes. Same call
after rotating the key without updating anything else → fails (proves the gate is actually checking
the DID, not a cached/hardcoded address).

**Explicitly deferred past this handoff** (don't do these without a separate decision first):
- Removing the author-Safe creation flow in neutralpress, and the publication-module storage change
  for author keying. These are real, but they're a second wave *after* B4 is proven live — bundling
  them into this handoff is exactly the complexity you just flagged. Do B4, watch it work, then scope
  the storage/neutralpress change as its own small handoff.

## Done when

- B2's rotation proof passes by eye.
- One real publish carries a resolvable author DID in its provenance (B3).
- One real `canPublish` call succeeds via DID resolution and fails after an unupdated rotation (B4).
- Update `SPEC-0xobsidian` to note the DID exists and is checked; **don't** yet rewrite the
  author-Safe/cross-chain sections — that's the deferred second wave above.

## References
- `RFC-0xobsidian-identity-key-custody.md` — reasoning, method choice, alternatives.
- `SPEC-00 INV-1` — the signature the gate verifies; B4 changes how the *recovered address* is
  checked, not how the signature itself is produced.
