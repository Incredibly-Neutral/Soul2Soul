import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Wallet, TypedDataEncoder, keccak256, recoverAddress, toUtf8Bytes } from 'ethers';

vi.mock('./evm', () => ({ evmRead: vi.fn() }));
vi.mock('./ipfs.factory', () => ({ catFile: vi.fn() }));

import { evmRead } from './evm';
import { catFile } from './ipfs.factory';
import {
  ContentIntegrityError,
  checkItemIntegrity,
  fetchById,
  resetIntegrityWarningLatch,
  type Entry,
} from './module.factory';
import {
  ARCHIVE_FORMAT,
  parseArchive,
  reconcile,
  serialize,
  type Archive,
} from './archive.factory';
import { SKIP_REASON_RE, inspectItemIntegrity } from './item-integrity';
import type { S2SContentItem } from '@s2s/soul2soul-shared/lit-actions';
import { jcs } from '@s2s/soul2soul-shared/lit-actions';
import { buildSigningView } from '../../../../shared/dist/manuscript/identity/signing-view';
import { S2S_DOMAIN, S2S_TYPES } from '../../../../shared/dist/manuscript/types';

// ============================================================================
// PARITY — one item, two readers.
//
// The same stored bytes reach a reader through two different doors:
//
//   DIRECT  `fetchById()`  → getLatestEntry + cat(deal cid)  → checkItemIntegrity
//   ARCHIVE `reconcile()`  → archive item keyed by publication → inspectItemIntegrity
//
// Both must answer "may this be served?" the same way for the SAME item, or the
// cheaper door is weaker than the authoritative one and an attacker picks the
// door. Each test below runs one item through both readers and asserts they
// agree — on serving, and on the refusal code when they refuse. Where they are
// allowed to differ (failure SHAPE: throw/skip vs MISS+refetch) it is asserted
// explicitly and named.
//
// Fixtures are minted exactly like the real mint (JCS body → keccak256 →
// EIP-712 digest → real signature) so "verified" means the production mint
// verifies, and every tamper lever is applied AFTER signing.
// ============================================================================

