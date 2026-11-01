/**
 * Pure argv construction. The only module that knows the binary's flag surface.
 *
 * Shapes mirror SPEC-author-cli §Binary API reference. `--json` is appended last on every
 * invocation — see the hard rule in SPEC-author-vscode. Nothing here validates a flag value
 * the binary owns; only the invariants the wrapper itself depends on (absolute note path).
 *
 * No `vscode` import.
 */

export type AuthorAction = 'upload' | 'offer' | 'preview' | 'publish' | 'revoke';

export type ConfigVerb = 'set' | 'get' | 'unset' | 'list' | 'path';

export interface AuthorFlags {
  publication?: string;
  /** `offer` only — overrides the `kubo_cid` the last upload wrote. */
  cid?: string;
  allowPlaintext?: boolean;
}

export interface PublicationNewOptions {
  repo: string;
  branch?: string;
  authors?: string[];
  owners?: string[];
}

export class UsageError extends Error {}

const ACTIONS: readonly AuthorAction[] = ['upload', 'offer', 'preview', 'publish', 'revoke'];

// `revoke` takes neither a CID nor the plaintext guard (SPEC-author-cli §Command surface).
const CID_ACTIONS: readonly AuthorAction[] = ['offer'];
const PLAINTEXT_ACTIONS: readonly AuthorAction[] = ['upload', 'offer', 'preview', 'publish'];

export function isAuthorAction(value: string): value is AuthorAction {
  return (ACTIONS as readonly string[]).includes(value);
}

/**
 * The binary needs a path it can `open(2)` from the cwd it is spawned in, so it must be
 * absolute. Relative paths are a caller bug, not something to silently resolve.
 */
export function requireAbsoluteNote(notePath: string): string {
  if (notePath.length === 0) throw new UsageError('no note path — the document has no file');
  if (!notePath.startsWith('/')) {
    throw new UsageError(`note path must be absolute (got "${notePath}")`);
  }
  return notePath;
}

function pushFlag(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) args.push(flag, value);
}

/** `s2s author <action> <note> [flags] --json` */
export function authorArgs(
  action: AuthorAction,
  notePath: string,
  flags: AuthorFlags = {},
): string[] {
  const args = ['author', action, requireAbsoluteNote(notePath)];

  pushFlag(args, '--publication', flags.publication);

  if (flags.cid !== undefined) {
    if (!CID_ACTIONS.includes(action)) {
      throw new UsageError(`--cid is not valid for "${action}" (only ${CID_ACTIONS.join(', ')})`);
    }
    pushFlag(args, '--cid', flags.cid);
  }

  if (flags.allowPlaintext === true) {
    if (!PLAINTEXT_ACTIONS.includes(action)) {
      throw new UsageError(`--allow-plaintext is not valid for "${action}"`);
    }
    args.push('--allow-plaintext');
  }

  args.push('--json');
  return args;
}

/** `s2s publication new <name> --repo <owner/repo> [flags] --json` */
export function publicationNewArgs(name: string, options: PublicationNewOptions): string[] {
  if (name.length === 0) throw new UsageError('publication name is required');
  if (options.repo.length === 0) throw new UsageError('--repo <owner/repo> is required');

  const args = ['publication', 'new', name, '--repo', options.repo];

  pushFlag(args, '--branch', options.branch);
  if (options.authors !== undefined && options.authors.length > 0) {
    args.push('--author', options.authors.join(','));
  }
  if (options.owners !== undefined && options.owners.length > 0) {
    args.push('--owner', options.owners.join(','));
  }

  args.push('--json');
  return args;
}

/** `s2s config <verb> [args] [--local] --json` — values pass through unvalidated. */
export function configArgs(
  verb: ConfigVerb,
  rest: readonly string[] = [],
  options: { local?: boolean } = {},
): string[] {
  const args = ['config', verb, ...rest];
  if (options.local === true) args.push('--local');
  args.push('--json');
  return args;
}

/** `s2s author address|init --json` — no positional. */
export function authorIdentityArgs(which: 'address' | 'init'): string[] {
  return ['author', which, '--json'];
}

/** `s2s <group> --help --json` — used by doctor for the version/help document. */
export function versionArgs(): string[] {
  return ['--version', '--json'];
}
