import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import {
  encodeErrorResult,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  parseAbi,
  toHex,
} from 'viem';
import { Artifact_S2SModuleProxy } from '@s2s/publication-contracts/artifacts/S2SModuleProxy';

/**
 * What the factory has to be true of, in its own terms:
 *
 *   - a module address is a function of (factory, safe, kind) alone, so setting
 *     a new implementation moves nothing and a client computes the address
 *     offline instead of asking the module what it is,
 *   - provenance and initialisation cannot disagree: the Safe the factory
 *     records is the Safe it initialises the module with,
 *   - kinds do not mix: an implementation is approved per kind, and a module's
 *     gate asks about its own kind, so one kind cannot be handed another's code,
 *   - one module per (safe, kind), so a repeated create cannot mint a second,
 *   - an approved build can be withdrawn, after which nothing moves onto it.
 *
 * The protocol safe is `MockCaller`: the constructor refuses an address without
 * code.
 */

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();

type Hex = `0x${string}`;

const KIND_A: Hex = keccak256(toHex('s2s.publication.module'));
const KIND_B: Hex = keccak256(toHex('s2s.module.records'));
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ERRORS = parseAbi([
  'error ZeroAddress()',
  'error NotAContract(address account)',
  'error OnlyProtocolSafe(address caller)',
  'error NotSafeOrProtocolSafe(address caller, address safe)',
  'error NoImplementation(bytes32 kind)',
  'error ImplementationNotGated(address implementation, address gate)',
  'error ImplementationKindMismatch(address implementation, bytes32 kind, bytes32 declared)',
  'error NotUUPS(address implementation)',
  'error ImplementationRevoked(address implementation)',
  'error NotApproved(address implementation)',
  'error InitializerFailed(address module, bytes reason)',
  'error InvalidVersion()',
]);

const enc = {
  onlyProtocolSafe: (caller: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'OnlyProtocolSafe', args: [caller] }),
  noImplementation: (kind: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'NoImplementation', args: [kind] }),
  notSafeOrProtocolSafe: (caller: Hex, safe: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'NotSafeOrProtocolSafe', args: [caller, safe] }),
  notGated: (implementation: Hex, gate: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'ImplementationNotGated', args: [implementation, gate] }),
  notUUPS: (implementation: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'NotUUPS', args: [implementation] }),
  kindMismatch: (implementation: Hex, kind: Hex, declared: Hex) =>
    encodeErrorResult({
      abi: ERRORS,
      errorName: 'ImplementationKindMismatch',
      args: [implementation, kind, declared],
    }),
  revoked: (implementation: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'ImplementationRevoked', args: [implementation] }),
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

async function expectRevert(call: Promise<unknown>, data: Hex | string, name: string) {
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
    `expected ${name} (${String(data)}), got:\n${text.slice(0, 700)}`,
  );
}

const CREATE_ABI = parseAbi([
  'function createModule(address safe, bytes32 kind, bytes params) returns (address module, bool created)',
]);
const SET_ABI = parseAbi(['function setImplementation(bytes32 kind, address implementation)']);
const REVOKE_ABI = parseAbi(['function revokeImplementation(bytes32 kind, address implementation)']);

function createData(safe: Hex, kind: Hex, params: Hex = '0x'): Hex {
  return encodeFunctionData({ abi: CREATE_ABI, functionName: 'createModule', args: [safe, kind, params] });
}

function setImplData(kind: Hex, implementation: Hex): Hex {
  return encodeFunctionData({ abi: SET_ABI, functionName: 'setImplementation', args: [kind, implementation] });
}

function revokeData(kind: Hex, implementation: Hex): Hex {
  return encodeFunctionData({ abi: REVOKE_ABI, functionName: 'revokeImplementation', args: [kind, implementation] });
}

const upgradeData = (target: Hex): Hex =>
  encodeFunctionData({ abi: parseAbi(['function upgrade(address target)']), functionName: 'upgrade', args: [target] });

const initializeData = (safe: Hex, params: Hex = '0x'): Hex =>
  encodeFunctionData({
    abi: parseAbi(['function initialize(address safe, bytes params)']),
    functionName: 'initialize',
    args: [safe, params],
  });

