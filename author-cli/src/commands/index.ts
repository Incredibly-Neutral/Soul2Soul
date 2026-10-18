// ============================================================================
// Command registries: `s2s author <action>` and `s2s publication <action>`.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { upload } from './upload';
import { propose } from './propose';
import { preview } from './preview';
import { publish } from './publish';
import { revoke } from './revoke';
import { newPublication } from './new';

/** `s2s author` — content actions on an existing publication. */
export const authorCommands: CommandSpec[] = [upload, propose, preview, publish, revoke];

/** `s2s publication` — publication lifecycle actions. */
export const publicationCommands: CommandSpec[] = [newPublication];

export function findAuthorCommand(name: string): CommandSpec | undefined {
  return authorCommands.find((command) => command.name === name);
}

export function findPublicationCommand(name: string): CommandSpec | undefined {
  return publicationCommands.find((command) => command.name === name);
}
