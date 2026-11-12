// ============================================================================
// Command registries: `s2s author <action>`, `s2s publication <action>` and
// `s2s signer <action>`.
//
// `author` has two kinds of action. The author-store actions (new / switch /
// list / rm) run without a `CliContext` — `cli.ts` dispatches them before
// `buildContext`, so they work with no private key, no RPC and no bundler. The
// content actions (upload, publish, …) need the full context.
//
// `signer` is a group of its own, for a key that is one owner of a Safe it did
// not create. Every action is a store command (no context, no bundler): they
// file a key, swap it for another, read a queue, sign a hash and — at most —
// send one plain transaction from the EOA.
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
import { authorMigrate } from './migrate';
// The store table lives in its own module so `cli.ts` (and tests) can reach it
// without the content-command graph.
export { authorStoreCommands, findAuthorStoreCommand } from './author-store';
import { authorStoreCommands } from './author-store';
import { signerAdd } from './signer-add';
import { signerRotate } from './signer-rotate';
import { signerQueue } from './signer-queue';
import { signerConfirm } from './signer-confirm';

/** `s2s author` — content actions on an existing publication. */
export const authorCommands: CommandSpec[] = [
  upload,
  offer,
  preview,
  publish,
  revoke,
  authorAddress,
  authorInit,
  authorMigrate,
];

/** `s2s publication` — publication lifecycle actions. */
export const publicationCommands: CommandSpec[] = [newPublication];

/** `s2s signer` — keys filed as owners of a Safe that already exists. */
export const signerCommands: readonly StoreCommandSpec[] = [
  signerAdd,
  signerRotate,
  signerQueue,
  signerConfirm,
];

export function findSignerCommand(name: string): StoreCommandSpec | undefined {
  return signerCommands.find((command) => command.name === name);
}

/** Help order for `s2s signer --help`: the actions as a signer meets them. */
export const signerHelpEntries: readonly { name: string; summary: string; params?: string }[] =
  signerCommands;

/** Help order for `s2s author --help`: identity first, then content. */
export const authorHelpEntries: readonly { name: string; summary: string; params?: string }[] = [
  ...authorStoreCommands,
  ...authorCommands,
];

export function findAuthorCommand(name: string): CommandSpec | undefined {
  return authorCommands.find((command) => command.name === name);
}

export function findPublicationCommand(name: string): CommandSpec | undefined {
  return publicationCommands.find((command) => command.name === name);
}
