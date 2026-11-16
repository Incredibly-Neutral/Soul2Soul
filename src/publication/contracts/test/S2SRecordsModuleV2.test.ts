import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem';

/**
 * The records module as a factory-deployed proxy, and what that buys:
 *
 *   - its address is computable before it exists, the same way a publication
 *     module's is, because it is the same proxy over the same factory,
 *   - the Safe it answers to is the one the factory recorded, not a constructor
 *     argument,
 *   - it upgrades only to a build approved for the records kind, and a build
 *     approved for the publication kind is not one.
 */

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();

type Hex = `0x${string}`;

const PUBLICATION_KIND: Hex = keccak256(toHex('s2s.publication.module'));
const RECORDS_KIND: Hex = keccak256(toHex('s2s.module.records'));

const FACTORY_ABI = parseAbi([
  'function setImplementation(bytes32 kind, address implementation)',
  'function createModule(address safe, bytes32 kind, bytes params) returns (address module, bool created)',
  'function moduleOf(address safe, bytes32 kind) view returns (address)',
  'function moduleAddress(address safe, bytes32 kind) view returns (address)',
  'function proxyInitCodeHash() view returns (bytes32)',
]);

const RECORDS_ABI = parseAbi([
  'function NAME() view returns (string)',
  'function VERSION() view returns (string)',
  'function safe() view returns (address)',
  'function moduleKind() view returns (bytes32)',
  'function factory() view returns (address)',
  'function setRecord(string key, string value)',
  'function setRecords(string[] keys, string[] values)',
  'function deleteRecord(string key)',
  'function getRecord(string key) view returns (string)',
  'function getAllKeys() view returns (string[])',
  'function getRecordCount() view returns (uint256)',
  'function upgradeToAndCall(address newImplementation, bytes data)',
]);

const rec = <T extends string>(fn: T, args: unknown[]): Hex =>
  encodeFunctionData({ abi: RECORDS_ABI, functionName: fn as never, args: args as never });

const seed = (keys: string[], values: string[]): Hex =>
  encodeAbiParameters([{ type: 'string[]' }, { type: 'string[]' }], [keys, values]);

async function deploy() {
  const protocolSafe = await viem.deployContract('MockCaller');
  const factory = await viem.deployContract('S2SPublicationModulesFactoryV6', [protocolSafe.address]);
  const safe = await viem.deployContract('MockCaller');
  return { protocolSafe, factory, safe };
}

