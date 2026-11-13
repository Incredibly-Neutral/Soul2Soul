// ============================================================================
// s2s author info — the author's on-chain identity, and the pet name it runs
// under.
//
// The author id is the Safe (the manuscript owner neutralpress writes), not the
// EOA. Its address is counterfactual, so it exists before deployment: this
// prints it (plus the EOA that owns it) without sending anything. A `given`
// Safe has no salt and is not written back — the stored address is the fact
// this command reports — and the EOA line says whether that key is one of its
// owners, since a shared Safe can outlive any single key.
//
// `s2s author address` is the same report under its old name. The VS Code
// extension and the Neovim plugin call it and read `action: 'author.address'`,
// so both names stay and neither prints a deprecation note.
// ============================================================================

import type { CliContext } from '../core/context';
import type { CommandSpec } from '../lib/command';
import { authorSafeSalt, authorSafeState, type AuthorSafeState } from '../core/author-safe';
import { rememberAuthorSafe } from '../core/authors';

/** The two actions this module answers; the JSON reports which one ran. */
export type AuthorIdentityAction = 'author.info' | 'author.address';

/** The result both actions return: the address result plus the pet name. */
export interface AuthorIdentityResult extends AuthorSafeState {
  action: AuthorIdentityAction;
  /** The active author's pet name; null when the key did not come from the store. */
  author: string | null;
}

/** The one read and the one write; a test replaces them whole. */
export interface AuthorIdentityDeps {
  safeState(ctx: CliContext): Promise<AuthorSafeState>;
  remember(
    author: { readonly name: string | undefined; readonly source: string } | undefined,
    safe: string,
    warn: (message: string) => void,
  ): void;
}

export function authorIdentityDeps(overrides: Partial<AuthorIdentityDeps> = {}): AuthorIdentityDeps {
  return {
    safeState: overrides.safeState ?? authorSafeState,
    remember: overrides.remember ?? rememberAuthorSafe,
  };
}

/** The human block. `info` leads with the pet name; `address` predates it. */
export function authorIdentityLines(
  state: AuthorSafeState,
  author: string | null,
  action: AuthorIdentityAction,
): string {
  return [
    ...(action === 'author.info'
      ? [`${'author'.padEnd(11)} : ${author ?? '(none — key not in the author store)'}`]
      : []),
    `${'author safe'.padEnd(11)} : ${state.address}`,
    `${'eoa (owner)'.padEnd(11)} : ${state.eoa}${
      state.signerIsOwner === false ? '  — not an owner of this Safe (s2s signer queue)' : ''
    }`,
    `${'salt'.padEnd(11)} : ${state.salt ?? '(none, the Safe was given, not derived)'}`,
    `${'chain'.padEnd(11)} : ${state.chain}`,
    `${'deployed'.padEnd(11)} : ${
      state.deployed
        ? 'yes'
        : state.safeSource === 'given'
          ? 'no — this CLI never deploys a given Safe; its owners have to'
          : 'no — run: s2s author init'
    }`,
  ].join('\n');
}

/** Both specs run this: one report, with the action only naming the caller. */
export async function runAuthorIdentity(
  ctx: CliContext,
  action: AuthorIdentityAction,
  deps: AuthorIdentityDeps = authorIdentityDeps(),
): Promise<void> {
  const state = await deps.safeState(ctx);
  // Keep the store current: `author list` / `switch` report the Safe offline.
  // The write-back is a no-op for a given record (nothing derived may replace
  // the stored address), so the call stays unconditional here.
  deps.remember(ctx.config.author, state.address, (message) => {
    ctx.out.warn(message);
  });
  const author = ctx.config.author?.name ?? null;
  ctx.out.result(
    { action, ...state, author } satisfies AuthorIdentityResult,
    authorIdentityLines(state, author, action),
  );
}

export const authorInfo: CommandSpec = {
  name: 'info',
  summary: "Print the author identity: pet name, Safe address (author id), owner EOA.",
  flags: {},
  run: (ctx) => runAuthorIdentity(ctx, 'author.info'),
};

export const authorAddress: CommandSpec = {
  name: 'address',
  summary: 'Alias of info — the name the VS Code extension and Neovim plugin call.',
  flags: {},
  run: (ctx) => runAuthorIdentity(ctx, 'author.address'),
};

export { authorSafeSalt };
