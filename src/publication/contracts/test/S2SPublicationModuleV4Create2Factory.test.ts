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
 * The one property this factory exists for: the module address is a function of
 * the safe, so it can be computed instead of found by scanning module names.
 *
 * Nothing here recomputes the CREATE2 hash in TypeScript. A reimplementation in
 * the test would agree with a wrong contract; the assertion is the contract's
 * own prediction against the proxy it actually deployed.
 *
 * The rest is what prediction must not break: the gate (a stranger cannot
 * predict somebody else's module into existence), the initializer still runs on
 * the fresh proxy, a repeat create is idempotent rather than a second module,
 * and a new implementation moves `moduleAddress` without moving the address a
 * publication was born at.
 *
 * Hardhat 3 + `node:test` + viem, same wiring as `S2SPublicationModuleV3Factory.test.ts`.
 * The protocol safe is `MockCaller`, because the constructor refuses an address
 * without code.
 */

const { viem } = await network.create();

const publicClient = await viem.getPublicClient();

type Hex = `0x${string}`;

const ERRORS = parseAbi([
  'error ZeroAddress()',
  'error NotAContract(address account)',
  'error ImplementationWithoutUpgradeGate(address implementation)',
  'error OnlyProtocolSafe(address caller)',
  'error NotSafeOrProtocolSafe(address caller, address safe)',
  'error InvalidVersion()',
]);

const enc = {
  zeroAddress: encodeErrorResult({ abi: ERRORS, errorName: 'ZeroAddress' }),
  notAContract: (account: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'NotAContract', args: [account] }),
  withoutUpgradeGate: (implementation: Hex) =>
    encodeErrorResult({
      abi: ERRORS,
      errorName: 'ImplementationWithoutUpgradeGate',
      args: [implementation],
    }),
  onlyProtocolSafe: (caller: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'OnlyProtocolSafe', args: [caller] }),
  notSafeOrProtocolSafe: (caller: Hex, safe: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'NotSafeOrProtocolSafe', args: [caller, safe] }),
  invalidVersion: encodeErrorResult({ abi: ERRORS, errorName: 'InvalidVersion' }),
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
 * implementation → caller (a contract, holding the protocol-safe role) → factory.
 * The implementation is the real V4 module: the proxy is deployed empty and
 * initialised by a second call, so a stub would prove nothing about either half.
 */
async function deploy() {
  const [deployer, other, safeOwner] = await viem.getWalletClients();

  const implementation = await viem.deployContract('S2SPublicationModuleV4');
  const caller = await viem.deployContract('MockCaller');
  const factory = await viem.deployContract('S2SPublicationModuleV4Create2Factory', [
    caller.address,
    implementation.address,
  ]);

  return { deployer, other, safeOwner, implementation, caller, factory };
}

const MODULE_CREATED = parseAbiItem(
  'event ModuleCreated(address indexed safe, address indexed moduleProxy, address implementation)',
);

/** Decode every `ModuleCreated` this factory emitted in `hash`'s receipt. */
async function createdEvents(factory: Hex, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const topic0 = toEventSelector(MODULE_CREATED);
  return receipt.logs
    .filter((log) => log.address.toLowerCase() === factory.toLowerCase() && log.topics[0] === topic0)
    .map(
      (log) =>
        decodeEventLog({ abi: [MODULE_CREATED], data: log.data, topics: log.topics }).args,
    );
}