describe('S2SRecordsModuleV2', () => {
  it('is created by the same factory at the address a client computes in advance', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const impl = await viem.deployContract('S2SRecordsModuleV2', [factory.address, protocolSafe.address]);

    assert.equal(await impl.read.moduleKind(), RECORDS_KIND);
    await protocolSafe.write.exec([
      factory.address,
      encodeFunctionData({ abi: FACTORY_ABI, functionName: 'setImplementation', args: [RECORDS_KIND, impl.address] }),
    ]);

    // The address is derived from (factory, safe, kind) and the proxy's creation
    // code, all of which exist before the module does.
    const predicted = await factory.read.moduleAddress([safe.address, RECORDS_KIND]);
    const { result } = await factory.simulate.createModule(
      [safe.address, RECORDS_KIND, seed(['s2s.publication', 's2s.ens'], ['name.soul.eth', 'soul2soul.eth'])],
      { account: safe.address },
    );
    assert.equal(result[0].toLowerCase(), predicted.toLowerCase());
    assert.equal(result[1], true);

    await safe.write.exec([
      factory.address,
      encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: 'createModule',
        args: [safe.address, RECORDS_KIND, seed(['s2s.publication', 's2s.ens'], ['name.soul.eth', 'soul2soul.eth'])],
      }),
    ]);

    const module = await viem.getContractAt('S2SRecordsModuleV2', predicted);
    assert.equal((await module.read.safe()).toLowerCase(), safe.address.toLowerCase());
    assert.equal((await module.read.factory()).toLowerCase(), factory.address.toLowerCase());
    assert.equal(await module.read.NAME(), 'S2S Records Module');
    assert.deepEqual(await module.read.getAllKeys(), ['s2s.publication', 's2s.ens']);

    // The seeded records are announced, so an indexer that starts at the create
    // block sees them without reading storage.
    const seeded = await publicClient.getContractEvents({
      address: predicted,
      abi: parseAbi(['event RecordsSetBatch(string[] keys, string[] values)']),
      eventName: 'RecordsSetBatch',
    });
    assert.equal(seeded.length, 1);
    assert.deepEqual(seeded[0].args.keys, ['s2s.publication', 's2s.ens']);
    assert.equal(await module.read.getRecord(['s2s.publication']), 'name.soul.eth');
  });

  it('writes only for the owning Safe, and only the Safe can start an upgrade', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const impl = await viem.deployContract('S2SRecordsModuleV2', [factory.address, protocolSafe.address]);
    await protocolSafe.write.exec([
      factory.address,
      encodeFunctionData({ abi: FACTORY_ABI, functionName: 'setImplementation', args: [RECORDS_KIND, impl.address] }),
    ]);
    await safe.write.exec([
      factory.address,
      encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createModule', args: [safe.address, RECORDS_KIND, '0x'] }),
    ]);
    const module = await viem.getContractAt(
      'S2SRecordsModuleV2',
      await factory.read.moduleOf([safe.address, RECORDS_KIND]),
    );

    // OnlySafe() = 0xd7fed6bd: viem reports the selector rather than the name.
    const [stranger] = await viem.getWalletClients();
    await assert.rejects(
      module.write.setRecord(['k', 'v'], { account: stranger.account }),
      (error: unknown) => JSON.stringify(error).toLowerCase().includes('0xd7fed6bd'),
      'expected OnlySafe() from a stranger',
    );

    await safe.write.exec([module.address, rec('setRecord', ['k', 'v'])]);
    assert.equal(await module.read.getRecord(['k']), 'v');

    await safe.write.exec([module.address, rec('deleteRecord', ['k'])]);
    assert.equal(await module.read.getRecordCount(), 0n);
  });

  it('upgrades only to a build approved for the records kind', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const first = await viem.deployContract('S2SRecordsModuleV2', [factory.address, protocolSafe.address]);
    const second = await viem.deployContract('S2SRecordsModuleV2', [factory.address, protocolSafe.address]);
    const publicationBuild = await viem.deployContract('S2SPublicationModuleV6', [
      factory.address,
      protocolSafe.address,
    ]);

    await protocolSafe.write.exec([
      factory.address,
      encodeFunctionData({ abi: FACTORY_ABI, functionName: 'setImplementation', args: [RECORDS_KIND, first.address] }),
    ]);
    await safe.write.exec([
      factory.address,
      encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createModule', args: [safe.address, RECORDS_KIND, '0x'] }),
    ]);
    const moduleAddress = await factory.read.moduleOf([safe.address, RECORDS_KIND]);

    // A publication build cannot be approved for the records kind at all.
    await assert.rejects(
      protocolSafe.write.exec([
        factory.address,
        encodeFunctionData({
          abi: FACTORY_ABI,
          functionName: 'setImplementation',
          args: [RECORDS_KIND, publicationBuild.address],
        }),
      ]),
      /ImplementationKindMismatch/,
    );

    // An unapproved records build is refused by the module's own gate.
    await assert.rejects(
      safe.write.exec([moduleAddress, rec('upgradeToAndCall', [second.address, rec('moduleKind', [])])]),
      /ImplementationNotApproved/,
    );

    await protocolSafe.write.exec([
      factory.address,
      encodeFunctionData({ abi: FACTORY_ABI, functionName: 'setImplementation', args: [RECORDS_KIND, second.address] }),
    ]);
    await safe.write.exec([moduleAddress, rec('upgradeToAndCall', [second.address, rec('moduleKind', [])])]);

    const slot = await (await viem.getPublicClient()).request({
      method: 'eth_getStorageAt',
      params: [
        moduleAddress,
        '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
        'latest',
      ],
    });
    assert.equal(`0x${String(slot).slice(-40)}`.toLowerCase(), second.address.toLowerCase());
  });
});
