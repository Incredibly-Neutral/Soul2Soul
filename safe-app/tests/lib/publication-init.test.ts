// safe-app/tests/lib/publication-init.test.ts
//
// Unit tests for the pure "new publication init" orchestration
// (SPEC-hosts.md AD-3): encoding, batch building, ModuleCreated-log detection,
// and the full initializePublication flow. Node env, no browser, no SDK — all
// runtime deps are injected mocks.

import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Interface, getAddress } from 'ethers';
import { Abi_S2SRecordsModuleFactory } from '../../../protocol/generated/abis/S2SRecordsModuleFactory';
import { Abi_S2SPublicationModuleV2Factory } from '../../../protocol/generated/abis/S2SPublicationModuleV2Factory';
import {
  buildCreateModuleBatch,
  buildEnableModuleBatch,
  buildNameRecordBatch,
  buildDeletePublicationBatch,
  encodeEnableModule,
  encodeCreateRecordsModule,
  encodeCreatePublicationModule,
  encodeSetRecord,
  encodeDisableModule,
  encodeDeleteRecord,
  moduleCreatedTopic0,
  detectModuleAddresses,
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
const OTHER_SAFE = getAddress('0x9999999999999999999999999999999999999999');
const RECORDS_FACTORY = getAddress('0x2222222222222222222222222222222222222222');
const PUB_FACTORY = getAddress('0x3333333333333333333333333333333333333333');
const RECORDS_MODULE = getAddress('0x4444444444444444444444444444444444444444');
const PUB_MODULE = getAddress('0x5555555555555555555555555555555555555555');
const AUTHOR1 = getAddress('0x6666666666666666666666666666666666666666');
const AUTHOR2 = getAddress('0x7777777777777777777777777777777777777777');

const recordsTopic0 = moduleCreatedTopic0(Abi_S2SRecordsModuleFactory);
const pubTopic0 = moduleCreatedTopic0(Abi_S2SPublicationModuleV2Factory);

/** Left-pad an address to the 32-byte indexed-topic form. */
function pad(addr: string): string {
  return `0x${addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/** Build a ModuleCreated log: topic0, padded indexed safe, padded indexed module. */
function logFor(topic0: string, safe: string, module: string): { topics: string[] } {
  return { topics: [topic0, pad(safe), pad(module)] };
}

const detectDeps = {
  safeAddress: SAFE,
  recordsFactory: RECORDS_FACTORY,
  publicationFactory: PUB_FACTORY,
  getBlockNumber: async () => 1_000_000,
  now: () => 500,
};

// ---------------------------------------------------------------------------
// Encoders.
// ---------------------------------------------------------------------------

describe('encoders', () => {
  it('encodeEnableModule: Safe enableModule selector + arg encoding', () => {
    const iface = new Interface(['function enableModule(address module)']);
    expect(encodeEnableModule(RECORDS_MODULE)).toBe(
      iface.encodeFunctionData('enableModule', [RECORDS_MODULE]),
    );
    expect(
      encodeEnableModule(RECORDS_MODULE).startsWith(iface.getFunction('enableModule').selector),
    ).toBe(true);
  });

  it('encodeCreateRecordsModule: recordsFactory.createModule(safe)', () => {
    const iface = new Interface(Abi_S2SRecordsModuleFactory);
    const data = encodeCreateRecordsModule(SAFE);
    expect(data).toBe(iface.encodeFunctionData('createModule', [SAFE]));
    expect(data.startsWith(iface.getFunction('createModule').selector)).toBe(true);
  });

  it('encodeCreatePublicationModule: publicationFactory.createModule(safe, authors, [])', () => {
    const iface = new Interface(Abi_S2SPublicationModuleV2Factory);
    const data = encodeCreatePublicationModule(SAFE, [AUTHOR1, AUTHOR2]);
    expect(data).toBe(iface.encodeFunctionData('createModule', [SAFE, [AUTHOR1, AUTHOR2], []]));
    expect(data.startsWith(iface.getFunction('createModule').selector)).toBe(true);
    // empty authors still encodes the address[] slot as an empty array
    expect(encodeCreatePublicationModule(SAFE, [])).toBe(
      iface.encodeFunctionData('createModule', [SAFE, [], []]),
    );
  });

  it('encodeSetRecord: recordsModule.setRecord(key, value)', () => {
    const iface = new Interface(['function setRecord(string key, string value)']);
    expect(encodeSetRecord('name', 'my-pub')).toBe(
      iface.encodeFunctionData('setRecord', ['name', 'my-pub']),
    );
  });

  it('encodeDisableModule: Safe disableModule selector + arg encoding', () => {
    const iface = new Interface(['function disableModule(address prevModule, address module)']);
    expect(encodeDisableModule(SAFE, RECORDS_MODULE)).toBe(
      iface.encodeFunctionData('disableModule', [SAFE, RECORDS_MODULE]),
    );
  });

  it('encodeDeleteRecord: recordsModule.deleteRecord(key)', () => {
    const iface = new Interface(['function deleteRecord(string key)']);
    expect(encodeDeleteRecord('name')).toBe(iface.encodeFunctionData('deleteRecord', ['name']));
  });

  it('moduleCreatedTopic0: derived from each factory ABI and distinct', () => {
    const rec = moduleCreatedTopic0(Abi_S2SRecordsModuleFactory);
    const pub = moduleCreatedTopic0(Abi_S2SPublicationModuleV2Factory);
    expect(rec).toBe(
      new Interface(Abi_S2SRecordsModuleFactory).getEvent('ModuleCreated').topicHash,
    );
    expect(pub).toBe(
      new Interface(Abi_S2SPublicationModuleV2Factory).getEvent('ModuleCreated').topicHash,
    );
    // different event signatures → different topic0
    expect(rec).not.toBe(pub);
  });
});

// ---------------------------------------------------------------------------
// Batch builders.
// ---------------------------------------------------------------------------

describe('batch builders', () => {
  const protocolInfo = { recordsFactory: RECORDS_FACTORY, publicationFactory: PUB_FACTORY };

  it('buildCreateModuleBatch: [records.createModule(safe), publication.createModule(safe, authors, [])]', () => {
    const recIface = new Interface(Abi_S2SRecordsModuleFactory);
    const pubIface = new Interface(Abi_S2SPublicationModuleV2Factory);
    const batch = buildCreateModuleBatch(protocolInfo, SAFE, [AUTHOR1, AUTHOR2]);
    expect(batch).toEqual([
      {
        to: RECORDS_FACTORY,
        value: '0',
        data: recIface.encodeFunctionData('createModule', [SAFE]),
      },
      {
        to: PUB_FACTORY,
        value: '0',
        data: pubIface.encodeFunctionData('createModule', [SAFE, [AUTHOR1, AUTHOR2], []]),
      },
    ]);
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

  it('every batch tx carries value "0"', () => {
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
      for (const tx of batch) expect(tx.value).toBe('0');
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
    // Last tx is still the name-record deletion.
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
// detectModuleAddresses.
// ---------------------------------------------------------------------------

describe('detectModuleAddresses', () => {
  it('happy path: both modules found on the first poll', async () => {
    const fetchModuleCreatedLogs = vi.fn(async (factory: string) => {
      if (factory === RECORDS_FACTORY) return [logFor(recordsTopic0, SAFE, RECORDS_MODULE)];
      return [logFor(pubTopic0, SAFE, PUB_MODULE)];
    });
    const getBlockNumber = vi.fn(async () => 1_000_000);

    const result = await detectModuleAddresses(
      { ...detectDeps, fetchModuleCreatedLogs, getBlockNumber },
      { pollIntervalMs: 0 },
    );

    expect(result).toEqual({ recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE });
    expect(fetchModuleCreatedLogs).toHaveBeenCalledTimes(2);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
  });

  it('polls until both modules are found', async () => {
    let calls = 0;
    const fetchModuleCreatedLogs = vi.fn(async (factory: string) => {
      calls += 1;
      if (calls < 3) return [];
      if (factory === RECORDS_FACTORY) return [logFor(recordsTopic0, SAFE, RECORDS_MODULE)];
      return [logFor(pubTopic0, SAFE, PUB_MODULE)];
    });
    const getBlockNumber = vi.fn(async () => 1_000_000);
    const now = vi.fn(() => 500); // constant → never times out

    const result = await detectModuleAddresses(
      { ...detectDeps, fetchModuleCreatedLogs, getBlockNumber, now },
      { pollIntervalMs: 0 },
    );

    expect(result).toEqual({ recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE });
    expect(fetchModuleCreatedLogs).toHaveBeenCalledTimes(4); // 2 factories × 2 polls
  });

  it('ignores logs whose topic[1] is a different safe', async () => {
    let calls = 0;
    const fetchModuleCreatedLogs = vi.fn(async (factory: string) => {
      calls += 1;
      if (factory === RECORDS_FACTORY) {
        // First poll: a ModuleCreated for OTHER_SAFE — must be ignored.
        if (calls === 1) return [logFor(recordsTopic0, OTHER_SAFE, RECORDS_MODULE)];
        return [logFor(recordsTopic0, SAFE, RECORDS_MODULE)];
      }
      return [logFor(pubTopic0, SAFE, PUB_MODULE)];
    });
    const getBlockNumber = vi.fn(async () => 1_000_000);

    const result = await detectModuleAddresses(
      { ...detectDeps, fetchModuleCreatedLogs, getBlockNumber },
      { pollIntervalMs: 0 },
    );

    expect(result).toEqual({ recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE });
  });

  it('timeout: descriptive error naming the missing module', async () => {
    const fetchModuleCreatedLogs = vi.fn(async (factory: string) => {
      if (factory === RECORDS_FACTORY) return [logFor(recordsTopic0, SAFE, RECORDS_MODULE)];
      return []; // publication never deployed
    });
    let t = 0;
    const now = vi.fn(() => (t += 100_000)); // start=100000; check=200000 (elapsed 100000 < 120000 → poll); check=300000 → throws

    await expect(
      detectModuleAddresses(
        { ...detectDeps, fetchModuleCreatedLogs, now },
        { timeoutMs: 120_000, pollIntervalMs: 0 },
      ),
    ).rejects.toThrow(/Timed out/);
    await expect(
      detectModuleAddresses(
        { ...detectDeps, fetchModuleCreatedLogs, now },
        { timeoutMs: 120_000, pollIntervalMs: 0 },
      ),
    ).rejects.toThrow(/publication/);
  });

  it('module address is parsed from topic[2] and normalized to checksum', async () => {
    // Lowercase topics are the on-chain form; the returned address must be checksummed.
    const lowerRecords = RECORDS_MODULE.toLowerCase();
    const lowerPub = PUB_MODULE.toLowerCase();
    const fetchModuleCreatedLogs = vi.fn(async (factory: string) => {
      if (factory === RECORDS_FACTORY)
        return [{ topics: [recordsTopic0, pad(SAFE), pad(lowerRecords)] }];
      return [{ topics: [pubTopic0, pad(SAFE), pad(lowerPub)] }];
    });

    const result = await detectModuleAddresses(
      { ...detectDeps, fetchModuleCreatedLogs },
      { pollIntervalMs: 0 },
    );

    expect(result.recordsModule).toBe(getAddress(lowerRecords));
    expect(result.publicationModule).toBe(getAddress(lowerPub));
  });

  it('prefers the most recent ModuleCreated log (last wins) so re-init after reset lands on fresh modules', async () => {
    // The factories are non-idempotent: a prior init's logs are still inside
    // the lookback window when a new run starts. eth_getLogs returns logs
    // oldest-first, so the stale run's logs come before the fresh run's.
    const OLD_RECORDS = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const OLD_PUB = getAddress('0x8888888888888888888888888888888888888888');
    const fetchModuleCreatedLogs = vi.fn(async (factory: string) => {
      if (factory === RECORDS_FACTORY) {
        return [
          logFor(recordsTopic0, SAFE, OLD_RECORDS),
          logFor(recordsTopic0, SAFE, RECORDS_MODULE),
        ];
      }
      return [logFor(pubTopic0, SAFE, OLD_PUB), logFor(pubTopic0, SAFE, PUB_MODULE)];
    });

    const result = await detectModuleAddresses(
      { ...detectDeps, fetchModuleCreatedLogs },
      { pollIntervalMs: 0 },
    );

    expect(result).toEqual({ recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE });
  });
});

// ---------------------------------------------------------------------------
// waitForModulesEnabled — the human-in-the-loop bridge between the enable
// proposal and the name-record proposal.
// ---------------------------------------------------------------------------

describe('waitForModulesEnabled', () => {
  const deps = {
    recordsModule: RECORDS_MODULE,
    publicationModule: PUB_MODULE,
    isModuleEnabled: async () => true,
    now: () => 1000,
  };

  it('returns immediately when both modules are already enabled', async () => {
    const isModuleEnabled = vi.fn(async () => true);
    await waitForModulesEnabled({ ...deps, isModuleEnabled }, { pollIntervalMs: 0 });
    expect(isModuleEnabled).toHaveBeenCalledWith(RECORDS_MODULE);
    expect(isModuleEnabled).toHaveBeenCalledWith(PUB_MODULE);
    expect(isModuleEnabled).toHaveBeenCalledTimes(2);
  });

  it('polls until both modules become enabled', async () => {
    const isModuleEnabled = vi
      .fn()
      .mockResolvedValueOnce(false) // poll 1: records, publication
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false) // poll 2: records, publication
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true) // poll 3 onwards: both true
      .mockResolvedValue(true);

    await waitForModulesEnabled(
      { ...deps, isModuleEnabled },
      { pollIntervalMs: 0, timeoutMs: 60_000 },
    );
    expect(isModuleEnabled).toHaveBeenCalledTimes(6);
  });

  it('times out naming the module(s) still not enabled', async () => {
    const isModuleEnabled = vi.fn(async (module: string) => module !== RECORDS_MODULE);
    let t = 1000;
    const now = vi.fn(() => (t += 2_000)); // start = 3000; next now() = 5000 → elapsed 2000 > 1000

    await expect(
      waitForModulesEnabled(
        { ...deps, isModuleEnabled, now },
        { timeoutMs: 1_000, pollIntervalMs: 0 },
      ),
    ).rejects.toThrow(/not enabled: records/);
    expect(isModuleEnabled).toHaveBeenCalledWith(RECORDS_MODULE);
    expect(isModuleEnabled).toHaveBeenCalledWith(PUB_MODULE);
  });
});

// initializePublication.
// ---------------------------------------------------------------------------

describe('initializePublication', () => {
  const initDeps = {
    chainId: 8453,
    safeAddress: SAFE,
    protocolInfo: { recordsFactory: RECORDS_FACTORY, publicationFactory: PUB_FACTORY },
    propose: async () => 'proposal-0',
    fetchModuleCreatedLogs: async (factory: string) =>
      factory === RECORDS_FACTORY
        ? [logFor(recordsTopic0, SAFE, RECORDS_MODULE)]
        : [logFor(pubTopic0, SAFE, PUB_MODULE)],
    getBlockNumber: async () => 1_000_000,
    isModuleEnabled: async () => true,
    now: () => 500,
  };

  it('happy path: exactly 2 proposals, correct batches, verification passes', async () => {
    let n = 0;
    const propose = vi.fn(async (_txs: MetaTransactionData[]) => `proposal-${++n}`);
    const isModuleEnabled = vi.fn(async () => true);

    const result = await initializePublication({ ...initDeps, propose, isModuleEnabled }, {});

    expect(result).toEqual({
      recordsModule: RECORDS_MODULE,
      publicationModule: PUB_MODULE,
      nameRecorded: false,
      proposals: ['proposal-1', 'proposal-2'],
    });
    expect(propose).toHaveBeenCalledTimes(2);
    // batch contents, in order
    expect(propose.mock.calls[0][0]).toEqual(
      buildCreateModuleBatch(initDeps.protocolInfo, SAFE, []),
    );
    expect(propose.mock.calls[1][0]).toEqual(
      buildEnableModuleBatch(SAFE, RECORDS_MODULE, PUB_MODULE),
    );
    // verification ran on both modules
    expect(isModuleEnabled).toHaveBeenCalledWith(RECORDS_MODULE);
    expect(isModuleEnabled).toHaveBeenCalledWith(PUB_MODULE);
  });

  it('with a name: 3 proposals (create, enable, name-record), nameRecorded true', async () => {
    let n = 0;
    const propose = vi.fn(async (_txs: MetaTransactionData[]) => `proposal-${++n}`);

    const result = await initializePublication({ ...initDeps, propose }, { name: 'my-pub' });

    expect(result.nameRecorded).toBe(true);
    expect(result.proposals).toEqual(['proposal-1', 'proposal-2', 'proposal-3']);
    expect(propose).toHaveBeenCalledTimes(3);
    expect(propose.mock.calls[2][0]).toEqual(buildNameRecordBatch(RECORDS_MODULE, 'my-pub'));
  });

  it('authors are passed into the create batch (createModule(safe, authors, []))', async () => {
    const propose = vi.fn(async (_txs: MetaTransactionData[]) => `p`);
    await initializePublication({ ...initDeps, propose }, { authors: [AUTHOR1, AUTHOR2] });
    expect(propose.mock.calls[0][0]).toEqual(
      buildCreateModuleBatch(initDeps.protocolInfo, SAFE, [AUTHOR1, AUTHOR2]),
    );
  });

  it('detection timeout surfaces a descriptive error', async () => {
    const fetchModuleCreatedLogs = vi.fn(async () => []); // nothing ever deployed
    let t = 0;
    const now = vi.fn(() => (t += 130_000)); // start=130000; first check elapsed 130000 > default 120000 → throw

    await expect(
      initializePublication({ ...initDeps, fetchModuleCreatedLogs, now }, {}),
    ).rejects.toThrow(/Timed out/);
  });

  it('delays the name-record proposal until the enable batch is executed', async () => {
    let n = 0;
    const propose = vi.fn(async (_txs: MetaTransactionData[]) => `proposal-${++n}`);
    // Polls 1-2 see modules disabled; poll 3 sees both enabled.
    const isModuleEnabled = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
      .mockResolvedValue(true);

    const result = await initializePublication(
      { ...initDeps, propose, isModuleEnabled },
      { name: 'my-pub', enablePollIntervalMs: 0 },
    );

    // Name record proposed last, only after the modules became enabled.
    expect(propose).toHaveBeenCalledTimes(3);
    expect(propose.mock.calls[2][0]).toEqual(buildNameRecordBatch(RECORDS_MODULE, 'my-pub'));
    expect(isModuleEnabled).toHaveBeenCalledTimes(6);
    expect(result.proposals).toEqual(['proposal-1', 'proposal-2', 'proposal-3']);
  });

  it('times out (name never proposed) when the enable batch is never executed', async () => {
    let n = 0;
    const propose = vi.fn(async (_txs: MetaTransactionData[]) => `proposal-${++n}`);
    const isModuleEnabled = vi.fn(async (module: string) => module !== RECORDS_MODULE);
    let t = 500;
    // now() advances past the 1000ms timeout on the very first check.
    const now = vi.fn(() => (t += 2_000));

    await expect(
      initializePublication(
        { ...initDeps, propose, isModuleEnabled, now },
        { enableTimeoutMs: 1_000, enablePollIntervalMs: 0 },
      ),
    ).rejects.toThrow(/not enabled: records/);

    // The enable batch was proposed, but the name record was NOT (wait timed out first).
    expect(propose).toHaveBeenCalledTimes(2);
    expect(propose.mock.calls[1][0]).toEqual(
      buildEnableModuleBatch(SAFE, RECORDS_MODULE, PUB_MODULE),
    );
    expect(isModuleEnabled).toHaveBeenCalledWith(RECORDS_MODULE);
    expect(isModuleEnabled).toHaveBeenCalledWith(PUB_MODULE);
  });

  it('no direct sends: all I/O goes through injected deps, lib stays pure', async () => {
    const propose = vi.fn(async (_txs: MetaTransactionData[]) => 'p');
    const fetchModuleCreatedLogs = vi.fn(async (factory: string) =>
      factory === RECORDS_FACTORY
        ? [logFor(recordsTopic0, SAFE, RECORDS_MODULE)]
        : [logFor(pubTopic0, SAFE, PUB_MODULE)],
    );

    await initializePublication({ ...initDeps, propose, fetchModuleCreatedLogs }, {});

    // The flow is driven purely by the injected deps — nothing else is touched.
    expect(propose).toHaveBeenCalled();
    expect(fetchModuleCreatedLogs).toHaveBeenCalled();
    expect(initDeps.getBlockNumber).toBeDefined();

    // Structural purity: no SDK, no safe-integration, no window, no shared import.
    // (Match import statements — the header comment may legitimately name them.)
    const src = await readFile(
      new URL('../../src/lib/publication-init.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/^import .*@safe-global\/safe-apps-sdk/m);
    expect(src).not.toMatch(/^import .*safe-integration/m);
    expect(src).not.toMatch(/window\./);
    expect(src).not.toMatch(/@s2s\/soul2soul-shared/);
  });

  it('defaultSafeUrl matches the Safe queue URL format', () => {
    expect(defaultSafeUrl(8453, SAFE)).toBe(
      `https://app.safe.global/transactions/queue?safe=8453:${SAFE}`,
    );
  });
});
