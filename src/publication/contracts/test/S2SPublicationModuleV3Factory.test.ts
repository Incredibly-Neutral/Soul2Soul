import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import {
  decodeEventLog,
  encodeErrorResult,
  encodeFunctionData,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  zeroAddress,
} from 'viem';

/**
 * The two properties this factory exists for, plus the constructor refusals
 * that keep them from being bypassed by construction.
 *
 * `S2SPublicationModuleV2Factory` lets anyone call `setImplementation`, so any
 * address can decide what code every later publication is born with. V3 hands
 * that decision to one immutable address, and gates `createModule` so nobody
 * can mint a proxy naming somebody else's safe. Both are asserted here against
 * a real proxy deployment, not against a stub.
 *
 * Hardhat 3 + `node:test` + viem, same wiring as `src/author/contracts/test/`.
 * The protocol safe is a `MockCaller` fixture rather than a test account: the
 * constructor refuses an address without code, so `msg.sender` on the
 * protocol-safe path has to be a contract.
 */

const { viem } = await network.create();

const publicClient = await viem.getPublicClient();

type Hex = `0x${string}`;

const ERRORS = parseAbi([
  'error ZeroAddress()',
  'error NotAContract(address account)',
  'error OnlyProtocolSafe(address caller)',
  'error NotSafeOrProtocolSafe(address caller, address safe)',
]);

const enc = {
  zeroAddress: encodeErrorResult({ abi: ERRORS, errorName: 'ZeroAddress' }),
  notAContract: (account: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'NotAContract', args: [account] }),
  onlyProtocolSafe: (caller: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'OnlyProtocolSafe', args: [caller] }),
  notSafeOrProtocolSafe: (caller: Hex, safe: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'NotSafeOrProtocolSafe', args: [caller, safe] }),
};

/** Every layer of a viem error, as text: revert data can sit in `raw` or `data`. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let e = error as any; e; e = e.cause) {
    if (typeof e.raw === 'string') parts.push(e.raw);
    if (typeof e.data === 'string') parts.push(e.data);
    if (typeof e.message === 'string') parts.push(e.message);
  }
  return parts.join('\n');
}

/**
 * Assert a call reverts with `data`. The selector check is the real one; the
 * name in the decoded message is accepted as a fallback because viem does not
 * always surface `raw` for a reverted contract creation.
 */
