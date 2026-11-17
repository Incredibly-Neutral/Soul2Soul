// safe-app/tests/lib/publication-init.test.ts
//
// Unit tests for the pure "new publication init" orchestration
// (SPEC-author-hosts.md AD-3): encoding, batch building, the moduleAddress read
// and poll, and the full initializePublication flow. Node env, no browser, no
// SDK — all runtime deps are injected mocks.

import { describe, it, expect, vi } from 'vitest';
import { AbiCoder, Interface, getAddress } from 'ethers';
import { Abi_S2SPublicationModulesFactoryV0_1 } from '@s2s/publication-contracts/abis/S2SPublicationModulesFactoryV0_1';
import {
  S2S_MODULE_KIND_PUBLICATION,
  S2S_MODULE_KIND_RECORDS,
} from '@s2s/soul2soul-shared/safe-app';
import {
  buildCreateModuleBatch,
  buildEnableModuleBatch,
  buildFinalizeBatch,
  buildNameRecordBatch,
  buildDeletePublicationBatch,
  encodeEnableModule,
  encodeCreateRecordsModule,
  encodeCreatePublicationModule,
  encodeSetRecord,
  encodeDisableModule,
  encodeDeleteRecord,
  moduleAddressFor,
  waitForModuleAddress,
  waitForModulesEnabled,
  initializePublication,
  defaultSafeUrl,
} from '../../src/lib/publication-init';
import type { MetaTransactionData } from '../../src/lib/publication-init';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

// All-digit addresses → trivially valid checksums; getAddress keeps them equal.
const SAFE = getAddress('0x1111111111111111111111111111111111111111');
const MODULE_FACTORY = getAddress('0x2222222222222222222222222222222222222222');
const RECORDS_MODULE = getAddress('0x4444444444444444444444444444444444444444');
const PUB_MODULE = getAddress('0x5555555555555555555555555555555555555555');
const AUTHOR1 = getAddress('0x6666666666666666666666666666666666666666');
const AUTHOR2 = getAddress('0x7777777777777777777777777777777777777777');
const ZERO = '0x0000000000000000000000000000000000000000';

const protocolInfo = { moduleFactory: MODULE_FACTORY };
const factoryIface = new Interface(Abi_S2SPublicationModulesFactoryV0_1);

/** The factory's answer for each kind: one module per (safe, kind). */
const MODULES: Record<string, string> = {
  [S2S_MODULE_KIND_RECORDS]: RECORDS_MODULE,
  [S2S_MODULE_KIND_PUBLICATION]: PUB_MODULE,
};

/** Decode a createModule call back into (safe, kind, params). */
function decodeCreate(data: string) {
  const [safe, kind, params] = factoryIface.decodeFunctionData('createModule', data).toArray();
  return { safe, kind, params };
}

/**
 * A `read` stub answering `moduleAddress(safe, kind)` from `MODULES`. Any other
 * method is a bug in the lib, so it throws rather than returning something.
 */
function makeRead(mapping: Record<string, string> = MODULES) {
  const calls: Array<{ factory: string; method: string; args: unknown[] }> = [];
  const read = vi.fn(async (factory: string, _abi: unknown, method: string, args: unknown[]) => {
    calls.push({ factory, method, args });
    if (method !== 'moduleAddress') throw new Error(`unexpected read: ${method}`);
    return mapping[String(args[1])] ?? ZERO;
  });
  return { read, calls };
}

/**
 * A Safe + factory that remember what a proposed batch did: a batch to the
 * factory deploys the modules, a batch to the Safe enables them. The proposal
 * mock applies it, so the reads after it see the chain the human would have.
 */
function makeChain() {
  const state = { created: false, enabled: false };
  const { read } = makeRead();
  let n = 0;
  const propose = vi.fn(async (txs: MetaTransactionData[]) => {
    if (txs.every((tx) => tx.to.toLowerCase() === MODULE_FACTORY.toLowerCase())) {
      state.created = true;
    }
    if (txs.some((tx) => tx.to.toLowerCase() === SAFE.toLowerCase())) {
      state.enabled = true;
    }
    return `proposal-${++n}`;
  });
  const deps = {
    chainId: 8453,
    safeAddress: SAFE,
    protocolInfo,
    propose,
    read,
    hasCode: async () => state.created,
    isModuleEnabled: vi.fn(async () => state.enabled),
    now: () => 0,
  };
  return { state, propose, deps };
}