/** The ERC-1967 implementation slot of a proxy, read from state. */
async function implementationAt(address: Hex): Promise<string> {
  const slot = await publicClient.request({
    method: 'eth_getStorageAt',
    params: [address, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest'],
  } as any);
  return `0x${String(slot).slice(-40)}`.toLowerCase();
}

async function deploy() {
  const protocolSafe = await viem.deployContract('MockCaller');
  const factory = await viem.deployContract('S2SPublicationModulesFactoryV6', [protocolSafe.address]);
  const safe = await viem.deployContract('MockCaller');
  const otherSafe = await viem.deployContract('MockCaller');
  return { protocolSafe, factory, safe, otherSafe };
}

async function mock(factory: Hex, kind: Hex) {
  return viem.deployContract('MockGatedModule', [factory, kind]);
}

/** Set an implementation through the protocol safe, as the Safe would. */
async function setImplementation(
  factory: { address: Hex },
  protocolSafe: { write: { exec: (args: [Hex, Hex]) => Promise<unknown> } },
  kind: Hex,
  implementation: Hex,
) {
  await protocolSafe.write.exec([factory.address, setImplData(kind, implementation)]);
}

describe('S2SPublicationModulesFactoryV6', () => {
  it('refuses a protocol safe without code, and creates nothing before an implementation is set', async () => {
    const { factory, safe } = await deploy();

    await assert.rejects(
      viem.deployContract('S2SPublicationModulesFactoryV6', ['0x0000000000000000000000000000000000000001']),
      /revert/i,
    );

    assert.equal(await factory.read.latestImplementation([KIND_A]), ZERO_ADDRESS);
    assert.equal(
      await factory.read.moduleAddress([safe.address, KIND_A]),
      ZERO_ADDRESS,
      'no implementation means no address a create would use, so none is offered',
    );

    await expectRevert(
      safe.write.exec([factory.address, createData(safe.address, KIND_A)]),
      enc.noImplementation(KIND_A),
      'NoImplementation',
    );
  });

  it('accepts only an implementation that names this factory and declares the kind it is set for', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const good = await mock(factory.address, KIND_A);

    const [stranger] = await viem.getWalletClients();
    await expectRevert(
      factory.write.setImplementation([KIND_A, good.address], { account: stranger.account }),
      enc.onlyProtocolSafe(stranger.account.address.toLowerCase() as Hex),
      'OnlyProtocolSafe',
    );

    // Another factory's implementation: its gate reads a set this factory does
    // not keep, so letting it in would put an address here that cannot be
    // judged by this factory's approvals.
    const elsewhere = await deploy();
    const foreign = await mock(elsewhere.factory.address, KIND_A);
    await expectRevert(
      protocolSafe.write.exec([factory.address, setImplData(KIND_A, foreign.address)]),
      enc.notGated(foreign.address, elsewhere.factory.address),
      'ImplementationNotGated',
    );

    // A module with no upgrade door: it names this factory and its kind, but a
    // module that moved to it could never move again.
    const frozen = await viem.deployContract('MockFrozenModule', [factory.address, KIND_A]);
    await expectRevert(
      protocolSafe.write.exec([factory.address, setImplData(KIND_A, frozen.address)]),
      enc.notUUPS(frozen.address),
      'NotUUPS',
    );

    // A mock that names this factory but declares kind B, set for kind A: the
    // proxy would run kind B's storage layout behind kind A's address.
    const wrongKind = await mock(factory.address, KIND_B);
    await expectRevert(
      protocolSafe.write.exec([factory.address, setImplData(KIND_A, wrongKind.address)]),
      enc.kindMismatch(wrongKind.address, KIND_A, KIND_B),
      'ImplementationKindMismatch',
    );

    assert.equal(await factory.read.latestImplementation([KIND_A]), ZERO_ADDRESS);

    await setImplementation(factory, protocolSafe, KIND_A, good.address);
    assert.equal((await factory.read.latestImplementation([KIND_A])).toLowerCase(), good.address.toLowerCase());
    assert.equal(await factory.read.isApproved([KIND_A, good.address]), true);
    assert.equal(await factory.read.isApproved([KIND_B, good.address]), false, 'approval is per kind');
    assert.equal(await factory.read.implementationCount([KIND_A]), 1n);
    assert.equal(await factory.read.versionOf([KIND_A, good.address]), 1n);
    assert.notEqual(safe.address, good.address);
  });

  it('keeps the module address fixed across implementations, and the client can compute it', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const first = await mock(factory.address, KIND_A);
    const second = await mock(factory.address, KIND_A);

    await setImplementation(factory, protocolSafe, KIND_A, first.address);
    const before = await factory.read.moduleAddress([safe.address, KIND_A]);

    await setImplementation(factory, protocolSafe, KIND_A, second.address);
    const after = await factory.read.moduleAddress([safe.address, KIND_A]);

    assert.equal(after, before, 'a new implementation must not move an address');
    assert.equal((await factory.read.latestImplementation([KIND_A])).toLowerCase(), second.address.toLowerCase());

    // The formula the client uses: constant init code, salt from (kind, safe).
    const initCodeHash = keccak256(Artifact_S2SModuleProxy.bytecode as Hex);
    assert.equal(await factory.read.proxyInitCodeHash(), initCodeHash);
    const offline = getContractAddress({
      opcode: 'CREATE2',
      from: factory.address,
      salt: keccak256(
        // abi.encode(bytes32 kind, address safe) is two 32-byte words.
        `0x${KIND_A.slice(2)}${safe.address.slice(2).toLowerCase().padStart(64, '0')}` as Hex,
      ),
      bytecode: Artifact_S2SModuleProxy.bytecode as Hex,
    });
    assert.equal(offline, before, 'the factory and the client agree before anything is created');

    const params = '0x1234abcd' as Hex;
    await safe.write.exec([factory.address, createData(safe.address, KIND_A, params)]);
    const created = await factory.read.moduleOf([safe.address, KIND_A]);
    assert.equal(created, offline, 'the module landed at the computed address');
    assert.ok((await publicClient.getCode({ address: created })) !== '0x');

    const record = await factory.read.recordOf([created]);
    assert.equal(record[0].toLowerCase(), safe.address.toLowerCase(), 'provenance names the safe');
    assert.equal(record[1], KIND_A, 'provenance names the kind');

    const module = await viem.getContractAt('MockGatedModule', created);
    assert.equal((await module.read.safe()).toLowerCase(), safe.address.toLowerCase(), 'initialised in the same call');
    assert.equal(await module.read.paramsHash(), keccak256(params), 'params reached the initializer');
    assert.equal((await module.read.factory()).toLowerCase(), factory.address.toLowerCase());
  });

  it('initialises with the safe it recorded, and leaves nothing uninitialised for a first caller', async () => {
    const { protocolSafe, factory, safe, otherSafe } = await deploy();
    const a = await mock(factory.address, KIND_A);
    await setImplementation(factory, protocolSafe, KIND_A, a.address);

    // Params that name a different publication: the module still answers to the
    // safe in its record, because the factory supplies that argument.
    const misleading = initializeData(otherSafe.address);
    await safe.write.exec([factory.address, createData(safe.address, KIND_A, misleading)]);
    const moduleAddress = await factory.read.moduleOf([safe.address, KIND_A]);
    const module = await viem.getContractAt('MockGatedModule', moduleAddress);
    assert.equal((await module.read.safe()).toLowerCase(), safe.address.toLowerCase());

    // A module is created initialised, so there is no window in which someone
    // else can take it, and the initializer refuses a caller that is not the
    // factory even after the fact.
    await expectRevert(otherSafe.write.exec([moduleAddress, initializeData(otherSafe.address)]), '0x', 'OnlyFactory');

    // The bootstrap word is transient: nothing is left behind after the create.
    assert.equal(await factory.read.bootstrapImplementation(), ZERO_ADDRESS);
  });

  it('returns the existing module and does not reapply params when a create repeats', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const a = await mock(factory.address, KIND_A);
    await setImplementation(factory, protocolSafe, KIND_A, a.address);

    const firstParams = '0xaaaa' as Hex;
    const { result: firstResult } = await factory.simulate.createModule([safe.address, KIND_A, firstParams], {
      account: safe.address,
    });
    const [predicted, willCreate] = firstResult;
    assert.equal(willCreate, true);

    await safe.write.exec([factory.address, createData(safe.address, KIND_A, firstParams)]);
    assert.equal(await factory.read.moduleOf([safe.address, KIND_A]), predicted);

    // A second create with different params: same module, created = false, and
    // the module keeps the params it was built with.
    const { result: secondResult } = await factory.simulate.createModule([safe.address, KIND_A, '0xbbbb' as Hex], {
      account: safe.address,
    });
    const [again, createdAgain] = secondResult;
    assert.equal(again, predicted);
    assert.equal(createdAgain, false);

    await safe.write.exec([factory.address, createData(safe.address, KIND_A, '0xbbbb' as Hex)]);
    const module = await viem.getContractAt('MockGatedModule', predicted);
    assert.equal(await module.read.paramsHash(), keccak256(firstParams), 'a repeat create applies no new params');
  });

  it('rolls back to an earlier implementation without growing history or moving the address', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const first = await mock(factory.address, KIND_A);
    const second = await mock(factory.address, KIND_A);

    await setImplementation(factory, protocolSafe, KIND_A, first.address);
    const addressBefore = await factory.read.moduleAddress([safe.address, KIND_A]);
    await setImplementation(factory, protocolSafe, KIND_A, second.address);
    assert.equal(await factory.read.implementationCount([KIND_A]), 2n);

    await setImplementation(factory, protocolSafe, KIND_A, first.address);

    assert.equal((await factory.read.latestImplementation([KIND_A])).toLowerCase(), first.address.toLowerCase());
    assert.equal(await factory.read.implementationCount([KIND_A]), 2n, 'a rollback must not append a third entry');
    assert.equal(await factory.read.isApproved([KIND_A, second.address]), true, 'the build rolled back from stays legal');
    assert.equal(await factory.read.versionOf([KIND_A, first.address]), 1n, 'the version is the position, not the length');
    assert.equal(await factory.read.versionOf([KIND_A, second.address]), 2n);
    assert.equal(await factory.read.moduleAddress([safe.address, KIND_A]), addressBefore);

    await safe.write.exec([factory.address, createData(safe.address, KIND_A)]);
    const created = await factory.read.moduleOf([safe.address, KIND_A]);
    assert.equal(
      await implementationAt(created),
      first.address.toLowerCase(),
      'the proxy points at the implementation the rollback selected',
    );
  });

  it('withdraws an implementation for good, and moves the pointer off it', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const first = await mock(factory.address, KIND_A);
    const second = await mock(factory.address, KIND_A);
    await setImplementation(factory, protocolSafe, KIND_A, first.address);
    await setImplementation(factory, protocolSafe, KIND_A, second.address);

    // A module built while `second` is newest, so a withdrawal has a module to
    // leave running it.
    await safe.write.exec([factory.address, createData(safe.address, KIND_A)]);
    const moduleAddress = await factory.read.moduleOf([safe.address, KIND_A]);
    assert.equal(await implementationAt(moduleAddress), second.address.toLowerCase());
    const module = await viem.getContractAt('MockGatedModule', moduleAddress);

    await protocolSafe.write.exec([factory.address, revokeData(KIND_A, second.address)]);

    assert.equal(await factory.read.isApproved([KIND_A, second.address]), false);
    assert.equal(await factory.read.isRevoked([KIND_A, second.address]), true);
    assert.equal(
      (await factory.read.latestImplementation([KIND_A])).toLowerCase(),
      first.address.toLowerCase(),
      'the pointer moves to the newest approved implementation',
    );

    // A module cannot move onto a withdrawn build.
    await expectRevert(safe.write.exec([moduleAddress, upgradeData(second.address)]), '0x' as Hex, 'NotApproved');
    assert.equal(await implementationAt(moduleAddress), second.address.toLowerCase(), 'the refused upgrade wrote nothing');

    // A withdrawn build cannot be re-admitted, and its version stays on record.
    await expectRevert(
      protocolSafe.write.exec([factory.address, setImplData(KIND_A, second.address)]),
      enc.revoked(second.address),
      'ImplementationRevoked',
    );
    assert.equal(await factory.read.versionOf([KIND_A, second.address]), 2n);
    assert.equal(await factory.read.implementationCount([KIND_A]), 2n);
  });

  it('gives one safe one module per kind, at two addresses', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const a = await mock(factory.address, KIND_A);
    const b = await mock(factory.address, KIND_B);
    await setImplementation(factory, protocolSafe, KIND_A, a.address);
    await setImplementation(factory, protocolSafe, KIND_B, b.address);

    const predictedA = await factory.read.moduleAddress([safe.address, KIND_A]);
    const predictedB = await factory.read.moduleAddress([safe.address, KIND_B]);
    assert.notEqual(predictedA, predictedB, 'the kind is part of the salt');

    await safe.write.exec([factory.address, createData(safe.address, KIND_A)]);
    await safe.write.exec([factory.address, createData(safe.address, KIND_B)]);

    const moduleA = await factory.read.moduleOf([safe.address, KIND_A]);
    const moduleB = await factory.read.moduleOf([safe.address, KIND_B]);
    assert.equal(moduleA, predictedA);
    assert.equal(moduleB, predictedB);
    assert.notEqual(moduleA, moduleB);
    assert.equal((await factory.read.recordOf([moduleB]))[1], KIND_B);
  });

  it('refuses a create from anyone but the safe or the protocol safe', async () => {
    const { protocolSafe, factory, safe, otherSafe } = await deploy();
    const a = await mock(factory.address, KIND_A);
    await setImplementation(factory, protocolSafe, KIND_A, a.address);

    await expectRevert(
      otherSafe.write.exec([factory.address, createData(safe.address, KIND_A)]),
      enc.notSafeOrProtocolSafe(otherSafe.address, safe.address),
      'NotSafeOrProtocolSafe',
    );

    // The protocol safe may create on a publication's behalf.
    await protocolSafe.write.exec([factory.address, createData(safe.address, KIND_A)]);
    assert.notEqual(await factory.read.moduleOf([safe.address, KIND_A]), ZERO_ADDRESS);
  });

  it('rejects a cross-kind upgrade, because a module asks about its own kind', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const a = await mock(factory.address, KIND_A);
    const a2 = await mock(factory.address, KIND_A);
    const b = await mock(factory.address, KIND_B);
    await setImplementation(factory, protocolSafe, KIND_A, a.address);
    await setImplementation(factory, protocolSafe, KIND_B, b.address);

    await safe.write.exec([factory.address, createData(safe.address, KIND_A)]);
    const moduleAddress = await factory.read.moduleOf([safe.address, KIND_A]);
    const module = await viem.getContractAt('MockGatedModule', moduleAddress);
    assert.equal(await implementationAt(moduleAddress), a.address.toLowerCase());

    // `a2` arrives after the module exists, as a release would.
    await setImplementation(factory, protocolSafe, KIND_A, a2.address);

    await safe.write.exec([
      moduleAddress,
      encodeFunctionData({ abi: parseAbi(['function bump()']), functionName: 'bump' }),
    ]);
    assert.equal(await module.read.counter(), 1n);

    // Kind B's implementation is approved, but not for kind A.
    await expectRevert(safe.write.exec([moduleAddress, upgradeData(b.address)]), '0x' as Hex, 'NotApproved');
    assert.equal(await implementationAt(moduleAddress), a.address.toLowerCase(), 'the refused upgrade wrote nothing');

    // The same kind's newest implementation is a legal target, and storage
    // survives it: the address did not change.
    await safe.write.exec([moduleAddress, upgradeData(a2.address)]);
    assert.equal(await implementationAt(moduleAddress), a2.address.toLowerCase());
    assert.equal(await factory.read.moduleOf([safe.address, KIND_A]), moduleAddress, 'an upgrade moves no address');
    assert.equal(await module.read.counter(), 1001n, 'storage survived the upgrade');
  });

  it('reports provenance only for its own deployments', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const a = await mock(factory.address, KIND_A);
    await setImplementation(factory, protocolSafe, KIND_A, a.address);
    await safe.write.exec([factory.address, createData(safe.address, KIND_A)]);
    const moduleAddress = await factory.read.moduleOf([safe.address, KIND_A]);

    const [recordedSafe, recordedKind] = await factory.read.recordOf([moduleAddress]);
    assert.equal(recordedSafe.toLowerCase(), safe.address.toLowerCase());
    assert.equal(recordedKind, KIND_A);

    // An implementation is a contract with code, but it is not a module this
    // factory deployed for anyone.
    const [foreignSafe, foreignKind] = await factory.read.recordOf([a.address]);
    assert.equal(foreignSafe, ZERO_ADDRESS);
    assert.equal(foreignKind, `0x${'0'.repeat(64)}`);
    assert.equal(await factory.read.implementationVersion([KIND_B, a.address]), 0n);
    await assert.rejects(factory.read.getImplementationByVersion([KIND_A, 0n]), /InvalidVersion/);
  });
});
