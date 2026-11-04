# RFC-003 — 0xobsidian identity & key custody

> Domain: `AUTHOR` · moved from `brain/specs/RFC-0xobsidian-identity-key-custody-1.md` (2026-11-04); number assigned on the move.

> **Type:** design proposal / forward work (an RFC, not a spec). Captures *intended* changes not yet
> built, so a future agent or human can pick them up cold. Companion to `SPEC-author-identity` — that spec
> describes what *is*; this describes what we *propose*. When an item here is built, fold the settled
> parts into `SPEC-author-identity` and strike it here.
>
> **Status: Track A — DONE (see `src/keystore/` and `SPEC-author-identity`). Only Track B (DID identity)
> remains open.**
> **Context:** today identity *is* the keypair. `OXOUser` runs `ethers.Wallet.createRandom()` →
> EOA → `private_key` stored **in plaintext in `data.json`**, with the Lens account and Safe derived
> off that EOA afterward. Provenance signs `did:pkh:eip155:8453:<addr>` derived from this key. The
> tension this RFC addresses: we built an elaborate provenance/verification system and left the
> signing key in a plaintext file. Low stakes today (local machine, author-only key, no funds) — but
> incongruent with the system's own premise.

---

## Track A — Encryption-at-rest for the private key ✅ DONE

**Goal:** the `private_key` stops living as plaintext in `data.json`. Independent of Track B —
protects whatever key exists, regardless of how identity is later rooted.

**Approach: Electron `safeStorage`.** 0xobsidian runs inside Obsidian (Electron), so the
lowest-risk option is the one already in the runtime: `safeStorage.encryptString` / `decryptString`.
The encryption key is held by the **OS** (macOS Keychain / Windows DPAPI / Linux Secret Service),
never stored in our files. No native addon to compile, no ABI/Electron-version matching — which is
exactly what makes the alternatives (`@napi-rs/keyring`, the unmaintained `keytar`) riskier inside a
plugin. Keep those as the fallback only if `safeStorage` proves unreachable.

**Change shape (small):**
```
on create/import:  blob = safeStorage.encryptString(privateKey).toString('base64')  → store blob
on sign:           privateKey = safeStorage.decryptString(Buffer.from(blob,'base64'))  (in memory only)
```
The key in `data.json` becomes an opaque blob; plaintext exists only transiently while signing.

**Gating spike (do this BEFORE choosing the library):** `safeStorage` lives on Electron's **main
process**; plugins run in the **renderer**. Verify Obsidian actually exposes it to a plugin (via its
API or a reachable bridge). One check in a live plugin settles it:
- reachable → Track A is genuinely low effort, proceed with the change shape above.
- not reachable → fall back to `@napi-rs/keyring` and inherit the native-addon-in-Electron risk.

**Caveats to honor:**
- **Linux:** `safeStorage` delegates to the Secret Service; on headless/minimal setups it can be
  unavailable and Electron may fall back to *non-secure* encryption. **Always check
  `isEncryptionAvailable()`** and decide the false-case behavior (refuse / warn / accept degraded).
- **At-rest only, not a use-gate.** `safeStorage` decrypts transparently for any code running as the
  current OS user. It defeats *file copying*, not malicious local code running as you. The
  "explicit human authorization to use the key" (passkey/biometric confirm-to-sign) is a **separate,
  later layer** — see Track B. Don't oversell Track A as the full passkey vision; it's the at-rest
  half, and it kills the actual embarrassment (plaintext in a text file).

**Done when:** the private key is never written plaintext on any of the three OSes (with the Linux
availability check handled), and `SPEC-author-identity`'s "private key at rest" note is updated from
"plaintext, accepted for now" to the `safeStorage` reality.

---

## Track B — DID-first identity inversion (larger, scope before building)

**The core proposal:** invert the order. Today: wallet → identity (the EOA *is* the identity).
Proposed: **DID is the durable identity; keys are rotatable material derived/attached underneath it.**

**Critically, two decisions are bundled in "passkey → DID → derive wallet" and must be separated:**

### B1 — DID as the identity layer (endorsed)
Make the author's identity a **DID**, with the **EOA** a *rotatable credential under it*, not
identity itself. (Not a Safe — see B2's note on smart accounts: a Safe/4337 account, if one's ever
needed for gasless support, is an execution vehicle the EOA controls, not the identity.)

*Pros:*
- **Identity survives key rotation.** Today identity = keypair, so rotating the (plaintext, soon
  compromised-or-migrated) key = new identity = orphaned provenance. DID-first: DID stable, key
  beneath it rotatable, past-signed content still resolves to the same author. For a system whose
  point is durable verifiable authorship, "identity outlives any one key" is near-requirement.
