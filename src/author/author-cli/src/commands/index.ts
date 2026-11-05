// ============================================================================
// Command registries: `s2s author <action>` and `s2s publication <action>`.
//
// `author` has two kinds of action. The author-store actions (new / switch /
// list / rm) run without a `CliContext` — `cli.ts` dispatches them before
// `buildContext`, so they work with no private key, no RPC and no bundler. The
// content actions (upload, publish, …) need the full context.
// ============================================================================

import type { CommandSpec, StoreCommandSpec } from '../lib/command';
import { upload } from './upload';
import { offer } from './offer';
import { preview } from './preview';
import { publish } from './publish';
import { revoke } from './revoke';
import { newPublication } from './new';
import { authorAddress } from './address';
import { authorInit } from './init';
import { authorNew } from './author-new';
import { authorSwitch } from './author-switch';
import { authorList } from './author-list';
import { authorRm } from './author-rm';

/** `s2s author` — author identities; no context needed. */
export const authorStoreCommands: StoreCommandSpec[] = [
  authorNew,
  authorSwitch,
  authorList,
  authorRm,
];

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

export function findAuthorStoreCommand(name: string): StoreCommandSpec | undefined {
  return authorStoreCommands.find((command) => command.name === name);
}

export function findPublicationCommand(name: string): CommandSpec | undefined {
  return publicationCommands.find((command) => command.name === name);
}
