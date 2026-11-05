import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The command's job here is formatting the upload result, not the write path.
vi.mock('../src/core/author', () => ({ authorWrite: vi.fn() }));

import { authorWrite } from '../src/core/author';
import { upload } from '../src/commands/upload';
import { createOut } from '../src/lib/out';
import { IPFS_GATEWAY_BASE, ipfsGatewayUrl, ipfsUri } from '../src/lib/ipfs-link';
import type { CliContext } from '../src/core/context';
import type { ParsedArgs } from '../src/lib/args';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

const RESULT = {
  objectId: '0x' + 'ab'.repeat(32),
  kuboCid: CID,
  publication: 'test.soul2soul.eth',
  subdomain: 'test',
  txHash: undefined,
  render: undefined,
  frontmatterWritten: true,
};

describe('ipfs links', () => {
  it('builds the uri and gateway shapes from one base', () => {
    expect(ipfsUri(CID)).toBe(`ipfs://${CID}`);
    expect(ipfsGatewayUrl(CID)).toBe(`https://ipfs.io/ipfs/${CID}`);
    expect(ipfsGatewayUrl(CID).startsWith(`${IPFS_GATEWAY_BASE}/`)).toBe(true);
  });
});

describe('s2s author upload result', () => {
  const dirs: string[] = [];
  let stdout: string[];

  beforeEach(() => {
    vi.mocked(authorWrite).mockResolvedValue(RESULT);
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function note(): string {
    const dir = mkdtempSync(join(tmpdir(), 's2s-upload-'));
    dirs.push(dir);
    const path = join(dir, 'note.md');
    writeFileSync(path, '---\ntitle: Hello\n---\n\nbody\n');
    return path;
  }

  function argsFor(path: string): ParsedArgs {
    return { positionals: [path], flags: { publication: 'test.soul2soul.eth' } };
  }

  it('adds ipfsUrl and gatewayUrl without renaming existing keys (--json)', async () => {
    const path = note();
    await upload.run({ out: createOut(true) } as CliContext, argsFor(path));

    const payload = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(payload).toMatchObject({
      action: 'upload',
      note: path,
      publication: 'test.soul2soul.eth',
      subdomain: 'test',
      objectId: RESULT.objectId,
      cid: CID,
      frontmatterWritten: true,
    });
    expect(payload.ipfsUrl).toBe(`ipfs://${CID}`);
    expect(payload.gatewayUrl).toBe(`https://ipfs.io/ipfs/${CID}`);
    // The documented contract is open-shape: the pre-existing keys must still be
    // here, and new scalars may be added freely (that is exactly what this
    // change did), so this is a subset check, not an equality check.
    for (const key of [
      'action',
      'note',
      'publication',
      'subdomain',
      'objectId',
      'cid',
      'frontmatterWritten',
    ]) {
      expect(Object.keys(payload), `missing pre-existing key ${key}`).toContain(key);
    }
  });

  it('prints the gateway link under the cid line in human mode', async () => {
    const path = note();
    await upload.run({ out: createOut(false) } as CliContext, argsFor(path));

    const text = stdout.join('');
    expect(text).toContain(`  cid         : ${CID}`);
    expect(text).toContain(`  link        : https://ipfs.io/ipfs/${CID}`);
    // the link line follows the cid line, as specified
    const lines = text.split('\n');
    const cidAt = lines.findIndex((l) => l.includes(`  cid         : ${CID}`));
    expect(lines[cidAt + 1]).toBe(`  link        : https://ipfs.io/ipfs/${CID}`);
  });
});
