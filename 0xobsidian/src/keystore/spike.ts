/**
 * A0 — safeStorage Reachability Spike
 *
 * Run this once from inside a running Obsidian plugin to determine whether
 * Electron's main-process `safeStorage` API is reachable from the renderer
 * (where Obsidian plugins live).
 *
 * ## How to run
 *
 * Paste into the Obsidian dev console (Ctrl+Shift+I → Console) while
 * `oxo-core` is loaded:
 *
 *   ```ts
 *   const plugin = app.plugins.plugins["oxo-core"];
 *   await plugin.ctrlr.keystoreSpike();
 *   ```
 *
 * Or call the standalone function:
 *
 *   ```ts
 *   import { runSpike } from "./keystore/spike";
 *   const result = runSpike();
 *   console.table(result);
 *   ```
 *
 * ## What it checks
 *
 * | Check | Meaning |
 * |---|---|
 * | `safeStorage object` | Is the module found on electron.remote? |
 * | `can encrypt` | Does `safeStorage.isEncryptionAvailable()` return true? |
 * | `encrypt round-trips` | Can we encrypt and then decrypt the same string |
 * | `result is base64` | The encrypted blob is a base64 string (storable) |
 *
 * ## Interpreting results
 *
 * | safeStorage? | isEncryptionAvailable? | Action |
 * |---|---|---|
 * | ✅ reachable | ✅ true | Proceed with A1 (SafeStorageKeystore) |
 * | ✅ reachable | ❌ false | Implement A2 (Linux fallback) |
 * | ❌ unreachable | N/A | Fall back to @napi-rs/keyring |
 */

export interface SpikeResult {
  /** Was the `electron` module found? */
  electronFound: boolean;
  /** Was `safeStorage` found on electron.remote? */
  safeStorageFound: boolean;
  /** `safeStorage.isEncryptionAvailable()` value, or null */
  encryptionAvailable: boolean | null;
  /** Did a round-trip encrypt/decrypt of "test" succeed? */
  roundTripOk: boolean | null;
  /** Human-readable summary */
  verdict: string;
}

/**
 * Run the spike. Returns a detailed result object — safe to call even when
 * `safeStorage` is unavailable (no throws, everything caught).
 */
export function runSpike(): SpikeResult {
  const result: SpikeResult = {
    electronFound: false,
    safeStorageFound: false,
    encryptionAvailable: null,
    roundTripOk: null,
    verdict: "",
  };

  try {
    // Obsidian loads Electron's remote module via @electron/remote in modern
    // versions, or via the deprecated electron.remote in older ones. Try both.
    const electronRemote: any =
      (typeof require !== "undefined" &&
        (require("electron") as any)?.remote) ||
      (typeof require !== "undefined" &&
        (require("@electron/remote") as any));

    result.electronFound = !!electronRemote;

    if (!electronRemote) {
      result.verdict =
        "UNREACHABLE — electron.remote not found. Fall back to @napi-rs/keyring.";
      return result;
    }

    const safeStorage = electronRemote.safeStorage;
    result.safeStorageFound = !!safeStorage;

    if (!safeStorage) {
      result.verdict =
        "UNREACHABLE — safeStorage not found on electron.remote. Fall back to @napi-rs/keyring.";
      return result;
    }

    const available = safeStorage.isEncryptionAvailable();
    result.encryptionAvailable = available;

    if (!available) {
      result.verdict =
        "REACHABLE but UNAVAILABLE — isEncryptionAvailable() is false. Implement A2 Linux fallback.";
      return result;
    }

    // Round-trip test
    const testValue = "__s2s_spike_test__";
    const blob: Buffer = safeStorage.encryptString(testValue);
    const roundTrip: string = safeStorage.decryptString(blob);
    result.roundTripOk = roundTrip === testValue;

    if (result.roundTripOk) {
      result.verdict =
        "✅ REACHABLE AND WORKING — proceed with A1 implementation (SafeStorageKeystore).";
    } else {
      result.verdict =
        "⚠️  REACHABLE but round-trip failed — investigate before proceeding.";
    }
  } catch (err: any) {
    result.verdict = `ERROR — ${err?.message ?? String(err)}`;
  }

  return result;
}
