import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem';

/**
 * What the module has to answer for the factory to deploy and gate it, and what
 * it has to refuse on its own:
 *
 *   - it declares its kind, so the factory accepts it for that kind only,
 *   - its initializer is the factory's to call, once, with the safe the factory
 *     recorded, and it caps the lists it is handed,
 *   - its upgrade gate asks the factory about its own kind at the moment of the
 *     upgrade, so an unapproved target and another kind's target both refuse.
 */

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();

type Hex = `0x${string}`;

const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const KIND: Hex = keccak256(toHex('s2s.module.publication'));
const OTHER_KIND: Hex = keccak256(toHex('s2s.module.records'));

const SET_ABI = parseAbi(['function setImplementation(bytes32 kind, address implementation)']);
const MODULE_ABI = parseAbi(['function moduleKind() view returns (bytes32)']);
const CREATE_ABI = parseAbi([
  'function createModule(address safe, bytes32 kind, bytes params) returns (address module, bool created)',
]);

const setImplData = (kind: Hex, implementation: Hex): Hex =>
  encodeFunctionData({ abi: SET_ABI, functionName: 'setImplementation', args: [kind, implementation] });

const createData = (safe: Hex, kind: Hex, params: Hex): Hex =>
  encodeFunctionData({ abi: CREATE_ABI, functionName: 'createModule', args: [safe, kind, params] });

/**
 * OpenZeppelin 4.9 force-calls the new implementation even with an empty payload
 * (ERC1967Upgrade._upgradeToAndCall with forceCall), and a module has no fallback,
 * so the payload has to be a call the new implementation answers. `moduleKind()`
 * is a pure view, so it changes nothing.
 */
const UPGRADE_ABI = parseAbi(['function upgradeToAndCall(address newImplementation, bytes data)']);
const upgradeData = (target: Hex): Hex =>
  encodeFunctionData({
    abi: UPGRADE_ABI,
    functionName: 'upgradeToAndCall',
    args: [target, encodeFunctionData({ abi: MODULE_ABI, functionName: 'moduleKind', args: [] })],
  });

const authorsParams = (authors: Hex[], devs: Hex[] = []): Hex =>
  encodeAbiParameters([{ type: 'address[]' }, { type: 'address[]' }], [authors, devs]);

async function deploy() {
  const protocolSafe = await viem.deployContract('MockCaller');
  const factory = await viem.deployContract('S2SPublicationModulesFactoryV0_1', [protocolSafe.address]);
  const safe = await viem.deployContract('MockCaller');
  const author = (await viem.getWalletClients())[1].account.address as Hex;
  return { protocolSafe, factory, safe, author };
}

/** The client's id for a genesis. The module records who claims it, not how it was made. */
const genesisFor = (author: Hex, firstCid: string): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'string' }], [author, firstCid]));

const implementation = (factory: Hex, protocolSafe: Hex) =>
  viem.deployContract('S2SPublicationModuleV0_1', [factory, protocolSafe]);

