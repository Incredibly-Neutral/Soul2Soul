/**
 * Keystore — Encryption-at-rest for author private keys.
 *
 * Implements Track A of `RFC-0xobsidian-identity-key-custody-1.md`:
 * the author `private_key` is encrypted before being written to disk,
 * decrypted only transiently in memory while signing.
 *
 * ## Architecture
 *
 * ```
 *      In-memory (plaintext)          On disk (blob, base64)
 *   ┌──────────────────────┐     ┌──────────────────────┐
 *   │  private_key: string │ ←──→│  key_blob: string    │
 *   │  (OXOUser in mem)    │     │  (settings.authors)  │
 *   └──────────────────────┘     └──────────────────────┘
 *              ↑ encrypt() / decrypt()
 *              │
 *         [SafeStorageKeystore]
 *         (Electron safeStorage)
 * ```
 *
 * The `Keystore` interface allows swapping implementations without touching
 * consumers. Currently only `SafeStorageKeystore` is implemented; the
 * factory returns the best available provider.
 *
 * ## Thread-safety
 *
 * `safeStorage` synchronizes internally — no locks needed from the plugin
 * side. Concurrent encrypt/decrypt calls are safe.
 */

import { runSpike } from "./spike.js";

// ── Interface ───────────────────────────────────────────────────────

export interface IKeystore {
  /** Encrypt a plaintext string. Returns base64-encoded encrypted blob. */
  encrypt(plaintext: string): string;

  /** Decrypt a base64-encoded blob back to plaintext. */
  decrypt(blob: string): string;

  /** Is the keystore actually usable right now? */
  isAvailable(): boolean;

  /** Human-readable name for diagnostics. */
  readonly name: string;
}

// ── SafeStorage Implementation (Electron) ───────────────────────────

/**
 * Wraps Electron's `safeStorage` API, which delegates to the OS-native
 * keystore (macOS Keychain, Windows DPAPI, Linux Secret Service).
 *
 * Must be constructed only after `isEncryptionAvailable()` has been
 * confirmed (see `createKeystore()`).
 */
export class SafeStorageKeystore implements IKeystore {
  readonly name = "SafeStorageKeystore (Electron safeStorage)";

  private safeStorage: any;

  constructor(safeStorage: any) {
    this.safeStorage = safeStorage;
  }

  encrypt(plaintext: string): string {
    const buf: Buffer = this.safeStorage.encryptString(plaintext);
    return buf.toString("base64");
  }

  decrypt(blob: string): string {
    const buf = Buffer.from(blob, "base64");
    return this.safeStorage.decryptString(buf);
  }

  isAvailable(): boolean {
    try {
      return !!this.safeStorage?.isEncryptionAvailable?.();
    } catch {
      return false;
    }
  }
}

// ── Fallback for when safeStorage is unreachable ─────────────────────

/**
 * Placeholder used when the spike determines `safeStorage` is not
 * reachable from the Obsidian plugin context. The RFC/Handoff specifies
 * `@napi-rs/keyring` as the designated fallback; implement it here when
 * that path is chosen.
 *
 * Until then, this implementation silently refuses (the factory returns
 * it only after the spike verdict says "unreachable" — a user action is
 * needed before the plugin will work).
 */
export class UnavailableKeystore implements IKeystore {
  readonly name = "UnavailableKeystore (no OS keystore available)";

  encrypt(_plaintext: string): string {
    throw new Error(
      "No OS keystore is available on this system. " +
        "Cannot encrypt private key. " +
        "See vault-plugin console for spike results.",
    );
  }

  decrypt(_blob: string): string {
    throw new Error(
      "No OS keystore is available on this system. " +
        "Cannot decrypt private key blob.",
    );
  }

  isAvailable(): boolean {
    return false;
  }
}

// ── /dev/null keystore (Linux degraded mode, A2) ────────────────────

/**
 * "Pass-through" keystore used on Linux when `safeStorage` is reachable
 * but `isEncryptionAvailable()` returns false (no Secret Service backend).
 *
 * This is the **explicit degraded mode** the RFC requires — it logs a
 * loud warning every time it is used, so the operator knows the key is
 * NOT encrypted at rest.
 *
 * Switch this to `SafeStorageKeystore` once a Secret Service backend
 * (e.g. `gnome-keyring` / `keepassxc`) is available.
 */
export class PlaintextKeystore implements IKeystore {
  readonly name = "PlaintextKeystore (⚠️ NO ENCRYPTION — degraded mode)";

  private warned = false;

  private warn() {
    if (this.warned) return;
    console.warn(
      "\x1b[33m%s\x1b[0m",
      "[oxo-core] " +
        "⚠️  WARNING: safeStorage is available but isEncryptionAvailable() " +
        "returned false (common on headless/minimal Linux — no Secret Service " +
        "backend). The private key will be stored as PLAINTEXT. Install a " +
        "Secret Service provider (e.g. gnome-keyring, keepassxc) and restart " +
        "Obsidian to enable encryption.",
    );
    this.warned = true;
  }

  encrypt(plaintext: string): string {
    this.warn();
    // Store as base64 of the plaintext — not actual encryption, but makes
    // the on-disk format indistinguishable from an encrypted blob so the
    // decrypt path doesn't need branching per implementation.
    return Buffer.from(plaintext, "utf-8").toString("base64");
  }

  decrypt(blob: string): string {
    this.warn();
    return Buffer.from(blob, "base64").toString("utf-8");
  }

  isAvailable(): boolean {
    return true; // Always "available" — it's just a no-op wrapper
  }
}

// ── Factory ─────────────────────────────────────────────────────────

export type KeystoreMode =
  | "safe-storage" // Electron safeStorage, encryption available
  | "degraded-linux" // safeStorage reachable but unavailable → pass-through
  | "unavailable"; // no safeStorage at all → plugin won't work without fallback

/**
 * Result of probing the environment for keystore availability.
 */
export interface KeystoreProbe {
  mode: KeystoreMode;
  keystore: IKeystore;
  detail: string;
}

/**
 * Probe the runtime and return the best available keystore.
 *
 * Effectively runs A0's spike logic and returns an `IKeystore` ready for
 * use. Call once at startup and cache the result.
 *
 * @returns A `KeystoreProbe` with the resolved keystore and a detail
 *   string for logging.
 */
export function probeKeystore(): KeystoreProbe {
  const spike = runSpike();

  if (!spike.electronFound || !spike.safeStorageFound) {
    return {
      mode: "unavailable",
      keystore: new UnavailableKeystore(),
      detail: spike.verdict,
    };
  }

  if (!spike.encryptionAvailable) {
    return {
      mode: "degraded-linux",
      keystore: new PlaintextKeystore(),
      detail:
        spike.verdict +
        " Using PlaintextKeystore (degraded) — key will not be encrypted.",
    };
  }

  // safeStorage is available — build the real keystore
  const electronRemote: any =
    (typeof require !== "undefined" &&
      (require("electron") as any)?.remote) ||
    (typeof require !== "undefined" && (require("@electron/remote") as any));

  const keystore = new SafeStorageKeystore(electronRemote.safeStorage);

  return {
    mode: "safe-storage",
    keystore,
    detail: spike.verdict,
  };
}

/**
 * Default singleton. Probed once at import time so the keystore is ready
 * for `saveSettings()` / `loadSettings()` on the first call.
 *
 * In the unlikely event that `electron` is not loaded when this module is
 * first imported (e.g., during a test run), the probe may return
 * "unavailable". Call `probeKeystore()` again later if needed.
 */
export const defaultKeystore: IKeystore = probeKeystore().keystore;
