import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These tests are about the command → core wiring, not the write path.
vi.mock('../src/core/author', () => ({ authorWrite: vi.fn(), offerContent: vi.fn() }));

import { authorWrite, offerContent } from '../src/core/author';
import { preview } from '../src/commands/preview';
import { offer } from '../src/commands/offer';
import { publish } from '../src/commands/publish';
import { upload } from '../src/commands/upload';
import { parseCommandArgs, type FlagSpecs } from '../src/lib/args';
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
  draft: undefined,
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
    // offerContent only reports the on-chain fields
    vi.mocked(offerContent).mockResolvedValue({
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

  /** Parse argv against the command's own flag spec, exactly as cli.ts does. */
  function argsFor(
    path: string,
    extra: string[] = [],
    command: { flags: FlagSpecs } = publish,
  ): ParsedArgs {
    return parseCommandArgs(['--publication', 'test.soul2soul.eth', ...extra, path], command.flags);
  }

  function uploadOpts(): { allowPlaintext?: boolean } {
    const call = vi.mocked(authorWrite).mock.calls[0];
    if (!call) throw new Error('authorWrite was not called');
    return call[3];
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

  it('offer uploads first and passes allowPlaintext through (no --cid)', async () => {
    // `offer` uploads AND offers, so the core returns a tx hash here.
    vi.mocked(authorWrite).mockResolvedValue({ ...RESULT, txHash: '0x' + '44'.repeat(32) });
    const withFlag = note();
    await offer.run(ctx, argsFor(withFlag, ['--allow-plaintext']));
    const call = vi.mocked(authorWrite).mock.calls[0];
    expect(call?.[1]).toBe(withFlag);
    // render stays off; the upload (and its pins) stays on
    expect(call?.[3]).toMatchObject({ render: false, publish: true, offer: true });
    expect(call?.[3].allowPlaintext).toBe(true);
    expect(vi.mocked(offerContent)).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(authorWrite).mockResolvedValue({ ...RESULT, txHash: '0x' + '44'.repeat(32) });
    await offer.run(ctx, argsFor(note()));
    expect(vi.mocked(authorWrite).mock.calls[0]?.[3].allowPlaintext).toBe(false);
  });

  it('offer --cid anchors the given CID without re-uploading', async () => {
    const path = note();
    await offer.run(
      ctx,
      argsFor(path, ['--cid', 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'], offer),
    );
    expect(vi.mocked(authorWrite)).not.toHaveBeenCalled();
    expect(vi.mocked(offerContent).mock.calls[0]?.[1]).toBe(path);
    expect(vi.mocked(offerContent).mock.calls[0]?.[3]).toBe(
      'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    );
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
    const { flags, positionals } = parseCommandArgs(['--allow-plaintext', 'n.md'], publish.flags);
    expect(flags['allow-plaintext']).toBe(true);
    expect(positionals).toEqual(['n.md']);
  });

  it('rejects a flag the command does not declare', () => {
    expect(() => argsFor(note(), ['--allow-plaintex'])).toThrow(/unknown flag/);
  });
});
