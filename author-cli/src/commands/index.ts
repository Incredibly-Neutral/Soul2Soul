// ============================================================================
// Command registry for `s2s author`.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { upload } from './upload';
import { preview } from './preview';
import { publish } from './publish';
import { revoke } from './revoke';
import { newPublication } from './new';

export const authorCommands: CommandSpec[] = [upload, preview, publish, revoke, newPublication];

export function findAuthorCommand(name: string): CommandSpec | undefined {
  return authorCommands.find((command) => command.name === name);
}
