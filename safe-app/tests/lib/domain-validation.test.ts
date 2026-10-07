import { describe, it, expect, vi } from 'vitest';
import {
  verifyDomainOwnership,
  maybeVerifyDomainOwnership,
  getEnsOwner,
  DOMAIN_VALIDATION_CONFIG,
  ENS_REGISTRY_ADDRESS,
  ENS_L1_CHAIN_ID,
  type DomainOwnershipDeps,
  type EvmReadFn,
} from '../../src/lib/domain-validation';

// Deterministic stand-in for ethers.namehash so the mock can map node → owner.
const nodeFor = (name: string): string =>
  '0x' +
  [...name]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');

const NAMEWRAPPER = '0x00000000000000000000000000000000000000AA';
const ZERO = '0x0000000000000000000000000000000000000000';

const PUB_SAFE = '0xabc0000000000000000000000000000000000001';
const OTHER_SAFE = '0xdef0000000000000000000000000000000000002';

/**
 * Build deps backed by a name → owner map. `ownerOf` returns the zero address
 * for names not present (unregistered/unwrapped domain). Optionally record the
 * RPC calls and/or throw on every read to simulate a transport failure.
 */
function makeDeps(
  ownerByName: Record<string, string>,
  hooks?: { record?: unknown[]; throwOnRead?: boolean },
): DomainOwnershipDeps {
  const evmRead: EvmReadFn = async (chainId, contractAddress, abi, method, args) => {
    hooks?.record?.push({ chainId, contractAddress, abi, method, args });
    if (hooks?.throwOnRead) throw new Error('rpc down');
    if (method === 'nameWrapper') return NAMEWRAPPER;
    if (method === 'ownerOf') {
      const node = String(args[0]);
      const entry = Object.entries(ownerByName).find(([name]) => nodeFor(name) === node);
      return entry ? entry[1] : ZERO;
    }
    throw new Error(`unexpected call ${method}`);
  };
  const namehash = (name: string) => nodeFor(name);
  return { namehash, evmRead };
}

describe('getEnsOwner', () => {
  it('resolves the owner of a wrapped name', async () => {
    const deps = makeDeps({ 's3ntiment.eth': PUB_SAFE });
    await expect(getEnsOwner('s3ntiment.eth', deps)).resolves.toBe(PUB_SAFE);
  });

  it('returns null (lowercased zero address treated as unowned) for an unregistered name', async () => {
    const deps = makeDeps({}); // no owner map → ownerOf returns zero address
    await expect(getEnsOwner('missing.eth', deps)).resolves.toBeNull();
  });

  it('returns null (never throws) when the RPC read fails', async () => {
    const deps = makeDeps({ 's3ntiment.eth': PUB_SAFE }, { throwOnRead: true });
    await expect(getEnsOwner('s3ntiment.eth', deps)).resolves.toBeNull();
  });

  it('reads the NameWrapper through the ENS registry on L1 (chainId 1)', async () => {
    const record: unknown[] = [];
    const deps = makeDeps({ 's3ntiment.eth': PUB_SAFE }, { record });
    await getEnsOwner('s3ntiment.eth', deps);
    const wrapperCall = record.find((r: any) => r.method === 'nameWrapper') as any;
    expect(wrapperCall).toBeDefined();
    expect(wrapperCall.chainId).toBe(ENS_L1_CHAIN_ID);
    expect(wrapperCall.contractAddress).toBe(ENS_REGISTRY_ADDRESS);
    const ownerCall = record.find((r: any) => r.method === 'ownerOf') as any;
    expect(ownerCall.args[0]).toBe(nodeFor('s3ntiment.eth'));
  });
});

