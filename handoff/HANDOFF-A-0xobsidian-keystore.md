# Handoff A — 0xobsidian: key-at-rest (`safeStorage`)

> **For:** the agent/human implementing Track A from `RFC-0xobsidian-identity-key-custody.md`.
> Read the RFC first for reasoning; this sequences the build. **Independently shippable** — no
> dependency on Track B (DID identity), which is a separate handoff.

**Goal:** `private_key` is never written to `data.json` in plaintext. Nothing else changes — same
EOA, same Lens/Safe derivation, same gates. Encryption-at-rest only, not an auth model change.

## A0 — Spike (do not skip; this gates the whole track)

Confirm `safeStorage` is reachable from inside an Obsidian plugin (it's an Electron **main-process**
API; plugins run in the **renderer**). One check, inside a real running plugin:
```ts
// does this resolve, and does isEncryptionAvailable() return true on this OS?
const { safeStorage } = require('electron').remote ?? require('@electron/remote');
console.log(safeStorage?.isEncryptionAvailable?.());
```
- **Reachable + available** → proceed with A1.
- **Unreachable** → fall back to `@napi-rs/keyring` (native addon — re-verify it loads inside
  Obsidian's Electron build before committing; this is the riskier path the RFC flagged).
- **Reachable but `isEncryptionAvailable()` is false** (common on headless/minimal Linux — no
  Secret Service backend) → see A2.

## A1 — Implementation (once A0 confirms reachability)

In `0xobsidian/user/user.ts` (`OXOUser`) and wherever `private_key` is persisted/read in
`settings.ts` / `settings.factory.ts`:
```ts
// on create/import — replaces plaintext write
const blob = safeStorage.encryptString(privateKey).toString('base64');
// store `blob` in settings, NOT privateKey

// on load / before signing — replaces plaintext read
const privateKey = safeStorage.decryptString(Buffer.from(blob, 'base64'));
```
- The plaintext key exists only transiently in memory while signing; never written to disk again.
- **Migration:** existing installs have a plaintext `private_key` already in `data.json`. On load,
  detect the old plaintext shape (no `blob` field, or a raw hex string where `blob` is expected),
  encrypt it once, rewrite settings, and **only then** drop the plaintext field. Don't silently
  discard an unmigrated key — log a clear one-time notice.

## A2 — Linux availability fallback (do not skip)

If `isEncryptionAvailable()` is false, **do not** let Electron silently fall back to weak/no
encryption. Decide and implement one explicit behavior:
- refuse (block key creation/use until a Secret Service backend exists), **or**
- warn loudly and proceed with plaintext as a known degraded mode (acceptable per RFC's "low
  stakes" framing — but make it a visible, logged choice, not a silent one).

Either is fine; *silent* degradation is not.

## Done when

- No plaintext `private_key` is ever written, on any of the three OSes (with A2's explicit Linux
  behavior in place).
- A pre-existing plaintext-key install migrates cleanly on first load post-upgrade.
- Update `SPEC-0xobsidian`'s "private key at rest" note from "plaintext, accepted for now" to the
  `safeStorage` reality — **and strike Track A from the RFC** once this lands.

## References
- `RFC-0xobsidian-identity-key-custody.md` — reasoning, why `safeStorage` over a native keyring.
- `SPEC-0xobsidian` — to be updated when this lands.