async function expectRevert(call: Promise<unknown>, data: Hex, name: string) {
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${name}, but the call succeeded`);
  const text = errorText(caught);
  assert.ok(
    text.includes(data) || text.includes(name),
    `expected ${name} (${data}), got:\n${text.slice(0, 600)}`,
  );
}

/**
 * implementation → caller (a contract, so it can hold the protocol-safe role) →
 * factory. The module is the real V3 module: `createModule` proxies onto it and
 * calls its initializer, so a stub would prove nothing about the deployment.
 */
async function deploy() {
  const [deployer, other, safeOwner] = await viem.getWalletClients();

  const implementation = await viem.deployContract('S2SPublicationModuleV3');
  const caller = await viem.deployContract('MockCaller');
  // `sendDeploymentTransaction` rather than `deployContract` so the factory's
  // own `ImplementationDeployed` log can be decoded; the constructor's emit is
  // the only record that version 1 was announced.
  const { contract: factory, deploymentTransaction } = await viem.sendDeploymentTransaction(
    'S2SPublicationModuleV3Factory',
    [caller.address, implementation.address],
  );

  return {
    deployer,
    other,
    safeOwner,
    implementation,
    caller,
    factory,
    factoryDeployHash: deploymentTransaction.hash,
  };
}

/**
 * ERC1967 implementation slot:
 * keccak256('eip1967.proxy.implementation') - 1. Reading it is the only way to
 * see what a proxy actually delegates to, which is what `setImplementation`
 * exists to change; `latestImplementation` is the factory's own bookkeeping.
 */
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;

async function implementationOf(proxy: Hex): Promise<Hex> {
  const word = await publicClient.getStorageAt({ address: proxy, slot: IMPL_SLOT });
  assert.ok(word, `no storage at the implementation slot for ${proxy}`);
  return `0x${word.slice(-40)}`.toLowerCase() as Hex;
}

/** Lowercase the address values of an expected-args object, for the same reason. */
function lo(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.toLowerCase() : value,
    ]),
  );
}

const MODULE_CREATED = parseAbiItem(
  'event ModuleCreated(address indexed safe, address indexed moduleProxy, address implementation)',
);
const IMPLEMENTATION_DEPLOYED = parseAbiItem(
  'event ImplementationDeployed(address indexed implementation, uint256 version)',
);

/**
 * Decode every log of `item` emitted by `address` in `hash`'s receipt.
 * `logs.length > 0` is not the assertion: the ERC1967 proxy's own `Upgraded`
 * event satisfies it while `ModuleCreated` is missing.
 */
async function eventsFrom(
  hash: Hex,
  address: Hex,
  item: typeof MODULE_CREATED | typeof IMPLEMENTATION_DEPLOYED,
) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const topic0 = toEventSelector(item);
  return receipt.logs
    .filter((log) => log.address.toLowerCase() === address.toLowerCase() && log.topics[0] === topic0)
    .map((log) => {
      const decoded = decodeEventLog({ abi: [item], data: log.data, topics: log.topics });
      // Lowercase address args: the chain returns checksummed strings and these
      // tests are about identity, not EIP-55.
      const args = Object.fromEntries(
        Object.entries(decoded.args as Record<string, unknown>).map(([key, value]) => [
          key,
          typeof value === 'string' ? value.toLowerCase() : value,
        ]),
      );
      return { ...decoded, args };
    });
}

/** Call the factory as the protocol safe, through the forwarding fixture. */
async function asProtocolSafe(
  d: Awaited<ReturnType<typeof deploy>>,
  data: Hex,
): Promise<Hex> {
  const hash = await d.caller.write.exec([d.factory.address, data]);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

const CALL_ABI = parseAbi([
  'function setImplementation(address _implementation)',
  'function createModule(address safe, address[] _authors, address[] _devs)',
]);

const setImplData = (implementation: Hex) =>
  encodeFunctionData({
    abi: CALL_ABI,
    functionName: 'setImplementation',
    args: [implementation],
  });

const createModuleData = (safe: Hex, authors: Hex[], devs: Hex[]) =>
  encodeFunctionData({
    abi: CALL_ABI,
    functionName: 'createModule',
    args: [safe, authors, devs],
  });

describe('S2SPublicationModuleV3Factory — constructor', () => {
  it('refuses a zero protocol safe', async () => {
    const { implementation } = await deploy();
    await expectRevert(
      viem.deployContract('S2SPublicationModuleV3Factory', [zeroAddress, implementation.address]),
      enc.zeroAddress,
      'ZeroAddress',
    );
  });

  it('refuses a zero implementation', async () => {
    const { caller } = await deploy();
    await expectRevert(
      viem.deployContract('S2SPublicationModuleV3Factory', [caller.address, zeroAddress]),
      enc.zeroAddress,
      'ZeroAddress',
    );
  });

  it('refuses an EOA as the protocol safe', async () => {
    // An EOA "safe" turns one leaked key into a takeover of every future
    // publication, which is the V2 hole with extra steps.
    const { deployer, implementation } = await deploy();
    await expectRevert(
      viem.deployContract('S2SPublicationModuleV3Factory', [
        deployer.account.address,
        implementation.address,
      ]),
      enc.notAContract(deployer.account.address),
      'NotAContract',
    );
  });

  it('refuses an implementation without code', async () => {
    const { caller, other } = await deploy();
    await expectRevert(
      viem.deployContract('S2SPublicationModuleV3Factory', [
        caller.address,
        other.account.address,
      ]),
      enc.notAContract(other.account.address),
      'NotAContract',
    );
  });

  it('records the constructor implementation as version 1', async () => {
    const { caller, implementation, factory, factoryDeployHash } = await deploy();

    const deployed = await eventsFrom(factoryDeployHash, factory.address, IMPLEMENTATION_DEPLOYED);
    assert.equal(deployed.length, 1, 'constructor must emit ImplementationDeployed once');
    assert.equal(deployed[0]!.eventName, 'ImplementationDeployed');
    assert.deepEqual(deployed[0]!.args, lo({
      implementation: implementation.address,
      version: 1n,
    }));

    assert.equal((await factory.read.protocolSafe()).toLowerCase(), caller.address.toLowerCase());
    assert.equal(
      (await factory.read.latestImplementation()).toLowerCase(),
      implementation.address.toLowerCase(),
    );
    assert.equal(await factory.read.implementationCount(), 1n);
    assert.equal(
      (await factory.read.getImplementationByVersion([1n])).toLowerCase(),
      implementation.address.toLowerCase(),
    );
  });
});

describe('S2SPublicationModuleV3Factory — setImplementation', () => {
  it('reverts for a caller that is not the protocol safe', async () => {
    const { deployer, implementation, factory } = await deploy();
    await expectRevert(
      factory.write.setImplementation([implementation.address], {
        account: deployer.account,
      }),
      enc.onlyProtocolSafe(deployer.account.address),
      'OnlyProtocolSafe',
    );
  });

  it('reverts for a publication safe, which is not the protocol safe', async () => {
    // Being the safe a module belongs to is not authority over the factory.
    const { safeOwner, implementation, factory } = await deploy();
    await expectRevert(
      factory.write.setImplementation([implementation.address], {
        account: safeOwner.account,
      }),
      enc.onlyProtocolSafe(safeOwner.account.address),
      'OnlyProtocolSafe',
    );
  });

  it('accepts the protocol safe and appends a version', async () => {
    const d = await deploy();
    const next = await viem.deployContract('S2SPublicationModuleV3');

    const hash = await asProtocolSafe(d, setImplData(next.address));

    const announced = await eventsFrom(hash, d.factory.address, IMPLEMENTATION_DEPLOYED);
    assert.equal(announced.length, 1, 'setImplementation must emit ImplementationDeployed once');
    assert.deepEqual(announced[0]!.args, { implementation: next.address, version: 2n });

    assert.equal(
      (await d.factory.read.latestImplementation()).toLowerCase(),
      next.address.toLowerCase(),
    );
    assert.equal(await d.factory.read.implementationCount(), 2n);
    assert.equal(
      (await d.factory.read.getImplementationByVersion([2n])).toLowerCase(),
      next.address.toLowerCase(),
    );
    assert.equal(
      (await d.factory.read.getImplementationByVersion([1n])).toLowerCase(),
      d.implementation.address.toLowerCase(),
    );
  });

  it('keeps the protocol-safe checks on the implementation argument', async () => {
    const d = await deploy();
    await expectRevert(
      d.caller.write.exec([d.factory.address, setImplData(zeroAddress)]),
      enc.zeroAddress,
      'ZeroAddress',
    );
    await expectRevert(
      d.caller.write.exec([d.factory.address, setImplData(d.other.account.address)]),
      enc.notAContract(d.other.account.address),
      'NotAContract',
    );
  });
});

describe('S2SPublicationModuleV3Factory — createModule', () => {
  it('reverts for a third party naming another safe', async () => {
    // Without this gate anyone could mint a proxy initialised with a stranger's
    // safe and have it appear in that safe's module list.
    const { deployer, other, factory } = await deploy();
    await expectRevert(
      factory.write.createModule([other.account.address, [], []], { account: deployer.account }),
      enc.notSafeOrProtocolSafe(deployer.account.address, other.account.address),
      'NotSafeOrProtocolSafe',
    );
  });

  it('reverts for a third party calling createModuleEmpty', async () => {
    const { deployer, other, factory } = await deploy();
    await expectRevert(
      factory.write.createModuleEmpty([other.account.address], { account: deployer.account }),
      enc.notSafeOrProtocolSafe(deployer.account.address, other.account.address),
      'NotSafeOrProtocolSafe',
    );
  });

  it('reverts on a zero safe', async () => {
    const { deployer, factory } = await deploy();
    await expectRevert(
      factory.write.createModule([zeroAddress, [], []], { account: deployer.account }),
      enc.zeroAddress,
      'ZeroAddress',
    );
  });

  it('accepts the safe naming itself, and deploys a proxied module for it', async () => {
    const { deployer, implementation, factory } = await deploy();
    const safe = deployer.account.address;

    const hash = await factory.write.createModule([safe, [deployer.account.address], []], {
      account: deployer.account,
    });

    const modules = await factory.read.getModulesForSafe([safe]);
    assert.equal(modules.length, 1);

    const module = await viem.getContractAt('S2SPublicationModuleV3', modules[0]!);
    assert.equal((await module.read.safe()).toLowerCase(), safe.toLowerCase());
    assert.equal(await module.read.isWhitelistedAuthor([deployer.account.address]), true);
    assert.notEqual(await publicClient.getCode({ address: modules[0]! }), '0x');

    const created = await eventsFrom(hash, factory.address, MODULE_CREATED);
    assert.equal(created.length, 1, 'createModule must emit ModuleCreated once');
    assert.equal(created[0]!.eventName, 'ModuleCreated');
    assert.deepEqual(created[0]!.args, lo({
      safe,
      moduleProxy: modules[0]!,
      implementation: implementation.address,
    }));
  });

  it('accepts the protocol safe on the named safe\'s behalf', async () => {
    const d = await deploy();
    const safe = d.other.account.address;

    const hash = await asProtocolSafe(d, createModuleData(safe, [], []));

    const modules = await d.factory.read.getModulesForSafe([safe]);
    assert.equal(modules.length, 1);

    const module = await viem.getContractAt('S2SPublicationModuleV3', modules[0]!);
    assert.equal((await module.read.safe()).toLowerCase(), safe.toLowerCase());

    const created = await eventsFrom(hash, d.factory.address, MODULE_CREATED);
    assert.equal(created.length, 1);
    assert.deepEqual(created[0]!.args, lo({
      safe,
      moduleProxy: modules[0]!,
      implementation: d.implementation.address,
    }));
  });

  /**
   * `update-protocol.ts` refuses to write a factory that cannot answer
   * `protocolSafe()`. That probe only discriminates if V2 really lacks the
   * function, so assert both sides here rather than trusting the ABI listing.
   */
  it('answers protocolSafe(), which the superseded V2 factory cannot', async () => {
    const { caller, implementation, factory } = await deploy();

    assert.equal(
      (await factory.read.protocolSafe()).toLowerCase(),
      caller.address.toLowerCase(),
    );

    const v2 = await viem.deployContract('S2SPublicationModuleV2Factory', [
      implementation.address,
    ]);
    const probe = parseAbi(['function protocolSafe() view returns (address)']);

    let answered = false;
    try {
      await publicClient.readContract({
        address: v2.address,
        abi: probe,
        functionName: 'protocolSafe',
      });
      answered = true;
    } catch {
      answered = false;
    }
    assert.equal(answered, false, 'the V2 factory must not answer protocolSafe()');
  });

  /**
   * The point of `setImplementation`: a module created afterwards must delegate
   * to the new code. Read off the proxy's ERC1967 slot, which is what the EVM
   * dispatches through — `latestImplementation` alone would pass even if the
   * factory deployed `implementationHistory[0]`.
   */
  it('delegates to whichever implementation was current at creation time', async () => {
    const d = await deploy();
    const next = await viem.deployContract('S2SPublicationModuleV3');
    const safe = d.deployer.account.address;
    const before = d.implementation.address.toLowerCase();

    const firstHash = await d.factory.write.createModule([safe, [], []], {
      account: d.deployer.account,
    });
    const [first] = await d.factory.read.getModulesForSafe([safe]);
    assert.equal(await implementationOf(first!), before, 'module 1 must use version 1');

    const [firstLog] = await eventsFrom(firstHash, d.factory.address, MODULE_CREATED);
    assert.deepEqual(firstLog!.args, lo({
      safe,
      moduleProxy: first!,
      implementation: d.implementation.address,
    }));

    const setHash = await asProtocolSafe(d, setImplData(next.address));
    assert.equal(
      (await d.factory.read.latestImplementation()).toLowerCase(),
      next.address.toLowerCase(),
    );

    const secondHash = await d.factory.write.createModule([safe, [], []], {
      account: d.deployer.account,
    });
    const modules = await d.factory.read.getModulesForSafe([safe]);
    assert.equal(modules.length, 2, 'two separate modules for one safe');

    assert.equal(
      await implementationOf(modules[1]!),
      next.address.toLowerCase(),
      'module 2 must delegate to the implementation set after the first',
    );
    assert.equal(
      await implementationOf(modules[0]!),
      before,
      'an existing module must not be repointed by setImplementation',
    );

    const [secondLog] = await eventsFrom(secondHash, d.factory.address, MODULE_CREATED);
    assert.deepEqual(secondLog!.args, lo({
      safe,
      moduleProxy: modules[1]!,
      implementation: next.address,
    }));

    assert.equal(
      (await eventsFrom(setHash, d.factory.address, IMPLEMENTATION_DEPLOYED)).length,
      1,
      'setImplementation must announce the version it recorded',
    );
  });
});