describe('verifyDomainOwnership', () => {
  it('accepts a domain owned by the same publication Safe as the publication name', async () => {
    const deps = makeDeps({
      's3ntiment.eth': PUB_SAFE,
      'testpub.soul2soul.eth': PUB_SAFE,
    });
    const result = await verifyDomainOwnership('s3ntiment.eth', 'testpub.soul2soul.eth', deps);
    expect(result.ok).toBe(true);
    expect(result.domainOwner).toBe(PUB_SAFE);
    expect(result.publicationOwner).toBe(PUB_SAFE);
  });

  it('is case-insensitive on addresses (checksummed owner still matches)', async () => {
    const checksummedPub = '0xAbC0000000000000000000000000000000000001';
    const deps = makeDeps({
      's3ntiment.eth': '0xAbC0000000000000000000000000000000000001',
      'testpub.soul2soul.eth': checksummedPub,
    });
    const result = await verifyDomainOwnership('s3ntiment.eth', 'testpub.soul2soul.eth', deps);
    expect(result.ok).toBe(true);
    expect(result.domainOwner).toBe(PUB_SAFE); // lowercased
  });

  it('REJECTS a domain owned by a different Safe with a clear reason', async () => {
    const deps = makeDeps({
      's3ntiment.eth': OTHER_SAFE,
      'testpub.soul2soul.eth': PUB_SAFE,
    });
    const result = await verifyDomainOwnership('s3ntiment.eth', 'testpub.soul2soul.eth', deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('s3ntiment.eth');
    expect(result.reason).toContain(OTHER_SAFE);
    expect(result.reason).toContain(PUB_SAFE);
  });

  it('REJECTS an unregistered / unwrapped domain (no owner)', async () => {
    const deps = makeDeps({
      'testpub.soul2soul.eth': PUB_SAFE,
    });
    const result = await verifyDomainOwnership('missing.eth', 'testpub.soul2soul.eth', deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a wrapped ENS domain/i);
  });

  it('REJECTS an empty domain input', async () => {
    const deps = makeDeps({ 'testpub.soul2soul.eth': PUB_SAFE });
    const result = await verifyDomainOwnership('   ', 'testpub.soul2soul.eth', deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/enter an ens domain/i);
  });

  it('REJECTS when the current publication name cannot be resolved', async () => {
    const deps = makeDeps({
      's3ntiment.eth': PUB_SAFE,
    });
    const result = await verifyDomainOwnership('s3ntiment.eth', 'gone.soul2soul.eth', deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/current publication/i);
  });

  it('REJECTS when there is no publication name record', async () => {
    const deps = makeDeps({ 's3ntiment.eth': PUB_SAFE });
    const result = await verifyDomainOwnership('s3ntiment.eth', '', deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no publication name record/i);
  });

  it('never throws on RPC failure — fails closed with a reason', async () => {
    const deps = makeDeps(
      { 's3ntiment.eth': PUB_SAFE, 'testpub.soul2soul.eth': PUB_SAFE },
      { throwOnRead: true },
    );
    const result = await verifyDomainOwnership('s3ntiment.eth', 'testpub.soul2soul.eth', deps);
    expect(result.ok).toBe(false);
  });
});

describe('enforcement toggle (maybeVerifyDomainOwnership / DOMAIN_VALIDATION_CONFIG)', () => {
  it('is OFF by default', () => {
    expect(DOMAIN_VALIDATION_CONFIG.enforceOwnership).toBe(false);
  });

  it('accepts any entered domain with the gate OFF and skips the ownership check entirely', async () => {
    // evmRead that throws if it is ever called — proving the check is skipped.
    const evmRead = vi.fn().mockRejectedValue(new Error('must not be called'));
    const deps: DomainOwnershipDeps = {
      namehash: (name: string) => nodeFor(name),
      evmRead,
    };

    const result = await maybeVerifyDomainOwnership(
      'anything.eth',
      'testpub.soul2soul.eth',
      deps,
      { enforceOwnership: false },
    );

    expect(result.ok).toBe(true);
    expect(evmRead).not.toHaveBeenCalled();
  });

  it('delegates to the full ownership gate when the gate is ON — different-Safe domain still rejected', async () => {
    const deps = makeDeps({
      's3ntiment.eth': OTHER_SAFE,
      'testpub.soul2soul.eth': PUB_SAFE,
    });

    const result = await maybeVerifyDomainOwnership(
      's3ntiment.eth',
      'testpub.soul2soul.eth',
      deps,
      { enforceOwnership: true },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(OTHER_SAFE);
  });

  it('delegates to the full ownership gate when the gate is ON — same-Safe domain still accepted', async () => {
    const deps = makeDeps({
      's3ntiment.eth': PUB_SAFE,
      'testpub.soul2soul.eth': PUB_SAFE,
    });

    const result = await maybeVerifyDomainOwnership(
      's3ntiment.eth',
      'testpub.soul2soul.eth',
      deps,
      { enforceOwnership: true },
    );

    expect(result.ok).toBe(true);
    expect(result.domainOwner).toBe(PUB_SAFE);
  });
});
