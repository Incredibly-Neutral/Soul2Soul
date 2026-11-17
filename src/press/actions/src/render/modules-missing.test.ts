/**
 * render/main.ts — a publication whose modules cannot be resolved.
 *
 * Discovery answers null when the factory names the zero address or a
 * prediction with no code at it (ens.factory.test.ts covers those cases), and
 * throws when the factory does not answer `moduleAddress` at all, which is a
 * factory older than V6. Either way the render must refuse: ok:false, the
 * refusal sentence that names both possibilities, and nothing rendered — no
 * body fetch, no config. Here discovery is stubbed to answer null, so the
 * render-side refusal is what is under test.
 *
 * Its own fixture: the happy-path render tests keep their full module set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ethers from 'ethers5'; // the action runs against ethers v5 semantics

// ens.factory computes the two kinds at module load from the Lit-injected
// global, so the real ethers v5 has to be in place before that import runs.
(globalThis as { ethers?: unknown }).ethers = ethers;

vi.mock('../libs/evm', () => ({ evmRead: vi.fn(), evmWrite: vi.fn(), toHexString: vi.fn() }));
vi.mock('../libs/ipfs.factory', () => ({
  uploadFile: vi.fn(),
  catFile: vi.fn(),
  decodeArchiveCid: vi.fn(() => ''),
}));
vi.mock('../libs/decrypt', () => ({ decryptRaw: vi.fn() }));
vi.mock('../libs/protocol.factory', () => ({ getManifest: vi.fn() }));
vi.mock('../libs/ens.factory', () => ({ getDomainOwnerAndModules: vi.fn() }));
vi.mock('../libs/gates', () => ({ extractSignerAddress: vi.fn() }));
vi.mock('../libs/helpers', () => ({
  requireFields: vi.fn(),
  setRpcAuth: vi.fn(),
  fetchWithTimeout: vi.fn(),
}));
vi.mock('./config.ctrl', () => ({ getConfig: vi.fn() }));
vi.mock('./metadata', () => ({ addAndSignMetadata: vi.fn() }));
vi.mock('../renderer/html.ctrlr', () => ({ renderHTML: vi.fn() }));

import { main } from './main';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { getManifest } from '../libs/protocol.factory';
import { extractSignerAddress } from '../libs/gates';
import { getConfig } from './config.ctrl';
import { renderHTML } from '../renderer/html.ctrlr';
import type { SingleInput } from '@s2s/soul2soul-shared/lit-actions';

const MODULE = '0x' + '33'.repeat(20);
const OWNER = '0x' + '11'.repeat(20);

const input = (): SingleInput => ({
  job: {
    id: '0x' + '9a'.repeat(32),
    templateConfig: { reference: 'post', file: 'post.hbs', path: '/{slug}' },
    html: '',
    path: '/hello',
  },
  signature: '0x' + 'ab'.repeat(65),
  authorSafeAddress: '0x' + 'aa'.repeat(20),
  publication: 'test.soul2soul.eth',
  preview: true,
  endpoints: {
    ipfsGateway: 'https://ipfs.example',
    rpcs: { L1: ['https://rpc.l1'], L2: ['https://rpc.l2'] },
  },
});

const result = () => main(input()) as Promise<{ ok: boolean; error?: string; trace: unknown[] }>;

beforeEach(() => {
  vi.mocked(getManifest).mockResolvedValue({
    pkp: '0x' + '44'.repeat(20),
    ensRecords: '0x' + '55'.repeat(20),
    moduleFactory: '0x' + '77'.repeat(20),
  } as any);
  vi.mocked(extractSignerAddress).mockReturnValue('0x' + 'cc'.repeat(20));
});

describe('render — a module the factory cannot name', () => {
  it('refuses the publication when discovery answers a null publication module', async () => {
    vi.mocked(getDomainOwnerAndModules).mockResolvedValue({
      multisig: OWNER,
      configModule: MODULE,
      publicationModule: null,
    } as any);

    const out = await result();

    expect(out.ok).toBe(false);
    expect(out.error).toBe(
      'publication modules unresolved: the factory named no module with code at it, or did not answer moduleAddress at all, as a factory older than V6 cannot, so a publication from an earlier factory is refused',
    );
    // Nothing downstream was reached: no body, no config, no render.
    expect(getConfig).not.toHaveBeenCalled();
    expect(renderHTML).not.toHaveBeenCalled();
  });

  it('refuses the publication when discovery answers a null records module', async () => {
    vi.mocked(getDomainOwnerAndModules).mockResolvedValue({
      multisig: OWNER,
      configModule: null,
      publicationModule: MODULE,
    } as any);

    const out = await result();

    expect(out.ok).toBe(false);
    expect(out.error).toBe(
      'publication modules unresolved: the factory named no module with code at it, or did not answer moduleAddress at all, as a factory older than V6 cannot, so a publication from an earlier factory is refused',
    );
  });

  it('refuses with the same sentence when the factory does not answer, keeping the cause', async () => {
    vi.mocked(getDomainOwnerAndModules).mockRejectedValue(
      new Error('RPC call to https://rpc.l2 failed: missing revert data in call exception'),
    );

    const out = await result();

    expect(out.ok).toBe(false);
    // One sentence for the refusal, then the read failure as it came back: the
    // action fails loudly, and nothing pretends the read was an answer.
    expect(out.error).toContain(
      'publication modules unresolved: the factory named no module with code at it, or did not answer moduleAddress at all, as a factory older than V6 cannot, so a publication from an earlier factory is refused',
    );
    expect(out.error).toContain('missing revert data');
    expect(getConfig).not.toHaveBeenCalled();
    expect(renderHTML).not.toHaveBeenCalled();
  });

  it('refuses the publication when the ENS owner cannot be resolved either', async () => {
    vi.mocked(getDomainOwnerAndModules).mockResolvedValue({
      multisig: null,
      configModule: MODULE,
      publicationModule: MODULE,
    } as any);

    const out = await result();

    expect(out.ok).toBe(false);
    expect(out.error).toBe(
      'publication modules unresolved: the factory named no module with code at it, or did not answer moduleAddress at all, as a factory older than V6 cannot, so a publication from an earlier factory is refused',
    );
  });
});