beforeAll(() => {
  vi.stubGlobal('ethers', {
    utils: {
      _TypedDataEncoder: { hash: TypedDataEncoder.hash },
      recoverAddress,
      keccak256,
      toUtf8Bytes,
    },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const AUTHOR = new Wallet('0x' + '11'.repeat(32));
const ATTACKER = new Wallet('0x' + '22'.repeat(32));

const GENESIS = '0x' + 'aa'.repeat(32);
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const PUBLICATION = '0xPubModule';
const GATEWAY = 'https://ipfs.example';

const mkEntry = (author: string = AUTHOR.address): Entry => ({
  genesis: GENESIS,
  author, // getDeals()/getLatest() return a plain address
  cid: CID,
  timestamp: 1234,
});

const bodyOf = { title: 't', slug: 's', content: 'c' };
const bodyJson = jcs(bodyOf);
const hashOf = (s: string) => keccak256(toUtf8Bytes(s));

interface ItemOpts {
  signer?: Wallet;
  author?: string;
  body?: string;
  encryption?: boolean;
  legacy?: boolean;
  plaintextHash?: string | null;
  objectId?: string;
  noProof?: boolean;
}

/** Mint a genuine content item, then apply (optional) post-signature tampering. */
const mkItem = (opts: ItemOpts = {}): S2SContentItem => {
  const signer = opts.signer ?? AUTHOR;
  const pub: Record<string, unknown> = {
    specVersion: '1',
    author: opts.author ?? signer.address,
    postType: 'post',
    mediaType: 'text/markdown',
    parent: '',
    position: '0',
    publication: 'pub',
    locale: 'en',
    createdAt: 1234,
    base: '',
    tags: [],
    attributes: {},
    plaintextHash: hashOf(bodyJson),
  };
  const digest = TypedDataEncoder.hash(
    S2S_DOMAIN as any,
    S2S_TYPES as any,
    buildSigningView(pub as any),
  );
  const item: Record<string, any> = {
    public: pub,
    objectId: digest,
    proof: {
      type: 'eip712',
      signer: signer.address,
      signature: signer.signingKey.sign(digest).serialized,
    },
    encryption: opts.encryption ?? false,
    body: opts.encryption ? 'ciphertext-blob' : bodyJson,
  };
  if (opts.plaintextHash === null) delete item.public.plaintextHash;
  else if (opts.plaintextHash !== undefined) item.public.plaintextHash = opts.plaintextHash;
  if (opts.legacy) {
    delete item.public.specVersion;
    delete item.public.plaintextHash;
  }
  if (opts.objectId !== undefined) item.objectId = opts.objectId;
  if (opts.noProof) delete item.proof;
  if (opts.body !== undefined) item.body = opts.body;
  return item as unknown as S2SContentItem;
};

const mkArchive = (item: unknown): Archive => ({
  format: ARCHIVE_FORMAT,
  publication: 'pub',
  built: '2026-01-01T00:00:00.000Z',
  items: { [GENESIS]: { cid: CID, item } as any },
});

/** Answer both chain reads the two paths make (getLatest for one, getDeals for all). */
const mockChain = (entry: Entry): void => {
  vi.mocked(evmRead).mockImplementation((async (
    _chain: unknown,
    _module: unknown,
    _abi: unknown,
    method: string,
  ) => {
    if (method === 'getDeals') return [entry];
    if (method === 'getLatest') return entry;
    throw new Error(`unexpected chain read: ${method}`);
  }) as never);
};

/**
 * DIRECT reader: exactly what render/main.ts calls for a page body.
 *
 * A refusal is classified through the SAME greppable skip-reason format the
 * collection paths emit (`integrity(<code>): …` / `unavailable: …`), so this
 * file also pins review item #3: every refusal on both doors is machine-
 * readable, and a shape defect never gets filed as a proven forgery.
 */
const readDirect = async (
  item: unknown,
  entry: Entry = mkEntry(),
): Promise<{ served: boolean; code: string | null; cause: 'integrity' | 'unavailable' | null }> => {
  mockChain(entry);
  vi.mocked(catFile).mockResolvedValue(JSON.stringify(item));
  try {
    const body = await fetchById(GENESIS, PUBLICATION, [], GATEWAY);
    return { served: body != null, code: body == null ? null : 'served', cause: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const m = SKIP_REASON_RE.exec(message);
    expect(m, `refusal not tagged with a skip code: ${message}`).not.toBeNull();
    const cause = m![1] === 'unavailable' ? 'unavailable' : 'integrity';
    const code = m![2] ?? (/malformed content item/.test(message) ? 'malformed-item' : null);
    // An integrity refusal MUST go through the typed error: the render caller
    // distinguishes it from a transport failure to decide fail-the-job vs skip.
    if (cause === 'integrity') expect(e).toBeInstanceOf(ContentIntegrityError);
    return { served: false, code, cause };
  }
};

/** ARCHIVE reader: exactly what data.ctrlr's collection path calls. */
const readArchive = (
  item: unknown,
  entry: Entry = mkEntry(),
): { served: boolean; code: string | null; needsFetch: number } => {
  const { fresh, needsFetch, integrityIssues } = reconcile([entry], mkArchive(item));
  return {
    served: fresh.has(GENESIS),
    code: integrityIssues[0]?.code ?? null,
    needsFetch: needsFetch.length,
  };
};

/** Both doors, for one item. */
const both = async (item: unknown, entry: Entry = mkEntry()) => ({
  direct: await readDirect(item, entry),
  archive: readArchive(item, entry),
});

beforeEach(() => {
  vi.clearAllMocks();
  resetIntegrityWarningLatch();
});

describe('parity: the two read paths agree about the same item', () => {
  it('(a) honest minted item — served by both, and verified', async () => {
    const item = mkItem();
    const { direct, archive } = await both(item);

    expect(direct.served).toBe(true);
    expect(archive.served).toBe(true);
    expect(archive.needsFetch).toBe(0);
    expect(archive.code).toBeNull();
    expect(inspectItemIntegrity(item, AUTHOR.address).level).toBe('verified');
  });

  it('(b) author-mismatched item — REFUSED by both, same code', async () => {
    // A fully self-consistent item from another author (their own key, their own
    // hash, their own proof) sitting at this publication's deal.
    const item = mkItem({ signer: ATTACKER });
    const { direct, archive } = await both(item);

    // The direct path's own author binding catches it (deal author ≠ public.author).
    expect(direct.served).toBe(false);
    expect(direct.code).toBe('author-mismatch');
    expect(archive.served).toBe(false);
    expect(archive.code).toBe('author-mismatch');
    // ... and it is a MISS, not a served item: the archive path refetches.
    expect(archive.needsFetch).toBe(1);
  });

  it('(c) stripped plaintextHash on a specVersion item — REFUSED by both', async () => {
    const item = mkItem({ plaintextHash: null });
    const { direct, archive } = await both(item);

    expect(direct.served).toBe(false);
    expect(direct.code).toBe('hash-missing');
    expect(archive.served).toBe(false);
    expect(archive.code).toBe('hash-missing');
  });

  it('(d) legacy item (no specVersion, no hash) — SERVED by both, unverifiable', async () => {
    const item = mkItem({ legacy: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { direct, archive } = await both(item);

    expect(direct.served).toBe(true);
    expect(archive.served).toBe(true);
    expect(archive.needsFetch).toBe(0);
    expect(archive.code).toBeNull(); // served, not refused
    // Both doors see the same (weaker) verdict, and the direct path says so.
    expect(inspectItemIntegrity(item, AUTHOR.address).code).toBe('legacy-item');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/legacy-item/);
    warn.mockRestore();
  });

  it('forged body reusing the honest hash — REFUSED by both', async () => {
    const item = mkItem({ body: jcs({ title: 't', slug: 's', content: 'PWNED' }) });
    const { direct, archive } = await both(item);

    expect(direct.code).toBe('hash-mismatch');
    expect(archive.code).toBe('hash-mismatch');
  });

  it('rewritten objectId — REFUSED by both', async () => {
    const item = mkItem({ objectId: '0x' + '99'.repeat(32) });
    const { direct, archive } = await both(item);

    expect(direct.served).toBe(false);
    expect(direct.code).toBe('objectid-mismatch');
    expect(archive.code).toBe('objectid-mismatch');
  });

  it('stripped proof on a specVersion item — REFUSED by both (no silent third-party pass)', async () => {
    const item = mkItem({ noProof: true });
    const { direct, archive } = await both(item);

    // Both refuse — and now for the SAME stated reason: `proof` is required by
    // the shared content-item schema, so BOTH doors stop at the shape gate
    // ('malformed-item', cause 'unavailable') before any integrity verdict runs.
    // The CODE is only available on the direct path, which is a named,
    // deliberate difference: an archive can never STORE a schema-invalid item
    // (parseArchive/mergeArchive shape-gate drops it), so on the archive path
    // this item is simply "no entry" — a MISS with nothing to classify.
    expect(direct.served).toBe(false);
    expect(direct.code).toBe('malformed-item');
    expect(direct.cause).toBe('unavailable');
    expect(archive.served).toBe(false);
    expect(archive.code).toBeNull();
    expect(parseArchive(serialize(mkArchive(item))).items).toEqual({});
  });

  it('RESIDUAL, both doors: a stolen deal author + attacker signature is SERVED unverified', async () => {
    // Documented residual (see item-integrity.ts): the recovered signer is not
    // required to equal public.author, because a Safe/contract-authored item is
    // signed by an owner EOA. Closing it needs an isOwner read. Both paths
    // behave identically — which is the point of this file.
    const item = mkItem({ signer: ATTACKER, author: AUTHOR.address });
    const { direct, archive } = await both(item);

    expect(direct.served).toBe(true);
    expect(archive.served).toBe(true);
    expect(inspectItemIntegrity(item, AUTHOR.address).code).toBe('signature-not-author');
  });

  it('encrypted item — SERVED by both (ciphertext cannot be hash-checked here)', async () => {
    const item = mkItem({ encryption: true });
    const { direct, archive } = await both(item);

    expect(direct.served).toBe(true);
    expect(archive.served).toBe(true);
    expect(archive.needsFetch).toBe(0);
    expect(inspectItemIntegrity(item, AUTHOR.address).code).toBe('encrypted');
  });

  it('the direct path refuses a self-consistent forgery it used to serve', async () => {
    // Regression pin for the seam this pass closed: attacker's own author, own
    // hash, own proof — every intra-blob check passes, only the deal author
    // disagrees. The OLD hash-only check called this 'ok'.
    const item = mkItem({ signer: ATTACKER });
    mockChain(mkEntry());
    vi.mocked(catFile).mockResolvedValue(JSON.stringify(item));

    await expect(fetchById(GENESIS, PUBLICATION, [], GATEWAY)).rejects.toBeInstanceOf(
      ContentIntegrityError,
    );
  });
});

describe('parity: failure SHAPE is the only deliberate difference', () => {
  it('a refusal is a thrown job for the page body, a non-fatal skip for a collection', async () => {
    const item = mkItem({ plaintextHash: '0x' + '00'.repeat(32) });
    mockChain(mkEntry());
    vi.mocked(catFile).mockResolvedValue(JSON.stringify(item));

    // page body: the job fails — there is nothing to substitute
    await expect(fetchById(GENESIS, PUBLICATION, [], GATEWAY)).rejects.toBeInstanceOf(
      ContentIntegrityError,
    );
    // collection (same choke point, different envelope): item dropped, cause named
    const { skips } = await import('./module.factory').then((m) =>
      m.fetchByPublicationWithSkips(PUBLICATION, [], GATEWAY),
    );
    expect(skips).toHaveLength(1);
    expect(skips[0].cause).toBe('integrity');
    expect(skips[0].reason).toMatch(/hash-mismatch/);
  });

  it('malformed items are "unavailable", not "integrity" (a read failure is not tampering)', async () => {
    mockChain(mkEntry());
    vi.mocked(catFile).mockResolvedValue(JSON.stringify({ public: {}, body: {} }));

    const { skips } = await import('./module.factory').then((m) =>
      m.fetchByPublicationWithSkips(PUBLICATION, [], GATEWAY),
    );
    expect(skips[0].cause).toBe('unavailable');
  });
});

describe('checkItemIntegrity is the shared verdict, bound to the deal author', () => {
  it('never disagrees with inspectItemIntegrity on the same item', () => {
    const items = [
      mkItem(),
      mkItem({ signer: ATTACKER }),
      mkItem({ plaintextHash: null }),
      mkItem({ legacy: true }),
      mkItem({ encryption: true }),
      mkItem({ objectId: '0xzz' }),
    ];
    const entry = mkEntry();
    for (const item of items) {
      const verdict = inspectItemIntegrity(item as any, entry.author);
      const check = checkItemIntegrity(entry, item as any);
      expect(check.ok).toBe(verdict.level !== 'mismatch');
      if (!check.ok) expect(check.code).toBe(verdict.code);
    }
  });

  it('warns once per verdict code, not once per item', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entry = mkEntry();
    checkItemIntegrity(entry, mkItem({ legacy: true }) as any);
    checkItemIntegrity(entry, mkItem({ legacy: true }) as any);
    checkItemIntegrity(entry, mkItem({ encryption: true }) as any);

    const lines = warn.mock.calls.flat().map(String);
    expect(lines.filter((l) => l.includes('(legacy-item)'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('(encrypted)'))).toHaveLength(1);
    warn.mockRestore();
  });
});

// ============================================================================
// Review item #2 — the two doors share ONE shape gate.
//
// Before this the direct door accepted "anything with a `public` object" while
// the archive door required a schema-valid content item, so the SAME bytes could
// be served by one door and refused by the other. A shape defect is a doubt
// ('unavailable'), never a proven forgery ('integrity').
// ============================================================================

describe('parity: the shared shape gate (review item #2)', () => {
  it('missing public.tags — refused by both, as unavailable', async () => {
    const item = mkItem() as any;
    delete item.public.tags;

    const { direct, archive } = await both(item);

    expect(direct.served).toBe(false);
    expect(direct.code).toBe('malformed-item');
    expect(direct.cause).toBe('unavailable');
    // The archive cannot STORE it either: parseArchive's shape gate drops it, so
    // the archive door sees "no entry" and asks for the on-chain refetch — where
    // judgeRefetchedItem reaches the identical verdict.
    expect(archive.served).toBe(false);
    expect(archive.needsFetch).toBe(1);
  });

  it('public.author = "nobody" — refused by both, as unavailable', async () => {
    const item = mkItem({ author: 'nobody' as never });

    const { direct, archive } = await both(item);

    expect(direct.served).toBe(false);
    expect(direct.code).toBe('malformed-item');
    expect(direct.cause).toBe('unavailable');
    expect(archive.served).toBe(false);
    expect(archive.needsFetch).toBe(1);
  });

  it('a LEGACY item (no specVersion envelope) is NOT malformed — both serve it', async () => {
    // The shape gate must not turn "old" into "broken": it validates a
    // specVersion-less item against the fields that existed then.
    const { direct, archive } = await both(mkItem({ legacy: true }));

    expect(direct.served).toBe(true);
    expect(archive.served).toBe(true);
    expect(archive.code).toBeNull();
  });
});

// ============================================================================
// Review item #3 — the skip taxonomy survives the shared envelope gap.
//
// `DataAvailabilityEntry` (shared/protocol/types.ts, off-limits) has no `cause`
// and no `code`, so the collection skips projected into a render's availability
// list lose the type that `ItemSkip`/`CollectionSkip` carry internally. Every
// reason string therefore carries the code in one stable, greppable form:
//
//   integrity(<code>): <human detail>
//   unavailable: <human detail>
//
// SKIP_REASON_RE is the single definition; both read paths build their reasons
// through skipReason(). The clean follow-up is adding `cause` + `code` to the
// envelope.
// ============================================================================

describe('skip reasons are machine-greppable on both paths (review item #3)', () => {
  it('every collection skip reason matches SKIP_REASON_RE', async () => {
    // three items: one forged (integrity), one malformed (unavailable), one whose
    // cat fails (unavailable transport).
    const forged = mkItem({ body: jcs({ title: 't', slug: 's', content: 'PWNED' }) });
    const malformed = mkItem() as any;
    delete malformed.public.tags;
    const gone = 'bafygone';

    vi.mocked(evmRead).mockResolvedValue([
      { genesis: 'g-forged', author: AUTHOR.address, cid: 'bafyforged', timestamp: 1 },
      { genesis: 'g-bad', author: AUTHOR.address, cid: 'bafybad', timestamp: 2 },
      { genesis: 'g-gone', author: AUTHOR.address, cid: gone, timestamp: 3 },
    ] as never);
    vi.mocked(catFile).mockImplementation(((gateway: string, cid: string) => {
      if (cid === 'bafyforged') return Promise.resolve(JSON.stringify(forged));
      if (cid === 'bafybad') return Promise.resolve(JSON.stringify(malformed));
      return Promise.reject(new Error('gateway 504'));
    }) as never);

    const { skips } = await import('./module.factory').then((m) =>
      m.fetchByPublicationWithSkips(PUBLICATION, [], GATEWAY),
    );

    expect(skips).toHaveLength(3);
    for (const skip of skips) {
      expect(SKIP_REASON_RE.test(skip.reason), skip.reason).toBe(true);
    }
    expect(skips.find((s) => s.genesis === 'g-forged')?.cause).toBe('integrity');
    expect(skips.find((s) => s.genesis === 'g-bad')?.cause).toBe('unavailable');
    expect(skips.find((s) => s.genesis === 'g-gone')?.cause).toBe('unavailable');
  });

  it('the code in the reason is the verdict code', () => {
    const m = SKIP_REASON_RE.exec('integrity(hash-mismatch): body does not hash');
    expect(m?.[1]).toBe('integrity(hash-mismatch)');
    expect(m?.[2]).toBe('hash-mismatch');
    expect(SKIP_REASON_RE.exec('unavailable: gateway 504')?.[2]).toBeUndefined();
    // and it does NOT match a message that forgot the tag
    expect(SKIP_REASON_RE.test('body does not hash to public.plaintextHash')).toBe(false);
  });
});
