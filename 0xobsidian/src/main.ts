import { Plugin, SettingTab, Notice } from "obsidian";
import { DEFAULT_SETTINGS, IOxOSettings, OxOAuthorsTab } from "./settings.js";
import { IMainController, MainController } from "./main.ctrlr.js";
import { IOXOUser } from "./user/user.js";
import { probeKeystore, KeystoreProbe } from "./keystore/keystore.js";

// Use Node.js require to access native modules
const { Buffer } = require("buffer");
const { TextEncoder, TextDecoder } = require("util");

// Use Node.js native implementations
if (typeof window !== "undefined") {
  window.Buffer = Buffer;
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
}

export default class OxO extends Plugin {
  settings!: IOxOSettings;
  authorsTab!: SettingTab;
  ctrlr!: IMainController;
  /** Resolved keystore and probe detail, cached at init. */
  keystoreProbe!: KeystoreProbe;

  async onload() {


    // Probe the runtime for OS keystore availability (A0)
    this.keystoreProbe = probeKeystore();
    if (this.keystoreProbe.mode === "unavailable") {
      new Notice(
        "[oxo-core] No OS keystore available. Private key encryption is not available. " +
          "See keystore spike (src/keystore/spike.ts) for details.",
        6000,
      );
      console.warn("[oxo-core] keystore probe:", this.keystoreProbe.detail);
    }

    await this.loadSettings();
    this.authorsTab = new OxOAuthorsTab(this.app, this);
    this.addSettingTab(this.authorsTab);
    this.ctrlr = new MainController(this);
    await this.ctrlr.init()
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Restore plaintext private_key from encrypted blob (or migrate old
    // plaintext keys on first load after upgrade).
    let migrated = false;
    for (const author of this.settings.authors) {
      console.log('hello')
      if (decryptAuthorKey(author, this.keystoreProbe)) {
        migrated = true;
      }
    }

    // If we detected old plaintext keys, persist the encrypted blobs
    // immediately so data.json is cleaned up on this load cycle.
    if (migrated) {
      console.info("[oxo-core] Migration complete — persisting encrypted keys.");
      await this.saveSettings();
    }
  }

  async clearSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    await this.saveData(this.settings);
  }

  async saveSettings() {
    // Strip plaintext private_key and encrypt to key_blob before writing.
    const serializable = {
      ...this.settings,
      authors: this.settings.authors.map((author) =>
        encryptAuthorKey(author, this.keystoreProbe),
      ),
    };
    await this.saveData(serializable);
  }
}

// ── Private helpers ─────────────────────────────────────────────────

/**
 * Decrypt (or migrate) an author's key after loading from disk.
 *
 * - **key_blob exists** → decrypt into `private_key`, drop `key_blob` from
 *   the in-memory object.
 * - **private_key is a hex string (0x…) and no key_blob** → old plaintext
 *   format detected. Decrypt in-place (i.e. calculate the blob, wipe the
 *   plaintext in memory — the blob will be written on next `saveSettings()`).
 * - **neither** → leave as-is (new author, key not yet generated).
 *
 * Mutates `author` in-place. The in-memory object always has `private_key`
 * as plaintext hex; the on-disk copy never does.
 *
 * @returns `true` if an old plaintext key was detected (migration needed).
 */
function decryptAuthorKey(
  author: IOXOUser,
  probe: KeystoreProbe,
): boolean {
  const isOldPlaintext =
    author.private_key &&
    !author.key_blob &&
    author.private_key.startsWith("0x");

  if (author.key_blob) {
    // New encrypted format — decrypt into private_key
    try {
      author.private_key = probe.keystore.decrypt(author.key_blob);
    } catch (err: any) {
      console.error(
        "[oxo-core] Failed to decrypt key_blob for author",
        author.name,
        err,
      );
      // Leave private_key as-is (the blob data) — user may need to re-import
      // their key. Don't silently wipe.
    }
    // Drop blob from the in-memory object — it's only for persistence
    delete (author as any).key_blob;
  } else if (isOldPlaintext) {
    // Migration: old plaintext key found. The caller's loadSettings()
    // will detect the `true` return and call saveSettings() immediately
    // to encrypt and persist.
    console.info(
      "[oxo-core] Migrating plaintext private_key for author",
      author.name,
      "— will encrypt and persist immediately.",
    );
    return true;
  }

  return false;
}

/**
 * Encrypt an author's key for serialization.
 *
 * Turns `private_key` (plaintext, in-memory) into `key_blob` (encrypted
 * base64, on-disk) and removes `private_key` from the returned object so
 * it is never written to disk.
 *
 * Returns a new plain object — does not mutate the original.
 */
function encryptAuthorKey(
  author: IOXOUser,
  probe: KeystoreProbe,
): Record<string, any> {
  // Build a clean serializable copy, stripping private_key
  const { private_key, ...rest } = author as any;

  const serializable: Record<string, any> = { ...rest };

  if (private_key) {

    try {
      serializable.key_blob = probe.keystore.encrypt(private_key);
    } catch (err: any) {
      console.error(
        "[oxo-core] Failed to encrypt private_key for author",
        author.name,
        err,
      );
      // Fall back to storing plaintext if encryption fails — safer than
      // losing the key entirely. The error is logged and visible.
      serializable.private_key = private_key;
    }
  }

  return serializable;
}
