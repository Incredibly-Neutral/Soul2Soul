/**
 * Revoke-propagation end-to-end test (GAP-10 / RFC-prep-ripples-from-revoke).
 *
 * Drives the FULL orchestrator (renderwithLitActions, from the shared
 * rendering sequence) with the REAL render action (./main) for the revoked job
 * — so this test exercises the render-side revoked-branch decision, not a
 * canned mock.
 *
 * Regression that shipped (reviewer B1): before the fix, a revoked render
 * returned { ok:false } with no data.job, so the orchestrator retried 3x,
 * threw, filtered the job from `successful`, and never derived a remove entry
 * from the revoked job's path — the revoked page lingered in the MFS tree.
 * This test FAILS on the pre-fix commit (257459a) and PASSES after B1 (the
 * render action returns ok:true for a revoked job).
 *
 * Assertions (rendering a revoked postId through renderwithLitActions with NO
 * caller-supplied remove):
 *   (a) the update input's `remove` contains the revoked path,
 *   (b) a cascaded home job is rendered and lands in the update input's jobs,
 *   (c) the update input's jobs EXCLUDE the revoked job (activeJobs filter).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ethers from 'ethers5'; // protocol's v5 alias — render main needs ethers.utils (v5 semantics)

// The real render action (and its transitive deps) use `ethers.utils.*` at
// call time via the global `ethers`; install it before anything runs.
(global as any).ethers = ethers;

import { renderwithLitActions } from '../../../../shared/src/rendering/sequence';
import { runAction } from '../../../../shared/src/rendering/helpers';
import { main as renderMain } from './main';
import { evmRead } from '../libs/evm';
import { fetchById } from '../libs/module.factory';
import { getConfig } from './config.ctrl';
import { getProtocolInfo } from '../libs/protocol.factory';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { extractSignerAddress } from '../libs/gates';

vi.mock('../../../../shared/src/rendering/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/src/rendering/helpers')>();
  return { ...actual, runAction: vi.fn() };
});

// Mock the real render action's chain/template deps so the REAL render main
// runs its plaintext + hasDeal path without network access.
vi.mock('../libs/evm', () => ({
  evmRead: vi.fn(),
  evmWrite: vi.fn(),
  toHexString: vi.fn(),
}));
vi.mock('../libs/module.factory', () => ({
  fetchById: vi.fn(),
}));
vi.mock('./config.ctrl', () => ({
  getConfig: vi.fn(),
}));
vi.mock('../libs/protocol.factory', () => ({
  getProtocolInfo: vi.fn(),
}));
vi.mock('../libs/ens.factory', () => ({
  getDomainOwnerAndModules: vi.fn(),
}));
vi.mock('../libs/gates', () => ({
  extractSignerAddress: vi.fn(),
}));

const REVOKED_ID = '0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063';
const HOME_ID = '0x1111111111111111111111111111111111111111111111111111111111111111';
const REVOKED_PATH = '/revoked-post-slug';
const HOME_PATH = '/';
const HOME_HTML_CID = 'QmHomeHtmlCid';
const PREP_CID = 'cid-prep';
const RENDER_CID = 'cid-render';
const UPDATE_CID = 'cid-update';
const SIGNATURE = '0x' + 'ab'.repeat(65); // 65-byte sig placeholder (extractSignerAddress is mocked)

const templateConfigPost = { reference: 'post', file: 'post.hbs', path: '/{slug}' };
const templateConfigHome = { reference: 'home', file: 'home.hbs', path: '/' };

const revokedBody = {
  id: REVOKED_ID,
  author: '0xAuthor',
  locale: 'en',
  parent: '',
  position: '',
  postType: 'post',
  creationDate: '2026-08-19',
  modifiedDate: '2026-08-19',
  tags: [],
  publication: 'test.soul2soul.eth',
  encryption: false,
  title: 'Revoked post',
  slug: 'revoked-post-slug',
  content: 'plain',
  custom: {},
};

const protocolInfo = {
  gateway: 'https://ipfs.example',
  pkp: '0xpkp',
  ensRecords: '0xens',
  litActions: { prep: PREP_CID, render: RENDER_CID, update: UPDATE_CID },
};

const rpcs = { L1: ['https://rpc.l1'], L2: ['https://rpc.l2'] };

const mockLit = {} as any;

describe('renderwithLitActions — revoke propagation (end-to, real render action)', () => {
  beforeEach(() => {
    vi.mocked(runAction).mockReset();
    vi.mocked(evmRead).mockReset();
    vi.mocked(fetchById).mockReset();
    vi.mocked(getConfig).mockReset();
    vi.mocked(getProtocolInfo).mockReset();
    vi.mocked(getDomainOwnerAndModules).mockReset();
    vi.mocked(extractSignerAddress).mockReset();
  });

  it('rendering a revoked postId yields a remove entry, a cascaded home job, and excludes the revoked job from the update', async () => {
    // ---- real render action deps (revoked path) ----
    vi.mocked(extractSignerAddress).mockReturnValue('0xSigner');
    vi.mocked(getProtocolInfo).mockResolvedValue(protocolInfo as any);
    vi.mocked(getDomainOwnerAndModules).mockResolvedValue({
      multisig: '0xms',
      configModule: '0xcfg',
      publicationModule: '0xpub',
    } as any);
    vi.mocked(fetchById).mockResolvedValue(revokedBody as any);
    vi.mocked(getConfig).mockResolvedValue({ localePaths: {} } as any);
    vi.mocked(evmRead).mockResolvedValue(false); // hasDeal=false → genuine revoke

    const revokedJob = {
      id: REVOKED_ID,
      templateConfig: templateConfigPost,
      templateData: undefined,
      html: '',
    };
    const homeJob = {
      id: HOME_ID,
      templateConfig: templateConfigHome,
      templateData: undefined,
      html: '',
    };

    let updateInputs: any = null;

    vi.mocked(runAction).mockImplementation(async (_preview, _lit, cid, inputs) => {
      if (cid === PREP_CID) {
        return { ok: true, action: 'prep', data: { jobs: [revokedJob, homeJob] }, trace: [] };
      }
      if (cid === RENDER_CID) {
        const job = (inputs as any).job;
        if (job.id === REVOKED_ID) {
          // Run the REAL render action → hasDeal=false → revoked branch.
          return renderMain(inputs as any);
        }
        // home (ripple destination) → active render
        return {
          ok: true,
          action: 'render',
          data: {
            job: { ...job, path: HOME_PATH, html: HOME_HTML_CID, revoked: false },
            html: HOME_HTML_CID,
            timestamp: '2026-08-19T00:00:00.000Z',
          },
          trace: [],
        };
      }
      if (cid === UPDATE_CID) {
        updateInputs = inputs;
        return { ok: true, action: 'evm-update', data: { cid: 'QmRootCid' }, trace: [] };
      }
      throw new Error(`unexpected cid: ${cid}`);
    });

    const result = await renderwithLitActions(
      true, // preview
      mockLit,
      SIGNATURE,
      'lit-usage-key',
      protocolInfo as any,
      null, // notice
      '0xAuthorSafe',
      'test.soul2soul.eth',
      [REVOKED_ID],
      'QmConfig',
      rpcs,
      'https://ipfs.example',
      // NO caller-supplied remove — the whole point of the auto-derivation
    );

    expect(updateInputs).not.toBeNull();

    // (a) remove entry containing the revoked path (auto-derived, no caller remove)
    expect(updateInputs.remove).toEqual([{ path: REVOKED_PATH }]);

    // (c) update jobs EXCLUDE the revoked job
    const updateJobIds = updateInputs.jobs.map((j: any) => j.id);
    expect(updateJobIds).not.toContain(REVOKED_ID);

    // (b) the cascaded home job IS rendered and lands in the update jobs
    expect(updateJobIds).toContain(HOME_ID);

    // the orchestrator reports success
    expect(result.success).toBe(true);
    expect(result.cid).toBe('QmRootCid');
  });
});
