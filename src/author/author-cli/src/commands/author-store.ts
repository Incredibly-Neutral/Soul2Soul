// ============================================================================
// The author-store command table: new / switch / list / rm.
//
// Kept in its own module (not `index.ts`) because it is the dispatch table
// `cli.ts` consults *before* `buildContext` — importing `index.ts` would drag
// the content commands and the Filecoin adapter in, which is exactly what these
// actions must not need (and what vitest cannot load).
// ============================================================================

import type { StoreCommandSpec } from '../lib/command';
import { authorNew } from './author-new';
import { authorSwitch } from './author-switch';
import { authorList } from './author-list';
import { authorRm } from './author-rm';

/** `s2s author` — author identities; no context needed. */
export const authorStoreCommands: readonly StoreCommandSpec[] = [
  authorNew,
  authorSwitch,
  authorList,
  authorRm,
];

export function findAuthorStoreCommand(name: string): StoreCommandSpec | undefined {
  return authorStoreCommands.find((command) => command.name === name);
}