- **Matches the provenance layer already built** — we sign `did:pkh` for the *protocol's* (PKP)
  identity; this gives the *author* an equivalent durable DID, rather than leaving the author as a
  bare EOA while only the protocol side is DID-named.
- **Decouples who-the-author-is from which-key/wallet/chain** — multiple keys, rotation, multi-chain
  under one identity.
- **Natural anchor for proof-of-personhood** (the litepaper's human-authorship requirement) — a DID
  takes attestations; a bare EOA doesn't.

*Cons / costs:*
- **Migration:** existing authors *are* their EOA; re-rooting under a DID is a real identity
  migration, and already-signed provenance points at the bare EOA, not yet a DID.
- **Method choice — settled, not open:** `did:ethr` (via Veramo), naming the EOA directly
  (`did:ethr:0xKEY`). **Not `did:pkh`** — `did:pkh` is welded to the address it names, so rotating
  the key produces a *different DID*, orphaning prior provenance; it cannot deliver the rotation
  property this track exists for. **Not `did:key`** — immutable, no rotation at all. `did:ethr`'s
  registry supports rotation with time-aware resolution (old signatures verify against the key that
  was current when they were signed), which is the property that makes this track worth doing.

### B2 — Passkey as root / "derive wallet from passkey" (push back / reframe)
This sounds clean but hits a cryptographic wall: **passkeys (WebAuthn) are non-exportable by design**
and sign WebAuthn assertions (P-256/ES256), not secp256k1. You **cannot** literally "derive an
Ethereum wallet from a passkey." The two real options it actually means:

- **(i) Passkey *gates* a separately-stored key** — passkey/biometric unlocks the keystore. Easier;
  composes with Track A. **Does not remove the extractable key**, just gates access to it.
- **(ii) Passkey *is* the signer via a smart account** — ERC-4337 account with a WebAuthn/P-256
  validator; no EOA at all. This is the version that removes exportable key material. **But** it
  changes the signature scheme: the author no longer produces the EOA `"lit actions auth"` signature
  the Lit gates recover (INV-1, `canPublish`/`canRead` expect an author-Safe owner EOA). So (ii)
  ripples into the **Lit auth/gate boundary** — not contained to 0xobsidian. We already use 4337
  Safes, so it's feasible, but it's an auth-boundary change, not a local one.

**Decision required before building B:** B1 yes; for B2 pick (i) [gate a key, easier, key still
exists] vs (ii) [passkey-signed smart account, removes the key, touches INV-1]. They are different
projects with different blast radii. Do not start B without naming which.

### What B needs (scoping checklist)
1. ~~Choose the DID method~~ **Settled: `did:ethr`** (via Veramo), not `did:pkh` — `did:pkh` is
   welded to the address it names and can't rotate without becoming a different DID, which breaks
   continuity with previously-signed provenance. `did:ethr`'s registry supports rotation with
   time-aware resolution, so old signatures stay valid under the key that was current when they
   were made. `did:key` is ruled out outright (immutable).
2. **Decide B2 (i) vs (ii)** explicitly — still open (passkey-as-signer, separate from the DID
   method question).
3. ~~Resolver/derivation step: DID → current signing key/account~~ **Settled: the DID names the
   owner EOA directly** (`did:ethr:0xKEY`). Not the account. Reverse-lookup is then free (a
   recovered signature's address *is* the DID's key, just prepend `did:ethr:`), and rotation is a
   registry update to the EOA's record — it does not touch any account. If gasless/paymaster support
   is later added for authors, the EOA gets a smart account to transact *through*; that smart account
   is an execution vehicle the EOA controls, not a new identity, and does not change what the DID
   names.
4. **Migration story** for EOA-rooted authors and their already-signed provenance.
5. **Electron-reachability spike** (shared with Track A) — whichever route, something secret-ish
   still lives on the machine and the OS must protect it.

---

## Sequencing (recommended)

1. ~~**Track A now-ish** — ✅ DONE. Implemented in `src/keystore/` (SafeStorageKeystore,
   PlaintextKeystore fallback, migration for existing keys).~~
2. **Track B scoped, not rushed** — right long-term architecture, but interacts with the auth
   boundary (if B2-ii) and needs the method decision up front. Capture; revisit deliberately.

**Do not bundle A and B, and do not bundle B1 and B2.** The whole value of this RFC is keeping those
three decisions separate so each can be made (or deferred) on its own merits.
