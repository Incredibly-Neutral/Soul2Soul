// ============================================================================
// Lit adapter — wraps shared's LitService with the CLI's Lit credentials.
// `environment: 'prod'` targets the live Lit network; preview renders still
// use the Bun runner via shared's `runAction` (S2S_RUNNER_URL).
//
// No action code ships from this CLI: LitService executes an action by CID,
// fetching the built bundle from IPFS and hashing it against that CID first. So
// the adapter has two more things to hand over than the credentials:
//
//   gateway            the Kubo endpoint the CLI already reads content through
//                      (`ipfs.<primary>.url`), NOT a second setting: a
//                      deployment that can serve a manuscript can serve an
//                      action bundle.
//   actions.encrypt    the CID of the encrypt action bundle. The source is the
//                      protocol record `lit_action_encrypt` (written by
//                      press/scripts/lit/update-protocol.ts with `pnpm
//                      actions:swap encrypt`); `lit.encryptActionCid` is the
//                      override, resolved by `buildContext` and passed in here.
//   actions.decrypt    the same for the decrypt action, from the record
//                      `lit_action_decrypt` and `lit.decryptActionCid`: the
//                      drafts read path (`drafts fetch` / `drafts pull`).
//
// Missing either one is not a fallback: that direction fails closed. With no
// CID the service's `encrypt` / `decrypt` throws naming both remedies, at the
// point of use rather than at context build — a machine that never encrypts
// must still run.
// ============================================================================

import { LitService } from '@s2s/soul2soul-shared';

import type { CliConfig } from '../core/config';
import { UsageError } from '../lib/errors';

/**
 * The gateway the action bundles are read from, as a base URL.
 *
 * `ipfs.<primary>.url` is a Kubo endpoint kept without its scheme — shared's
 * `kuboPost` prepends `https://`, which an action fetch cannot do — so the
 * scheme is added here and a trailing slash dropped. No host configured means no
 * gateway: the service refuses when it is asked to execute.
 */
function actionGateway(config: CliConfig): string | undefined {
  const url = config.ipfs.primary?.url?.trim();
  if (!url) return undefined;
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return withScheme.replace(/\/+$/, '');
}

/** What the encrypt path says when neither the config nor the record names a CID. */
export const NO_ENCRYPT_ACTION =
  'cannot encrypt: no encrypt action CID — the protocol record `lit_action_encrypt` is not written and `lit.encryptActionCid` is unset. Set the config value with `s2s config set lit.encryptActionCid <cid>`, or write the record with `src/press/scripts/lit/update-protocol.ts`';

/** What the decrypt path says when neither the config nor the record names a CID. */
export const NO_DECRYPT_ACTION =
  'cannot decrypt: no decrypt action CID — the protocol record `lit_action_decrypt` is not written and `lit.decryptActionCid` is unset. Set the config value with `s2s config set lit.decryptActionCid <cid>`, or write the record with `src/press/scripts/lit/update-protocol.ts`';

/**
 * @param encryptActionCid the resolved CID: `config.lit.encryptActionCid` when
 *   set, else the `lit_action_encrypt` record (`core/context.ts`). Undefined
 *   leaves `actions.encrypt` unset and makes `encrypt` the closed failure.
 * @param decryptActionCid the same for `actions.decrypt`.
 */
export function createLitService(
  config: CliConfig,
  encryptActionCid?: string,
  decryptActionCid?: string,
): LitService {
  const service = new LitService({
    environment: config.environment,
    accountKey: config.lit.accountKey,
    gateway: actionGateway(config),
    actions: {
      ...(encryptActionCid ? { encrypt: encryptActionCid } : {}),
      ...(decryptActionCid ? { decrypt: decryptActionCid } : {}),
    },
  });
  if (!encryptActionCid) {
    // Replaced per instance, not thrown at build time: `upload`, `preview` and
    // every read still run on a machine whose record has no encrypt key yet.
    // A rejected promise, not a throw from the call: it fails like the real
    // method, and every caller `await`s it.
    service.encrypt = () => Promise.reject(new UsageError(NO_ENCRYPT_ACTION));
  }
  if (!decryptActionCid) {
    // Same shape, same reason: `drafts fetch` and `drafts pull` are the only
    // callers, and a machine that lists drafts must run without the decrypt
    // bundle deployed.
    service.decrypt = () => Promise.reject(new UsageError(NO_DECRYPT_ACTION));
  }
  return service;
}