// ---------------------------------------------------------------------------
// Encoders.
// ---------------------------------------------------------------------------

describe('encoders', () => {
  it('encodeEnableModule: Safe enableModule selector + arg encoding', () => {
    const iface = new Interface(['function enableModule(address module)']);
    expect(encodeEnableModule(RECORDS_MODULE)).toBe(
      iface.encodeFunctionData('enableModule', [RECORDS_MODULE]),
    );
  });

  it('encodeDisableModule: Safe disableModule selector + arg encoding', () => {
    const iface = new Interface(['function disableModule(address prevModule, address module)']);
    expect(encodeDisableModule(RECORDS_MODULE, PUB_MODULE)).toBe(
      iface.encodeFunctionData('disableModule', [RECORDS_MODULE, PUB_MODULE]),
    );
  });

  it('encodeCreateRecordsModule: createModule(safe, recordsKind, abi.encode(string[], string[]))', () => {
    const coder = AbiCoder.defaultAbiCoder();
    const data = encodeCreateRecordsModule(SAFE, [
      { key: 'name', value: 'my-pub' },
      { key: 'repo', value: 'https://example.org/r' },
    ]);
    const decoded = decodeCreate(data);
    expect(decoded.safe).toBe(SAFE);
    expect(decoded.kind).toBe(S2S_MODULE_KIND_RECORDS);
    expect(coder.decode(['string[]', 'string[]'], decoded.params)).toEqual([
      ['name', 'repo'],
      ['my-pub', 'https://example.org/r'],
    ]);
  });

  it('encodeCreateRecordsModule: no entries encodes two empty arrays, not empty params', () => {
    const coder = AbiCoder.defaultAbiCoder();
    const decoded = decodeCreate(encodeCreateRecordsModule(SAFE));
    expect(coder.decode(['string[]', 'string[]'], decoded.params)).toEqual([[], []]);
  });

  it('encodeCreatePublicationModule: createModule(safe, publicationKind, abi.encode(address[], address[]))', () => {
    const coder = AbiCoder.defaultAbiCoder();
    const decoded = decodeCreate(
      encodeCreatePublicationModule(SAFE, [AUTHOR1, AUTHOR2], [AUTHOR2]),
    );
    expect(decoded.safe).toBe(SAFE);
    expect(decoded.kind).toBe(S2S_MODULE_KIND_PUBLICATION);
    expect(coder.decode(['address[]', 'address[]'], decoded.params)).toEqual([
      [AUTHOR1, AUTHOR2],
      [AUTHOR2],
    ]);
  });

  it('encodeSetRecord: recordsModule.setRecord(key, value)', () => {
    const iface = new Interface(['function setRecord(string key, string value)']);
    expect(encodeSetRecord('name', 'my-pub')).toBe(
      iface.encodeFunctionData('setRecord', ['name', 'my-pub']),
    );
  });

  it('encodeDeleteRecord: recordsModule.deleteRecord(key)', () => {
    const iface = new Interface(['function deleteRecord(string key)']);
    expect(encodeDeleteRecord('name')).toBe(iface.encodeFunctionData('deleteRecord', ['name']));
  });
});

// ---------------------------------------------------------------------------
// Batch builders.
// ---------------------------------------------------------------------------

