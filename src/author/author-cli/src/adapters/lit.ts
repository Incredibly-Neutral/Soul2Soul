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
//   actions.encrypt    `lit.encryptActionCid`, the CID `pnpm actions:swap
//                      encrypt` registered on the Lit group.
//
// Missing either one is not a fallback: LitService throws naming the missing
// key when the action is called, which is the encrypt path's closed failure.
// ============================================================================

import { LitService } from '@s2s/soul2soul-shared';

import type { CliConfig } from '../core/config';

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

export function createLitService(config: CliConfig): LitService {
  const encrypt = config.lit.encryptActionCid;
  return new LitService({
    environment: config.environment,
    accountKey: config.lit.accountKey,
    gateway: actionGateway(config),
    actions: encrypt ? { encrypt } : undefined,
  });
}