/** Call the factory as the protocol safe, through the forwarding fixture. */
async function asProtocolSafe(d: Awaited<ReturnType<typeof deploy>>, data: Hex): Promise<Hex> {
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

describe('S2SPublicationModuleV4Create2Factory — prediction', () => {
  it('the predicted address is the deployed module for createModule', async () => {
    const d = await deploy();
    const safe = d.deployer.account.address;

    const predicted = await d.factory.read.moduleAddress([safe]);
    const hash = await d.factory.write.createModule(
      [safe, [d.deployer.account.address], []],
      { account: d.deployer.account },
    );

    const modules = await d.factory.read.getModulesForSafe([safe]);
    assert.equal(modules.length, 1);
    assert.equal(modules[0]!.toLowerCase(), predicted.toLowerCase());

    const [created] = await createdEvents(d.factory.address, hash);
    assert.equal(created!.moduleProxy!.toLowerCase(), predicted.toLowerCase());
    assert.notEqual(await publicClient.getCode({ address: modules[0]! }), '0x');
  });

  it('the predicted address is the deployed module for createModuleEmpty', async () => {
    const d = await deploy();
    const safe = d.other.account.address;

    const predicted = await d.factory.read.moduleAddress([safe]);
    const hash = await d.factory.write.createModuleEmpty([safe], { account: d.other.account });

    const modules = await d.factory.read.getModulesForSafe([safe]);
    assert.equal(modules.length, 1);
    assert.equal(modules[0]!.toLowerCase(), predicted.toLowerCase());
    assert.equal(
      (await createdEvents(d.factory.address, hash))[0]!.moduleProxy!.toLowerCase(),
      predicted.toLowerCase(),
    );
  });

  it('both entry points predict the same address for one safe', async () => {
    // The init code carries no argument lists, so the prediction cannot depend
    // on the empty-versus-populated distinction.
    const d = await deploy();
    const safe = d.other.account.address;
    const predicted = await d.factory.read.moduleAddress([safe]);

    await d.factory.write.createModuleEmpty([safe], { account: d.other.account });

    const modules = await d.factory.read.getModulesForSafe([safe]);
    assert.equal(modules[0]!.toLowerCase(), predicted.toLowerCase());
  });

  it('runs initialize on the proxy, so the author list lands on the module', async () => {
    const d = await deploy();
    const safe = d.deployer.account.address;
    const predicted = await d.factory.read.moduleAddress([safe]);

    const hash = await d.factory.write.createModule(
      [safe, [d.deployer.account.address, d.other.account.address], [d.other.account.address]],
      { account: d.deployer.account },
    );
    await publicClient.waitForTransactionReceipt({ hash });

    const module = await viem.getContractAt('S2SPublicationModuleV4', predicted);
    assert.equal((await module.read.safe()).toLowerCase(), safe.toLowerCase());
    assert.equal(await module.read.isWhitelistedAuthor([d.deployer.account.address]), true);
    assert.equal(await module.read.isWhitelistedAuthor([d.other.account.address]), true);
    assert.equal(await module.read.isWhitelistedDev([d.other.account.address]), true);
  });
});

describe('S2SPublicationModuleV4Create2Factory — idempotent create', () => {
  it('a second create returns the recorded module and emits no second ModuleCreated', async () => {
    const d = await deploy();
    const safe = d.deployer.account.address;

    await d.factory.write.createModuleEmpty([safe], { account: d.deployer.account });
    const [first] = await d.factory.read.getModulesForSafe([safe]);

    // The second call would revert on a second `initialize`; the factory must
    // return the recorded proxy instead of deploying. `simulate` answers
    // `{ result, request }`, not the bare return value.
    const { result } = await d.factory.simulate.createModule([safe, [], []], {
      account: d.deployer.account,
    });
    assert.equal((result as Hex).toLowerCase(), first!.toLowerCase());

    const hash = await d.factory.write.createModuleEmpty([safe], { account: d.deployer.account });
    const modules = await d.factory.read.getModulesForSafe([safe]);
    assert.equal(modules.length, 1, 'one safe, one module');
    assert.equal(modules[0]!.toLowerCase(), first!.toLowerCase());
    assert.equal(
      (await createdEvents(d.factory.address, hash)).length,
      0,
      'an idempotent create must not announce a module it did not deploy',
    );
  });

  it('ignores the lists of a repeat call rather than re-initialising', async () => {
    const d = await deploy();
    const safe = d.deployer.account.address;

    await d.factory.write.createModuleEmpty([safe], { account: d.deployer.account });
    const [module] = await d.factory.read.getModulesForSafe([safe]);

    await d.factory.write.createModule([safe, [d.other.account.address], []], {
      account: d.deployer.account,
    });

    const deployed = await viem.getContractAt('S2SPublicationModuleV4', module!);
    assert.equal(await deployed.read.isWhitelistedAuthor([d.other.account.address]), false);
  });

  it('reverts for a stranger naming somebody else\'s safe', async () => {
    const d = await deploy();
    const safe = d.other.account.address;

    await expectRevert(
      d.factory.write.createModule([safe, [], []], { account: d.deployer.account }),
      enc.notSafeOrProtocolSafe(d.deployer.account.address, safe),
      'NotSafeOrProtocolSafe',
    );
    assert.equal((await d.factory.read.getModulesForSafe([safe])).length, 0);
  });

  it('reverts for a stranger calling createModuleEmpty', async () => {
    const d = await deploy();
    const safe = d.other.account.address;

    await expectRevert(
      d.factory.write.createModuleEmpty([safe], { account: d.deployer.account }),
      enc.notSafeOrProtocolSafe(d.deployer.account.address, safe),
      'NotSafeOrProtocolSafe',
    );
  });

  it('reverts on a zero safe', async () => {
    const d = await deploy();
    await expectRevert(
      d.factory.write.createModuleEmpty([zeroAddress], { account: d.deployer.account }),
      enc.zeroAddress,
      'ZeroAddress',
    );
  });

  /**
   * The gate is checked before the idempotent return: a stranger naming a safe
   * that already has a module must revert, not be handed the module. Move the
   * `safeModules` check above the gate and this test fails, which is the point.
   */
  it('reverts for a stranger naming a safe that already has a module', async () => {
    const d = await deploy();
    const safe = d.deployer.account.address;

    await d.factory.write.createModuleEmpty([safe], { account: d.deployer.account });
    const [existing] = await d.factory.read.getModulesForSafe([safe]);

    await expectRevert(
      d.factory.write.createModule([safe, [], []], { account: d.other.account }),
      enc.notSafeOrProtocolSafe(d.other.account.address, safe),
      'NotSafeOrProtocolSafe',
    );
    await expectRevert(
      d.factory.write.createModuleEmpty([safe], { account: d.other.account }),
      enc.notSafeOrProtocolSafe(d.other.account.address, safe),
      'NotSafeOrProtocolSafe',
    );

    const modules = await d.factory.read.getModulesForSafe([safe]);
    assert.equal(modules.length, 1);
    assert.equal(modules[0]!.toLowerCase(), existing!.toLowerCase());
  });
});

describe('S2SPublicationModuleV4Create2Factory — constructor and access', () => {
  it('refuses a zero protocol safe', async () => {
    const { implementation } = await deploy();
    await expectRevert(
      viem.deployContract('S2SPublicationModuleV4Create2Factory', [
        zeroAddress,
        implementation.address,
      ]),
      enc.zeroAddress,
      'ZeroAddress',
    );
  });

  it('refuses a protocol safe without code', async () => {
    // An EOA "safe" turns one leaked key into a takeover of every future
    // publication, which is the V2 hole with extra steps.
    const { deployer, implementation } = await deploy();
    await expectRevert(
      viem.deployContract('S2SPublicationModuleV4Create2Factory', [
        deployer.account.address,
        implementation.address,
      ]),
      enc.notAContract(deployer.account.address),
      'NotAContract',
    );
  });

  it('refuses a zero implementation', async () => {
    const { caller } = await deploy();
    await expectRevert(
      viem.deployContract('S2SPublicationModuleV4Create2Factory', [caller.address, zeroAddress]),
      enc.zeroAddress,
      'ZeroAddress',
    );
  });

  it('refuses an implementation without code', async () => {
    const { caller, other } = await deploy();
    await expectRevert(
      viem.deployContract('S2SPublicationModuleV4Create2Factory', [
        caller.address,
        other.account.address,
      ]),
      enc.notAContract(other.account.address),
      'NotAContract',
    );
  });

  it('refuses an implementation that carries no upgrade gate', async () => {
    const { caller } = await deploy();
    // V3's `_authorizeUpgrade` is the publication-safe check alone. Approving it
    // would let a module upgrade into code that ignores this factory for good.
    const v3 = await viem.deployContract('S2SPublicationModuleV3');
    await expectRevert(
      viem.deployContract('S2SPublicationModuleV4Create2Factory', [
        caller.address,
        v3.address,
      ]),
      enc.withoutUpgradeGate(v3.address),
      'ImplementationWithoutUpgradeGate',
    );
  });

  it('refuses setImplementation of an implementation that carries no upgrade gate', async () => {
    const d = await deploy();
    const v3 = await viem.deployContract('S2SPublicationModuleV3');
    await expectRevert(
      d.caller.write.exec([d.factory.address, setImplData(v3.address)]),
      enc.withoutUpgradeGate(v3.address),
      'ImplementationWithoutUpgradeGate',
    );
    assert.equal(
      await d.factory.read.isApprovedImplementation([v3.address]),
      false,
      'a refused implementation must not be approved',
    );
  });

  it('refuses setImplementation from a caller that is not the protocol safe', async () => {
    const d = await deploy();
    await expectRevert(
      d.factory.write.setImplementation([d.implementation.address], {
        account: d.deployer.account,
      }),
      enc.onlyProtocolSafe(d.deployer.account.address),
      'OnlyProtocolSafe',
    );
  });
});

describe('S2SPublicationModuleV4Create2Factory — versions', () => {
  it('setImplementation moves moduleAddress for a safe with no module only', async () => {
    const d = await deploy();
    const fresh = d.other.account.address;

    const before = await d.factory.read.moduleAddress([fresh]);
    assert.equal(
      (await d.factory.read.moduleAddressForVersion([fresh, 1n])).toLowerCase(),
      before.toLowerCase(),
    );

    const next = await viem.deployContract('S2SPublicationModuleV4');
    await asProtocolSafe(d, setImplData(next.address));

    const after = await d.factory.read.moduleAddress([fresh]);
    assert.notEqual(after.toLowerCase(), before.toLowerCase(), 'the prediction must move');
    assert.equal(
      (await d.factory.read.moduleAddressForVersion([fresh, 1n])).toLowerCase(),
      before.toLowerCase(),
      'version 1 must still answer where the first implementation deploys',
    );
    assert.equal(
      (await d.factory.read.moduleAddressForVersion([fresh, 2n])).toLowerCase(),
      after.toLowerCase(),
      'version 2 must answer where the current implementation deploys',
    );
  });

  /**
   * `moduleAddress` is the address `createModule` returns right now, so a module
   * created before `setImplementation` stays the answer. The prediction that
   * moved is a different question, and only `moduleAddressForVersion` asks it.
   */
  it('a safe created before setImplementation keeps its own module address', async () => {
    const d = await deploy();
    const safe = d.deployer.account.address;

    const born = await d.factory.read.moduleAddress([safe]);
    await d.factory.write.createModuleEmpty([safe], { account: d.deployer.account });
    const [module] = await d.factory.read.getModulesForSafe([safe]);
    assert.equal(module!.toLowerCase(), born.toLowerCase());

    const next = await viem.deployContract('S2SPublicationModuleV4');
    await asProtocolSafe(d, setImplData(next.address));

    assert.equal(
      (await d.factory.read.moduleAddress([safe])).toLowerCase(),
      born.toLowerCase(),
      'moduleAddress follows the module that exists, not the new prediction',
    );

    const nextGeneration = await d.factory.read.moduleAddressForVersion([safe, 2n]);
    assert.notEqual(nextGeneration.toLowerCase(), born.toLowerCase());
    assert.equal(
      (await d.factory.read.moduleAddressForVersion([safe, 1n])).toLowerCase(),
      born.toLowerCase(),
      'version 1 answers where this module was deployed',
    );
  });

  it('reverts InvalidVersion for version 0 and for count + 1', async () => {
    const d = await deploy();
    const safe = d.deployer.account.address;
    const count = await d.factory.read.implementationCount();

    await expectRevert(
      d.factory.read.moduleAddressForVersion([safe, 0n]),
      enc.invalidVersion,
      'InvalidVersion',
    );
    await expectRevert(
      d.factory.read.moduleAddressForVersion([safe, count + 1n]),
      enc.invalidVersion,
      'InvalidVersion',
    );
    await expectRevert(
      d.factory.read.getImplementationByVersion([0n]),
      enc.invalidVersion,
      'InvalidVersion',
    );
    await expectRevert(
      d.factory.read.getImplementationByVersion([count + 1n]),
      enc.invalidVersion,
      'InvalidVersion',
    );
    // The last valid version answers, so the bound is exclusive, not off by one.
    await d.factory.read.moduleAddressForVersion([safe, count]);
    await d.factory.read.getImplementationByVersion([count]);
  });
});