describe('S2SPublicationModuleV0_1', () => {
  it('is accepted by the factory for its kind, and the module it deploys is initialised and usable', async () => {
    const { protocolSafe, factory, safe, author } = await deploy();
    const impl = await implementation(factory.address, protocolSafe.address);

    assert.equal(await impl.read.moduleKind(), KIND);
    assert.equal((await impl.read.factory()).toLowerCase(), factory.address.toLowerCase());
    assert.equal(await impl.read.NAME(), 'S2S Publication Module');

    await protocolSafe.write.exec([factory.address, setImplData(KIND, impl.address)]);
    await safe.write.exec([factory.address, createData(safe.address, KIND, authorsParams([author]))]);
    const moduleAddress = await factory.read.moduleOf([safe.address, KIND]);

    const module = await viem.getContractAt('S2SPublicationModuleV0_1', moduleAddress);
    assert.equal((await module.read.safe()).toLowerCase(), safe.address.toLowerCase());
    assert.equal(await module.read.moduleKind(), KIND);
    assert.equal(await module.read.canPublish([author]), true, 'the author list reached the initializer');

    // The module actually works: an author writes, and the version is readable.
    const genesis = genesisFor(author, 'bafy-one');
    await module.simulate.makeOffer([genesis, 'bafy-one'], { account: author });
    await module.write.makeOffer([genesis, 'bafy-one'], { account: author });
    const version = await module.read.getVersion([genesis, 0n]);
    assert.equal(version.cid, 'bafy-one');
  });

  it('cannot be initialised by anyone: the implementation is spent, and a create happens once', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const impl = await implementation(factory.address, protocolSafe.address);
    const [wallet] = await viem.getWalletClients();

    // The constructor spent the nonce, so the implementation itself can never be
    // initialised, by the factory or by anyone else.
    await assert.rejects(
      impl.write.initialize([safe.address, '0x'], { account: wallet.account }),
      /already initialized/,
    );

    await protocolSafe.write.exec([factory.address, setImplData(KIND, impl.address)]);
    await safe.write.exec([factory.address, createData(safe.address, KIND, '0x')]);
    const moduleAddress = await factory.read.moduleOf([safe.address, KIND]);
    const module = await viem.getContractAt('S2SPublicationModuleV0_1', moduleAddress);

    // A second create is a no-op: the module exists, params are not reapplied,
    // and the initializer is never reached a second time.
    const { result } = await factory.simulate.createModule(
      [safe.address, KIND, authorsParams([wallet.account.address as Hex])],
      { account: safe.address },
    );
    assert.equal(result[1], false);
    assert.equal((await module.read.safe()).toLowerCase(), safe.address.toLowerCase());
    assert.equal(await module.read.canPublish([wallet.account.address as Hex]), false);
  });

  it('caps the lists it is handed before writing them', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const impl = await implementation(factory.address, protocolSafe.address);
    await protocolSafe.write.exec([factory.address, setImplData(KIND, impl.address)]);

    const tooMany = Array.from({ length: 101 }, (_, i) => `0x${(i + 1000).toString(16).padStart(40, '0')}` as Hex);
    // The factory reports the module's revert rather than swallowing it: the
    // reason carries the module's own selector, 0xf2bb9825 = MaxAuthorsReached().
    await assert.rejects(
      safe.write.exec([factory.address, createData(safe.address, KIND, authorsParams(tooMany))]),
      /InitializerFailed/,
    );
    assert.equal(await factory.read.moduleOf([safe.address, KIND]), '0x0000000000000000000000000000000000000000');
  });

  it('upgrades only to an implementation approved for its own kind, read at the moment of the upgrade', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const first = await implementation(factory.address, protocolSafe.address);
    const second = await implementation(factory.address, protocolSafe.address);
    const foreign = await viem.deployContract('MockGatedModule', [factory.address, OTHER_KIND]);

    await protocolSafe.write.exec([factory.address, setImplData(KIND, first.address)]);
    await safe.write.exec([factory.address, createData(safe.address, KIND, '0x')]);
    const moduleAddress = await factory.read.moduleOf([safe.address, KIND]);

    // Approved for another kind only: the gate asks about this module's kind.
    // The other kind's implementation is a mock, because this one declares this
    // kind and the factory would refuse it for the other.
    const otherKind = await viem.deployContract('MockGatedModule', [factory.address, OTHER_KIND]);
    await protocolSafe.write.exec([factory.address, setImplData(OTHER_KIND, otherKind.address)]);
    await assert.rejects(safe.write.exec([moduleAddress, upgradeData(foreign.address)]), /ImplementationNotApproved/);

    // Approved for this kind: the upgrade goes through.
    await protocolSafe.write.exec([factory.address, setImplData(KIND, second.address)]);
    await safe.write.exec([moduleAddress, upgradeData(second.address)]);
    const slot = await publicClient.request({
      method: 'eth_getStorageAt',
      params: [moduleAddress, ERC1967_IMPLEMENTATION_SLOT, 'latest'],
    });
    assert.equal(`0x${String(slot).slice(-40)}`.toLowerCase(), second.address.toLowerCase());

    // Withdrawn afterwards: the same target is refused from then on.
    await protocolSafe.write.exec([
      factory.address,
      encodeFunctionData({
        abi: parseAbi(['function revokeImplementation(bytes32 kind, address implementation)']),
        functionName: 'revokeImplementation',
        args: [KIND, second.address],
      }),
    ]);
    const third = await implementation(factory.address, protocolSafe.address);
    await protocolSafe.write.exec([factory.address, setImplData(KIND, third.address)]);
    await safe.write.exec([moduleAddress, upgradeData(second.address)]).then(
      () => assert.fail('a withdrawn implementation must not be reachable'),
      () => {},
    );
  });

  it('refuses an upgrade started by anyone but the publication safe', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const first = await implementation(factory.address, protocolSafe.address);
    const second = await implementation(factory.address, protocolSafe.address);
    await protocolSafe.write.exec([factory.address, setImplData(KIND, first.address)]);
    await safe.write.exec([factory.address, createData(safe.address, KIND, '0x')]);
    await protocolSafe.write.exec([factory.address, setImplData(KIND, second.address)]);
    const moduleAddress = await factory.read.moduleOf([safe.address, KIND]);

    const stranger = (await viem.getWalletClients())[0];
    const module = await viem.getContractAt('S2SPublicationModuleV0_1', moduleAddress);

    // OnlySafe() = 0xd7fed6bd. The gate runs before the upgrade, so nothing is
    // written and the pointer stays where it was.
    await assert.rejects(
      module.write.upgradeToAndCall(
        [second.address, encodeFunctionData({ abi: MODULE_ABI, functionName: 'moduleKind', args: [] })],
        { account: stranger.account },
      ),
      (error: unknown) => JSON.stringify(error).toLowerCase().includes('0xd7fed6bd'),
      'expected OnlySafe() from the gate',
    );
  });
});
