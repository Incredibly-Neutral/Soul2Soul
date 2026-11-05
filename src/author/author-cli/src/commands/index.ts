// ============================================================================
// Command registries: `s2s author <action>` and `s2s publication <action>`.
//
// `author` has two kinds of action. The author-store actions (new / switch /
// list / rm) run without a `CliContext` — `cli.ts` dispatches them before
// `buildContext`, so they work with no private key, no RPC and no bundler. The
// content actions (upload, publish, …) need the full context.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { upload } from './upload';
import { offer } from './offer';
import { preview } from './preview';
import { publish } from './publish';
import { revoke } from './revoke';
import { newPublication } from './new';
import { authorAddress } from './address';
import { authorInit } from './init';
// The store table lives in its own module so `cli.ts` (and tests) can reach it
// without the content-command graph.
export { authorStoreCommands, findAuthorStoreCommand } from './author-store';
import { authorStoreCommands } from './author-store';

/** `s2s author` — content actions on an existing publication. */
export const authorCommands: CommandSpec[] = [
  upload,
  offer,
  preview,
  publish,
  revoke,
  authorAddress,
  authorInit,
];

/** `s2s publication` — publication lifecycle actions. */
export const publicationCommands: CommandSpec[] = [newPublication];

/** Help order for `s2s author --help`: identity first, then content. */
export const authorHelpEntries: readonly { name: string; summary: string }[] = [
  ...authorStoreCommands,
  ...authorCommands,
];

export function findAuthorCommand(name: string): CommandSpec | undefined {
  return authorCommands.find((command) => command.name === name);
}

export function findPublicationCommand(name: string): CommandSpec | undefined {
  return publicationCommands.find((command) => command.name === name);
}