describe('batch builders', () => {
  it('buildCreateModuleBatch: two creates, both to the one factory', () => {
    const batch = buildCreateModuleBatch(protocolInfo, SAFE, [AUTHOR1, AUTHOR2]);
    expect(batch).toEqual([
      { to: MODULE_FACTORY, value: '0', data: encodeCreateRecordsModule(SAFE) },
      {
        to: MODULE_FACTORY,
        value: '0',
        data: encodeCreatePublicationModule(SAFE, [AUTHOR1, AUTHOR2]),
      },
    ]);
  });

  it('buildCreateModuleBatch: the kinds are the shared constants', () => {
    const batch = buildCreateModuleBatch(protocolInfo, SAFE, []);
    expect(decodeCreate(batch[0].data).kind).toBe(S2S_MODULE_KIND_RECORDS);
    expect(decodeCreate(batch[1].data).kind).toBe(S2S_MODULE_KIND_PUBLICATION);
  });

  it('buildEnableModuleBatch: [enableModule(records), enableModule(publication)] to the Safe', () => {
    const iface = new Interface(['function enableModule(address module)']);
    const batch = buildEnableModuleBatch(SAFE, RECORDS_MODULE, PUB_MODULE);
    expect(batch).toEqual([
      { to: SAFE, value: '0', data: iface.encodeFunctionData('enableModule', [RECORDS_MODULE]) },
      { to: SAFE, value: '0', data: iface.encodeFunctionData('enableModule', [PUB_MODULE]) },
    ]);
  });

  it('buildNameRecordBatch: [records.setRecord("name", name)]', () => {
    const iface = new Interface(['function setRecord(string key, string value)']);
    const batch = buildNameRecordBatch(RECORDS_MODULE, 'my-pub');
    expect(batch).toEqual([
      {
        to: RECORDS_MODULE,
        value: '0',
        data: iface.encodeFunctionData('setRecord', ['name', 'my-pub']),
      },
    ]);
  });

  it('buildNameRecordBatch: appends repo/branch setRecords when supplied', () => {
    const iface = new Interface(['function setRecord(string key, string value)']);
    const batch = buildNameRecordBatch(RECORDS_MODULE, 'my-pub', {
      repo: 'https://github.com/acme/site',
      branch: 'main',
    });
    expect(batch).toEqual([
      {
        to: RECORDS_MODULE,
        value: '0',
        data: iface.encodeFunctionData('setRecord', ['name', 'my-pub']),
      },
      {
        to: RECORDS_MODULE,
        value: '0',
        data: iface.encodeFunctionData('setRecord', ['repo', 'https://github.com/acme/site']),
      },
      {
        to: RECORDS_MODULE,
        value: '0',
        data: iface.encodeFunctionData('setRecord', ['branch', 'main']),
      },
    ]);
  });

  it('every batch tx carries value "0" and a real target', () => {
    for (const batch of [
      buildCreateModuleBatch(protocolInfo, SAFE, []),
      buildEnableModuleBatch(SAFE, RECORDS_MODULE, PUB_MODULE),
      buildNameRecordBatch(RECORDS_MODULE, 'x'),
      buildDeletePublicationBatch(
        SAFE,
        { recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE },
        [RECORDS_MODULE, PUB_MODULE],
      ),
    ]) {
      for (const tx of batch) {
        expect(tx.value).toBe('0');
        expect(tx.to).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// buildDeletePublicationBatch (teardown / start-over).
// ---------------------------------------------------------------------------

describe('buildDeletePublicationBatch', () => {
  const disableIface = new Interface([
    'function disableModule(address prevModule, address module)',
  ]);
  const delIface = new Interface(['function deleteRecord(string key)']);

  it('disables in reverse list order with the correct prev, then deletes the name record', () => {
    // Safe list order: [records, publication]. publication is later → disabled
    // first (prev = records), then records (prev = sentinel), then deleteRecord.
    const batch = buildDeletePublicationBatch(
      SAFE,
      { recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE },
      [RECORDS_MODULE, PUB_MODULE],
    );
    expect(batch).toEqual([
      {
        to: SAFE,
        value: '0',
        data: disableIface.encodeFunctionData('disableModule', [RECORDS_MODULE, PUB_MODULE]),
      },
      {
        to: SAFE,
        value: '0',
        data: disableIface.encodeFunctionData('disableModule', [
          '0x0000000000000000000000000000000000000001',
          RECORDS_MODULE,
        ]),
      },
      {
        to: RECORDS_MODULE,
        value: '0',
        data: delIface.encodeFunctionData('deleteRecord', ['name']),
      },
    ]);
  });

  it('computed prevs come from the surrounding list, not assuming adjacency', () => {
    const OTHER = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const OTHER2 = getAddress('0x8888888888888888888888888888888888888888');
    // List: [OTHER, records, OTHER2, publication].
    // publication (idx 3) disabled first with prev = OTHER2;
    // records (idx 1) disabled second with prev = OTHER.
    const batch = buildDeletePublicationBatch(
      SAFE,
      { recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE },
      [OTHER, RECORDS_MODULE, OTHER2, PUB_MODULE],
    );
    expect(batch.slice(0, 2)).toEqual([
      {
        to: SAFE,
        value: '0',
        data: disableIface.encodeFunctionData('disableModule', [OTHER2, PUB_MODULE]),
      },
      {
        to: SAFE,
        value: '0',
        data: disableIface.encodeFunctionData('disableModule', [OTHER, RECORDS_MODULE]),
      },
    ]);
    expect(batch[2]).toEqual({
      to: RECORDS_MODULE,
      value: '0',
      data: delIface.encodeFunctionData('deleteRecord', ['name']),
    });
  });

  it('handles a partial state: only the module actually present is disabled', () => {
    const batch = buildDeletePublicationBatch(
      SAFE,
      { recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE },
      [RECORDS_MODULE], // publication not currently enabled
    );
    expect(batch).toEqual([
      {
        to: SAFE,
        value: '0',
        data: disableIface.encodeFunctionData('disableModule', [
          '0x0000000000000000000000000000000000000001',
          RECORDS_MODULE,
        ]),
      },
      {
        to: RECORDS_MODULE,
        value: '0',
        data: delIface.encodeFunctionData('deleteRecord', ['name']),
      },
    ]);
  });

  it('omits the name deletion when no records module address is supplied', () => {
    const batch = buildDeletePublicationBatch(
      SAFE,
      { recordsModule: '', publicationModule: PUB_MODULE },
      [PUB_MODULE],
    );
    expect(batch).toEqual([
      {
        to: SAFE,
        value: '0',
        data: disableIface.encodeFunctionData('disableModule', [
          '0x0000000000000000000000000000000000000001',
          PUB_MODULE,
        ]),
      },
    ]);
  });

  it('omits the name deletion when deleteName:false (record not on-chain)', () => {
    // deleteRecord('name') reverts KeyNotFound() when the record was never
    // written, and the batch is one atomic MultiSend — so callers gate the
    // deletion on the record existing. Default stays delete-on.
    const batch = buildDeletePublicationBatch(
      SAFE,
      { recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE },
      [RECORDS_MODULE, PUB_MODULE],
      { deleteName: false },
    );
    expect(batch.length).toBe(2);
    expect(batch.every((tx) => tx.to.toLowerCase() === SAFE.toLowerCase())).toBe(true);
  });

  it('throws when neither module is in the Safe module list', () => {
    expect(() =>
      buildDeletePublicationBatch(
        SAFE,
        { recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE },
        [],
      ),
    ).toThrow(/No enabled S2S modules to reset/);
  });
});

// ---------------------------------------------------------------------------
// moduleAddressFor — one read, no fallback.
// ---------------------------------------------------------------------------

describe('moduleAddressFor', () => {
  it('asks the factory for (safe, kind) and checksums the answer', async () => {
    let lower = RECORDS_MODULE.toLowerCase().replace('0x11', '0xab');
    const mapping = { [S2S_MODULE_KIND_RECORDS]: lower };
    const { read, calls } = makeRead(mapping);

    const address = await moduleAddressFor({ read }, MODULE_FACTORY, SAFE, S2S_MODULE_KIND_RECORDS);

    expect(address).toBe(getAddress(lower));
    expect(calls).toEqual([
      {
        factory: MODULE_FACTORY,
        method: 'moduleAddress',
        args: [SAFE, S2S_MODULE_KIND_RECORDS],
      },
    ]);
  });

  it('refuses address(0): no implementation for the kind means no create can succeed', async () => {
    const { read } = makeRead({});
    await expect(
      moduleAddressFor({ read }, MODULE_FACTORY, SAFE, S2S_MODULE_KIND_RECORDS),
    ).rejects.toThrow(/no implementation set for that kind/);
  });

  it('refuses a non-address answer rather than guessing one', async () => {
    const read = vi.fn(async () => '0x1234');
    await expect(
      moduleAddressFor({ read }, MODULE_FACTORY, SAFE, S2S_MODULE_KIND_RECORDS),
    ).rejects.toThrow(/names no .* module/);
  });
});

// ---------------------------------------------------------------------------
// waitForModuleAddress — the address is known before the create; code proves it.
// ---------------------------------------------------------------------------

describe('waitForModuleAddress', () => {
  it('polls until the module at the factory address has code', async () => {
    const { read, calls } = makeRead();
    let polls = 0;
    const hasCode = vi.fn(async () => ++polls >= 3);

    const address = await waitForModuleAddress(
      { read, hasCode, now: () => 0 },
      MODULE_FACTORY,
      SAFE,
      S2S_MODULE_KIND_RECORDS,
      { pollIntervalMs: 0 },
    );

    expect(address).toBe(RECORDS_MODULE);
    expect(hasCode).toHaveBeenCalledWith(RECORDS_MODULE);
    expect(calls.length).toBe(3);
  });

  it('times out naming the address, without ever asking another source', async () => {
    const { read } = makeRead();
    let t = 0;
    const now = () => (t += 100);

    await expect(
      waitForModuleAddress(
        { read, hasCode: async () => false, now },
        MODULE_FACTORY,
        SAFE,
        S2S_MODULE_KIND_PUBLICATION,
        { timeoutMs: 250, pollIntervalMs: 0 },
      ),
    ).rejects.toThrow(
      new RegExp(`Timed out after 250ms waiting for the .* module at ${PUB_MODULE}`),
    );
  });
});

// ---------------------------------------------------------------------------
// waitForModulesEnabled.
// ---------------------------------------------------------------------------

describe('waitForModulesEnabled', () => {
  const deps = {
    read: makeRead().read,
    hasCode: async () => true,
    factory: MODULE_FACTORY,
    safeAddress: SAFE,
    isModuleEnabled: async () => true,
    now: () => 1000,
  };

  it('returns both module addresses when they are already enabled', async () => {
    const isModuleEnabled = vi.fn(async () => true);
    const result = await waitForModulesEnabled({ ...deps, isModuleEnabled }, { pollIntervalMs: 0 });
    expect(result).toEqual({ recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE });
    expect(isModuleEnabled).toHaveBeenCalledWith(RECORDS_MODULE);
    expect(isModuleEnabled).toHaveBeenCalledWith(PUB_MODULE);
    expect(isModuleEnabled).toHaveBeenCalledTimes(2);
  });

  it('polls until both modules become enabled', async () => {
    const isModuleEnabled = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
      .mockResolvedValue(true);

    await waitForModulesEnabled(
      { ...deps, isModuleEnabled },
      { pollIntervalMs: 0, timeoutMs: 60_000 },
    );
    expect(isModuleEnabled).toHaveBeenCalledTimes(6);
  });

  it('times out naming the module(s) still not enabled', async () => {
    const isModuleEnabled = vi.fn(async (module: string) => module !== RECORDS_MODULE);
    let t = 0;
    const now = () => (t += 2_000);

    await expect(
      waitForModulesEnabled(
        { ...deps, isModuleEnabled, now },
        { timeoutMs: 1_000, pollIntervalMs: 0 },
      ),
    ).rejects.toThrow(/not enabled: records/);
  });
});

// ---------------------------------------------------------------------------
// initializePublication — read both kinds, propose what is missing, wait.
// ---------------------------------------------------------------------------

describe('initializePublication', () => {
  it('fresh Safe: one create proposal, then the merged enable batch', async () => {
    const { propose, deps } = makeChain();

    const result = await initializePublication(deps, {});

    expect(result).toEqual({
      recordsModule: RECORDS_MODULE,
      publicationModule: PUB_MODULE,
      nameRecorded: false,
      proposals: ['proposal-1', 'proposal-2'],
    });
    expect(propose.mock.calls[0][0]).toEqual(buildCreateModuleBatch(protocolInfo, SAFE, []));
    expect(propose.mock.calls[1][0]).toEqual(
      buildEnableModuleBatch(SAFE, RECORDS_MODULE, PUB_MODULE),
    );
    expect(deps.isModuleEnabled).toHaveBeenCalledWith(RECORDS_MODULE);
    expect(deps.isModuleEnabled).toHaveBeenCalledWith(PUB_MODULE);
  });

  it('reads moduleAddress for BOTH kinds before proposing anything', async () => {
    const { deps } = makeChain();
    const calls: unknown[] = [];
    const read = vi.fn(async (factory: string, abi: any, method: string, args: unknown[]) => {
      calls.push([...args]);
      return deps.read(factory, abi, method, args);
    });
    await initializePublication({ ...deps, read }, {});

    const kinds = calls.map((args: any) => args[1]);
    expect(kinds).toContain(S2S_MODULE_KIND_RECORDS);
    expect(kinds).toContain(S2S_MODULE_KIND_PUBLICATION);
  });

  it('one kind already deployed: the create batch still names both, and nothing is duplicated', async () => {
    const { propose, deps, state } = makeChain();
    // Records exists, publication does not (a half-run init, or a session that
    // lost the second module). The batch must still carry both calls: the
    // factory returns the recorded records module and creates the publication.
    await initializePublication(
      { ...deps, hasCode: async (addr: string) => addr === RECORDS_MODULE || state.created },
      {},
    );

    const create = propose.mock.calls[0][0];
    expect(create).toEqual(buildCreateModuleBatch(protocolInfo, SAFE, []));
    expect(create).toHaveLength(2);
    // One call per kind, both to the one factory: no second call for the kind
    // that already exists.
    expect(create.map((tx) => tx.to)).toEqual([MODULE_FACTORY, MODULE_FACTORY]);
    expect(create.map((tx) => decodeCreate(tx.data).kind)).toEqual([
      S2S_MODULE_KIND_RECORDS,
      S2S_MODULE_KIND_PUBLICATION,
    ]);
  });

  it('modules already deployed: only the enable batch is proposed', async () => {
    const { propose, deps } = makeChain();
    await initializePublication({ ...deps, hasCode: async () => true }, {});

    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0][0]).toEqual(
      buildEnableModuleBatch(SAFE, RECORDS_MODULE, PUB_MODULE),
    );
  });

  it('with a name: 2 proposals (create, merged enable+name), nameRecorded true', async () => {
    const { propose, deps } = makeChain();

    const result = await initializePublication(deps, {
      name: 'my-pub',
      authors: [AUTHOR1],
      repo: 'https://github.com/acme/site',
      branch: 'dev',
    });

    expect(result.nameRecorded).toBe(true);
    expect(result.proposals.length).toBe(2);
    expect(propose.mock.calls[0][0]).toEqual(buildCreateModuleBatch(protocolInfo, SAFE, [AUTHOR1]));
    expect(propose.mock.calls[1][0]).toEqual(
      buildFinalizeBatch(SAFE, RECORDS_MODULE, PUB_MODULE, 'my-pub', {
        repo: 'https://github.com/acme/site',
        branch: 'dev',
      }),
    );
  });

  it('live modules, name not recorded yet: only the name batch', async () => {
    const { propose, deps } = makeChain();
    const result = await initializePublication(
      { ...deps, hasCode: async () => true, isModuleEnabled: async () => true },
      { name: 'my-pub' },
    );
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0][0]).toEqual(buildNameRecordBatch(RECORDS_MODULE, 'my-pub'));
    expect(result.proposals).toEqual(['proposal-1']);
  });

  it('a fully live publication proposes nothing', async () => {
    const { propose, deps } = makeChain();
    await initializePublication(
      { ...deps, hasCode: async () => true, isModuleEnabled: async () => true },
      {},
    );
    expect(propose).toHaveBeenCalledTimes(0);
  });

  it('a create that never executes fails the wait instead of returning addresses', async () => {
    let t = 0;
    const { deps } = makeChain();
    await expect(
      initializePublication(
        {
          ...deps,
          propose: async () => 'p',
          hasCode: async () => false,
          isModuleEnabled: async () => false,
          now: () => (t += 100_000),
        },
        { enableTimeoutMs: 1, enablePollIntervalMs: 0 },
      ),
    ).rejects.toThrow(/Timed out/);
  });

  it('no direct sends: all I/O goes through injected deps, lib stays pure', async () => {
    const { propose, deps } = makeChain();
    await initializePublication(deps, {});
    expect(propose).toHaveBeenCalledTimes(2);
    expect((globalThis as any).window).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// defaultSafeUrl.
// ---------------------------------------------------------------------------

describe('defaultSafeUrl', () => {
  it('matches the Safe queue URL format', () => {
    expect(defaultSafeUrl(8453, SAFE)).toBe(
      `https://app.safe.global/transactions/queue?safe=8453:${SAFE}`,
    );
  });
});
