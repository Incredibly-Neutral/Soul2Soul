/**
 * Tests for ENS name extraction and resolution helpers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractEnsName, isBareCID, isEnsName, namehash, resolveEnsToCID } from '../src/ens.js';
import {
  decodeContenthashWrapped,
  encodeContenthashWrapped,
  parseCID,
} from '../src/ipfs/contenthash.js';

describe('extractEnsName', () => {
  it('extracts ENS name from a full https URL', () => {
    expect(extractEnsName('https://xxx.soul2soul.eth')).toBe('xxx.soul2soul.eth');
  });

  it('extracts ENS name from a bare name', () => {
    expect(extractEnsName('xxx.soul2soul.eth')).toBe('xxx.soul2soul.eth');
  });

  it('returns bare CID unchanged (Qm prefix)', () => {
    const cid = 'QmT5NvUtoP5VZ5T7i5T5dV5T5V5T5V5T5V5T5V5T5V5T5V';
    expect(extractEnsName(cid)).toBe(cid);
  });

  it('returns bare CID unchanged (bafy prefix)', () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    expect(extractEnsName(cid)).toBe(cid);
  });

  it('strips trailing slash from bare name', () => {
    expect(extractEnsName('xxx.soul2soul.eth/')).toBe('xxx.soul2soul.eth');
  });

  it('strips path from URL', () => {
    expect(extractEnsName('https://xxx.soul2soul.eth/some/path')).toBe('xxx.soul2soul.eth');
  });
});

describe('isBareCID', () => {
  it('detects Qm-prefixed CIDv0', () => {
    expect(isBareCID('QmT5NvUtoP5VZ5T7i')).toBe(true);
  });

  it('detects b-prefixed CIDv1', () => {
    expect(isBareCID('bafybeigdyrzt5sfp')).toBe(true);
  });

  it('rejects ENS names', () => {
    expect(isBareCID('xxx.soul2soul.eth')).toBe(false);
  });

  it('rejects https URLs', () => {
    expect(isBareCID('https://xxx.soul2soul.eth')).toBe(false);
  });
});

describe('isEnsName', () => {
  it('detects .eth suffix', () => {
    expect(isEnsName('xxx.soul2soul.eth')).toBe(true);
  });

  it('rejects bare CID', () => {
    expect(isEnsName('QmT5NvUtoP5VZ5T7i')).toBe(false);
  });

  it('rejects non-eth strings', () => {
    expect(isEnsName('example.com')).toBe(false);
  });
});

describe('namehash', () => {
  it('computes the namehash for soul2soul.eth', () => {
    // Known namehash for soul2soul.eth
    const hash = namehash('soul2soul.eth');
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    // Verify it's deterministic
    expect(namehash('soul2soul.eth')).toBe(hash);
  });

  it('computes a consistent namehash for subdomains', () => {
    const hash1 = namehash('test.soul2soul.eth');
    const hash2 = namehash('test.soul2soul.eth');
    expect(hash1).toBe(hash2);
  });

  it('handles single-label .eth names', () => {
    const hash = namehash('eth');
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('normalizes case', () => {
    expect(namehash('SOUL2SOUL.ETH')).toBe(namehash('soul2soul.eth'));
  });
});

// ---------------------------------------------------------------------------
// resolveEnsToCID — canonical s2s mechanism: getText('contenthash_wrapped')
// on the Base-L2 (8453) ensRecords records contract, decoding the 0xe3 01
// <CID> envelope. The RPC (global fetch) is mocked per-test.
// ---------------------------------------------------------------------------

// ABI helpers to build eth_call return payloads for the mock RPC.
const pad64 = (n: bigint | number | string) => BigInt(n).toString(16).padStart(64, '0');

function abiEncodeAddress(a: string): string {
  return '0x' + pad64(a);
}

function abiEncodeString(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const padded = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
  padded.set(bytes);
  return (
    '0x' + pad64(0x20) + pad64(bytes.length) + Buffer.from(padded).toString('hex')
  );
}

function abiEncodeStringArray(strings: string[]): string {
  // Real string[] ABI return (offsets + lengths + utf8 data) — the same shape
  // S2SRecordsModule.getRecords() actually emits. Decoding this as address[]
  // (the pre-B1 bug) yields bogus non-empty addresses, so this mock catches
  // regressions of the getRecords string[] decode.
  const elems = strings.map((s) => {
    const bytes = new TextEncoder().encode(s);
    const padded = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
    padded.set(bytes);
    return pad64(bytes.length) + Buffer.from(padded).toString('hex');
  });
  let head = '0x' + pad64(0x20) + pad64(strings.length);
  let pos = 32 + 32 * strings.length; // first element data byte (from array data start)
  for (let i = 0; i < strings.length; i++) {
    head += pad64(pos - 32); // element offsets are relative to byte after length word
    pos += elems[i].length / 2;
  }
  return head + elems.join('');
}

// (address[] array, address next)
function abiEncodeModules(addrs: string[], next: string): string {
  return (
    '0x' +
    pad64(0x40) +
    pad64(next) +
    pad64(addrs.length) +
    addrs.map((a) => pad64(a)).join('')
  );
}

interface RpcRoute {
  to: string;
  selector: string;
  result: string;
}

function makeRpcMock(routes: RpcRoute[]) {
  return vi.fn(async (_url: string, init: any) => {
    const { to, data } = JSON.parse(init.body).params[0];
    const selector = data.slice(0, 10);
    const match = routes.find(
      (r) => r.to.toLowerCase() === to.toLowerCase() && r.selector === selector,
    );
    if (!match) throw new Error(`unexpected eth_call to ${to} ${selector}`);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: match.result }) };
  });
}

const S2S_REGISTRY = '0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5';

describe('resolveEnsToCID (s2s Base-L2 records contract)', () => {
  beforeEach(() => {
    // Ensure env overrides never leak into these tests — l2RpcUrl/recordsContract
    // are passed explicitly so resolution is fully determined by the mocks.
    delete process.env.L2_RPC_URL;
    delete process.env.RECORDS_CONTRACT;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.L2_RPC_URL;
    delete process.env.RECORDS_CONTRACT;
  });

  it('decodes a contenthash_wrapped text record read from the L2 records contract (RECORDS_CONTRACT override)', async () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    const envelope = encodeContenthashWrapped(parseCID(cid));
    // The text record value on-chain is the 0xe3 01 <CID> envelope hex string.
    expect(envelope).toMatch(/^0xe301/);
    expect(decodeContenthashWrapped(envelope).toString()).toBe(cid);

    const recordsContract = '0x' + 'ab'.repeat(20);
    const fetchMock = makeRpcMock([
      // getText(bytes32,string) — selector 0xad428dac
      { to: recordsContract, selector: '0xad428dac', result: abiEncodeString(envelope) },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveEnsToCID(
      's3nl.soul2soul.eth',
      'https://l1-mainnet.example.com',
      'https://base-mainnet.example.com',
      recordsContract, // RECORDS_CONTRACT override — skips discovery
    );

    expect(resolved).toBe(cid);
    // Exactly one eth_call, to the records contract on the L2 (Base) RPC.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://base-mainnet.example.com',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('discovers the ensRecords contract via the s2s ENS flow, then reads contenthash_wrapped on L2', async () => {
    const cid = 'QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv';
    const envelope = encodeContenthashWrapped(parseCID(cid));

    const nameWrapper = '0x' + '11'.repeat(20);
    const customRegistry = '0x' + '22'.repeat(20);
    const controller = '0x' + '33'.repeat(20);
    const configModule = '0x' + '44'.repeat(20);
    const ensRecords = '0x' + '55'.repeat(20);

    const fetchMock = makeRpcMock([
      // L1: nameWrapper() on the s2s registry
      { to: S2S_REGISTRY, selector: '0xa8e5fbc0', result: abiEncodeAddress(nameWrapper) },
      // L1: nameWrapper.ownerOf(namehash('soul2soul.eth'))
      { to: nameWrapper, selector: '0x6352211e', result: abiEncodeAddress(customRegistry) },
      // L1: customRegistry.parentDomainController()
      { to: customRegistry, selector: '0xe4df1462', result: abiEncodeAddress(controller) },
      // L2: controller.getModulesPaginated(...)
      { to: controller, selector: '0xcc2f8452', result: abiEncodeModules([configModule], controller) },
      // L2: configModule.NAME() == 'S2S Records Module'
      { to: configModule, selector: '0xa3f4df7e', result: abiEncodeString('S2S Records Module') },
      // L2: configModule.getRecords(...) → string[]; ens_records is index 1
      {
        to: configModule,
        selector: '0xbe880b7a',
        result: abiEncodeStringArray([
          'https://data-gateway.example.com', // data_gateway (URL string)
          ensRecords, // ens_records — literal 0x-prefixed address string
          '0x' + 'cc'.repeat(20), // ens_registry
        ]),
      },
      // L2: ensRecords.getText(node, 'contenthash_wrapped')
      { to: ensRecords, selector: '0xad428dac', result: abiEncodeString(envelope) },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveEnsToCID(
      's3nl.soul2soul.eth',
      'https://l1-mainnet.example.com',
      'https://base-mainnet.example.com',
    );

    expect(resolved).toBe(cid);
    // 3 L1 discovery calls + getModulesPaginated + NAME + getRecords + getText = 7
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('returns null when there is no contenthash_wrapped text record', async () => {
    const recordsContract = '0x' + 'ab'.repeat(20);
    const fetchMock = makeRpcMock([
      // getText returns an ABI-encoded empty string
      { to: recordsContract, selector: '0xad428dac', result: abiEncodeString('') },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveEnsToCID(
      's3nl.soul2soul.eth',
      'https://l1-mainnet.example.com',
      'https://base-mainnet.example.com',
      recordsContract,
    );

    expect(resolved).toBeNull();
  });

  it('returns the ens_records string element verbatim (B1 regression: getRecords is string[], not address[])', async () => {
    const configModule = '0x' + '44'.repeat(20);
    const ensRecords = '0x5D42f9b016B4251FC6407d5e8154DA887F394900';
    const fetchMock = makeRpcMock([
      // getRecords(string[]) returns string[] — index 1 is the literal
      // 0x-prefixed ens_records address string.
      {
        to: configModule,
        selector: '0xbe880b7a',
        result: abiEncodeStringArray([
          'https://data-gateway.example.com',
          ensRecords,
          '0x' + 'cc'.repeat(20),
        ]),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const { getRecordsContract } = await import('../src/ens.js');
    const result = await getRecordsContract(
      configModule,
      'https://base-mainnet.example.com',
    );

    // The full literal address string must be returned verbatim — decoding
    // the return as address[] (the pre-B1 bug) yields a bogus non-empty
    // address, so this assertion fails under the old decoder.
    expect(result).toBe(ensRecords);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
