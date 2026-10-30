import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These tests are about the command → core wiring, not the write path.
vi.mock('../src/core/author', () => ({ authorWrite: vi.fn(), proposeContent: vi.fn() }));

import { authorWrite, proposeContent } from '../src/core/author';
import { preview } from '../src/commands/preview';
import { propose } from '../src/commands/propose';
import { publish } from '../src/commands/publish';
import { upload } from '../src/commands/upload';
import { BOOLEAN_FLAGS, parseArgs } from '../src/lib/args';
import type { ParsedArgs } from '../src/lib/args';
import type { CliContext } from '../src/core/context';

const RESULT = {
  objectId: '0x' + 'ab'.repeat(32),
  kuboCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  publication: 'test.soul2soul.eth',
  subdomain: 'test',
  txHash: undefined,
  render: undefined,
  frontmatterWritten: true,
};

/**
 * `--allow-plaintext` is the escape hatch around the encryption downgrade
 * guard, so both directions of the wiring matter: hardcoding `false` makes the
 * documented remedy a no-op, and hardcoding `true` silently disables the guard
 * for everyone. The core function is faked, so only the command's own decision
 * is under test here.
 */
describe('--allow-plaintext command wiring', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.mocked(authorWrite).mockResolvedValue(RESULT);
    // proposeContent only reports the on-chain fields
    vi.mocked(proposeContent).mockResolvedValue({
      objectId: RESULT.objectId,
      kuboCid: RESULT.kuboCid,
      publication: RESULT.publication,
      subdomain: RESULT.subdomain,
      txHash: '0x' + '44'.repeat(32),
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function note(): string {
    const dir = mkdtempSync(join(tmpdir(), 's2s-flags-'));
    dirs.push(dir);
    const path = join(dir, 'note.md');
    writeFileSync(path, '---\ntitle: Hello\n---\n\nbody\n');
    return path;
  }

  const ctx = { out: { log: vi.fn(), warn: vi.fn(), result: vi.fn() } } as unknown as CliContext;

  /** Parse argv exactly as cli.ts does, so a missing boolean flag shows up here. */
  function argsFor(path: string, extra: string[] = []): ParsedArgs {
    return parseArgs(['--publication', 'test.soul2soul.eth', ...extra, path], {
      booleanFlags: BOOLEAN_FLAGS,
    });
  }

  function uploadOpts(): { allowPlaintext?: boolean } {
    const call = vi.mocked(authorWrite).mock.calls[0];
    if (!call) throw new Error('authorWrite was not called');
    return call[3];
  }

  function proposeOpts(): { allowPlaintext?: boolean } {
    const call = vi.mocked(proposeContent).mock.calls[0];
    if (!call) throw new Error('proposeContent was not called');
    return call[4] ?? {};
  }

  it('upload passes allowPlaintext: true only with the flag (and keeps the note path)', async () => {
    const withFlag = note();
    await upload.run(ctx, argsFor(withFlag, ['--allow-plaintext']));
    expect(uploadOpts().allowPlaintext).toBe(true);
    // a boolean flag must not swallow the positional
    expect(vi.mocked(authorWrite).mock.calls[0]?.[1]).toBe(withFlag);

    vi.clearAllMocks();
    const without = note();
    await upload.run(ctx, argsFor(without));
    expect(uploadOpts().allowPlaintext).toBe(false);
  });

  it('propose passes allowPlaintext: true only with the flag (and keeps the note path)', async () => {
    const withFlag = note();
    await propose.run(ctx, argsFor(withFlag, ['--allow-plaintext']));
    expect(proposeOpts().allowPlaintext).toBe(true);
    expect(vi.mocked(proposeContent).mock.calls[0]?.[1]).toBe(withFlag);

    vi.clearAllMocks();
    const without = note();
    await propose.run(ctx, argsFor(without));
    expect(proposeOpts().allowPlaintext).toBe(false);
  });

  it('preview and publish use the same flag-derived value', async () => {
    await preview.run(ctx, argsFor(note(), ['--allow-plaintext']));
    expect(uploadOpts().allowPlaintext).toBe(true);

    vi.clearAllMocks();
    await publish.run(ctx, argsFor(note()));
    expect(uploadOpts().allowPlaintext).toBe(false);

    vi.clearAllMocks();
    await publish.run(ctx, argsFor(note(), ['--allow-plaintext']));
    expect(uploadOpts().allowPlaintext).toBe(true);
  });

  it('treats --allow-plaintext as boolean in the CLI parser', () => {
    const { flags, positionals } = parseArgs(['author', 'publish', '--allow-plaintext', 'n.md'], {
      booleanFlags: BOOLEAN_FLAGS,
    });
    expect(flags['allow-plaintext']).toBe(true);
    expect(positionals).toEqual(['author', 'publish', 'n.md']);
  });
});
