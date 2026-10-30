// ============================================================================
// Lit adapter — wraps shared's LitService with the CLI's Lit credentials.
// `environment: 'prod'` targets the live Lit network; preview renders still
// use the Bun runner via shared's `runAction` (S2S_RUNNER_URL).
// ============================================================================

import { LitService } from '@s2s/soul2soul-shared';

import type { CliConfig } from '../core/config';

export function createLitService(config: CliConfig): LitService {
  return new LitService({ environment: config.environment, accountKey: config.litAccountKey });
}
