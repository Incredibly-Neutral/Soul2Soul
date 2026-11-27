import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import {
  encodeErrorResult,
  encodeFunctionData,
  getAddress,
  keccak256,
  zeroAddress,
} from 'viem';

/**
 * Registry suite: `S2SAuthorGate` and `S2SRegistry`, hardhat 3 + `node:test` +
 * viem, same style as `AuthorFactory.test.ts`.
 *
 * The gate's allowlists are constructor arguments, so nothing here hard-codes a
 * Safe address, a Safe code hash, a factory or a module proxy hash. `deployWorld`
 * deploys probes, reads `keccak256(eth_getCode(probe))` for both the Safe proxy
 * and the module proxy, and passes those values in: the gate accepts the
 * fixture's own runtime code, which is the same mechanism it uses for Base.
 *
 * Successful registry writes go through `MockSafeProxy.execCall`, so `msg.sender`
 * at the registry is the Safe address — exactly the caller a real Safe would be.
 * Governance calls go through `MockGovernance.execute`, because the registry's
 * `msg.sender == governance` must be a contract address that can send a call.
 */

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();

const COOLDOWN_SECONDS = 90 * 24 * 60 * 60;
const COOLDOWN = BigInt(COOLDOWN_SECONDS);

type Hex = `0x${string}`;

const same = (a: string, b: string) => assert.equal(getAddress(a), getAddress(b));

/** viem wraps reverts: raw revert data and reason strings all live on the cause chain. */
function revertText(error: unknown): string {
  const parts: string[] = [];
  for (let e = error as any; e; e = e.cause) {
    if (typeof e.raw === 'string') parts.push(e.raw);
    if (typeof e.data === 'string') parts.push(e.data);
    if (typeof e.message === 'string') parts.push(e.message);
  }
  return parts.join('\n');
}

async function catchRevert(call: Promise<unknown>, label: string): Promise<unknown> {
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected a revert${label ? ` (${label})` : ''}, but the call succeeded`);
  return caught;
}

/** Assert the revert carries exactly the encoded custom error (and its arguments). */
async function assertError(
  abi: readonly unknown[],
  call: Promise<unknown>,
  name: string,
  args: readonly unknown[] = [],
) {
  const caught = await catchRevert(call, name);
  const expected = encodeErrorResult({ abi: abi as never, errorName: name, args: args as never });
  const text = revertText(caught);
  assert.ok(
    text.toLowerCase().includes(expected.toLowerCase()),
    `expected ${name} (${expected}), got:\n${text.slice(0, 500)}`,
  );
}

async function assertErrorName(abi: readonly unknown[], call: Promise<unknown>, name: string) {
  const caught = await catchRevert(call, name);
  assert.ok(
    revertText(caught).includes(name),
    `expected ${name}, got:\n${revertText(caught).slice(0, 500)}`,
  );
}

function codehashOf(code: Hex | undefined, label: string): Hex {
  assert.ok(code && code !== '0x', `${label} deployed with no code`);
  return keccak256(code);
}

async function deployWorld() {
  const [deployer, alice, bob, stranger] = await viem.getWalletClients();

  const singleton = await viem.deployContract('MockSingleton');
  const probe = await viem.deployContract('MockSafeProxy', [singleton.address]);
  const proxyCodehash = codehashOf(
    await publicClient.getCode({ address: probe.address }),
    'the Safe proxy probe',
  );

  // The module's factory allowlist and its proxy code hash are the other two
  // constructor arguments. Both are read from deployed fixtures here; on Base
  // they come from the env file, never from this test.
  const factory = await viem.deployContract('MockAuthorFactory');
  const moduleImpl = await viem.deployContract('MockRecordsImpl', [factory.address]);
  const moduleProbe = await viem.deployContract('MockModuleProxy', [moduleImpl.address, '0x']);
  const moduleProxyCodehash = codehashOf(
    await publicClient.getCode({ address: moduleProbe.address }),
    'the module proxy probe',
  );

  const gate = await viem.deployContract('S2SAuthorGate', [
    [singleton.address],
    [proxyCodehash],
    [factory.address],
    moduleProxyCodehash,
  ]);
  const governance = await viem.deployContract('MockGovernance');
  const registry = await viem.deployContract('S2SRegistry', [
    gate.address,
    governance.address,
  ]);

  return {
    singleton,
    probe,
    factory,
    factoryAddress: factory.address,
    moduleImpl,
    moduleProbe,
    proxyCodehash,
    moduleProxyCodehash,
    gate,
    governance,
    registry,
    deployer,
    alice,
    bob,
    stranger,
    singletonAddress: singleton.address,
  };
}

type World = Awaited<ReturnType<typeof deployWorld>>;

/** A module proxy over `MockRecordsImpl`, bound to `safe` and indexed by `factory`. */
async function deployModule(w: World, safe: string, factory: any = w.factory) {
  const implementation = await viem.deployContract('MockRecordsImpl', [factory.address]);
  const initData = encodeFunctionData({
    abi: implementation.abi as never,
    functionName: 'initialize',
    args: [safe, '0x'],
  });
  const proxy = await viem.deployContract('MockModuleProxy', [implementation.address, initData]);
  await factory.write.setRecordsModule([safe, proxy.address]);
  return proxy;
}

/** A Safe fixture plus its own records module proxy, enabled on it. */
async function newAuthor(w: World, factory?: any) {
  const safe = await viem.deployContract('MockSafeProxy', [w.singletonAddress]);
  const module = await deployModule(w, safe.address, factory);
  await safe.write.enableModule([module.address]);
  return { safe, module };
}

function registryCall(w: World, functionName: string, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: w.registry.abi as never, functionName, args: args as never });
}

/** Make `author.safe` the caller at the registry. */
function asSafe(w: World, author: { safe: any }, functionName: string, args: readonly unknown[]) {
  return author.safe.write.execCall([w.registry.address, registryCall(w, functionName, args)]);
}

const register = (w: World, author: { safe: any; module: any }, handle: string) =>
  asSafe(w, author, 'register', [handle, author.module.address]);

const release = (w: World, author: { safe: any }) => asSafe(w, author, 'release', []);

const setLocation = (w: World, author: { safe: any }, location: string) =>
  asSafe(w, author, 'setRecordsLocation', [location]);

/** Governance acts through the mock: msg.sender at the registry is the governor. */
function asGovernor(w: World, functionName: string, args: readonly unknown[]) {
  return w.governance.write.execute([
    w.registry.address,
    registryCall(w, functionName, args),
  ]);
}

const reserve = (w: World, handles: string[]) => asGovernor(w, 'reserve', [handles]);
const unreserve = (w: World, handles: string[]) => asGovernor(w, 'unreserve', [handles]);
const assignReserved = (w: World, handle: string, safe: string, location: string) =>
  asGovernor(w, 'assignReserved', [handle, safe, location]);

// ── S2SAuthorGate ────────────────────────────────────────────────

describe('S2SAuthorGate', () => {
  let w: World;

  beforeEach(async () => {
    w = await deployWorld();
  });

  it('accepts a Safe proxy with the allowed hashes, singleton and module factory, enabled and bound', async () => {
    const author = await newAuthor(w);
    assert.equal(
      await w.gate.read.isAuthor([author.safe.address, author.module.address]),
      true,
    );
  });

  it('rejects an EOA', async () => {
    const author = await newAuthor(w);
    assert.equal(await w.gate.read.isAuthor([w.stranger.account.address, author.module.address]), false);
    assert.equal(await w.gate.read.isAuthor([zeroAddress, author.module.address]), false);
  });

  it('rejects a contract whose code hash is not the allowed proxy hash', async () => {
    // MockSingleton has code and even the right shape of nothing; the code hash
    // is what stops it, before any call it might answer.
    const author = await newAuthor(w);
    assert.equal(await w.gate.read.isAuthor([w.singleton.address, author.module.address]), false);
    assert.equal(await w.gate.read.isAuthor([w.governance.address, author.module.address]), false);
  });

  it('rejects a proxy onto a singleton outside the allowlist', async () => {
    const otherSingleton = await viem.deployContract('MockSingleton');
    const safe = await viem.deployContract('MockSafeProxy', [otherSingleton.address]);
    const module = await deployModule(w, safe.address);
    await safe.write.enableModule([module.address]);

    // Same proxy runtime code hash as the accepted fixture, different singleton.
    assert.equal(await w.gate.read.isAuthor([safe.address, module.address]), false);
  });

  it('rejects a Safe that has not enabled the module', async () => {
    const safe = await viem.deployContract('MockSafeProxy', [w.singletonAddress]);
    const module = await deployModule(w, safe.address);
    assert.equal(await w.gate.read.isAuthor([safe.address, module.address]), false);
  });

  it('rejects a module bound to another Safe', async () => {
    const author = await newAuthor(w);
    const other = await newAuthor(w);
    // `other.module` is enabled on `other.safe` only; pointing the first Safe at
    // it fails both the enabled check and the module's own `safe()` answer.
    await author.safe.write.enableModule([other.module.address]);
    assert.equal(await w.gate.read.isAuthor([author.safe.address, other.module.address]), false);
  });

  it('rejects a stub module that answers every read but is not module-proxy code', async () => {
    const author = await newAuthor(w);
    // A Safe can deploy and enable this itself; it names the Safe, the kind and
    // the allowed factory correctly. Only the module proxy code hash stops it.
    const stub = await viem.deployContract('MockRecordsStub', [
      author.safe.address,
      w.factoryAddress,
    ]);
    await author.safe.write.enableModule([stub.address]);
    assert.equal(await w.gate.read.isAuthor([author.safe.address, stub.address]), false);
  });

  it('rejects a module proxy naming a factory outside the allowlist', async () => {
    const unlisted = await viem.deployContract('MockAuthorFactory');
    const author = await newAuthor(w, unlisted);
    assert.equal(await w.gate.read.isAuthor([author.safe.address, author.module.address]), false);
  });

  it('rejects a module the named factory does not index for this Safe', async () => {
    const author = await newAuthor(w);
    // Correct proxy code, kind and allowlisted factory, bound to the right Safe
    // and enabled — but the factory never created it, so its index says zero.
    const implementation = await viem.deployContract('MockRecordsImpl', [w.factoryAddress]);
    const initData = encodeFunctionData({
      abi: implementation.abi as never,
      functionName: 'initialize',
      args: [author.safe.address, '0x'],
    });
    const rogue = await viem.deployContract('MockModuleProxy', [implementation.address, initData]);
    await author.safe.write.enableModule([rogue.address]);
    assert.equal(await w.gate.read.isAuthor([author.safe.address, rogue.address]), false);
  });

  it('rejects a module address with no code, and does not revert on it', async () => {
    const author = await newAuthor(w);
    await author.safe.write.enableModule([w.stranger.account.address]);
    assert.equal(
      await w.gate.read.isAuthor([author.safe.address, w.stranger.account.address]),
      false,
    );
  });

  it('has no admin surface: the allowlists are constructor-only', async () => {
    const functions = (w.gate.abi as any[])
      .filter((item) => item.type === 'function')
      .map((item) => item.name);
    // `RECORDS_KIND` is a constant getter, not writable state; the only call is
    // the question itself.
    assert.deepEqual(functions, ['RECORDS_KIND', 'isAuthor']);
  });
});

// ── S2SRegistry ──────────────────────────────────────────────────

describe('S2SRegistry', () => {
  let w: World;
  let safeA: Awaited<ReturnType<typeof newAuthor>>;
  let safeB: Awaited<ReturnType<typeof newAuthor>>;

  beforeEach(async () => {
    w = await deployWorld();
    safeA = await newAuthor(w);
    safeB = await newAuthor(w);
  });

  // ── Names ──────────────────────────────────────────────────────

  it('accepts 3 and 32 bytes, rejects 2 and 33', async () => {
    await register(w, safeA, 'abc');
    same(await w.registry.read.resolve(['abc']), safeA.safe.address);

    const max = 'a'.repeat(32);
    await register(w, safeB, max);
    same(await w.registry.read.resolve([max]), safeB.safe.address);

    // Fresh Safes for the refusals: a Safe that already holds a handle reverts
    // AlreadyRegistered before the name rules are reached.
    await assertError(w.registry.abi as any[], register(w, await newAuthor(w), 'ab'), 'InvalidLength');
    const over = 'b'.repeat(33);
    await assertError(w.registry.abi as any[], register(w, await newAuthor(w), over), 'InvalidLength');
  });

  it('rejects uppercase, space, underscore, dot, Cyrillic, and zero-width space at the byte index', async () => {
    // Byte indexes, not code point indexes: Cyrillic `а` is two bytes at 3, and
    // the zero-width space is three bytes at 2.
    const cases: Array<[string, bigint]> = [
      ['Alice', 0n],
      ['ab cd', 2n],
      ['ab_cd', 2n],
      ['ab.cd', 2n],
      ['abcа', 3n],
      ['ab\u200B', 2n],
    ];
    for (const [handle, index] of cases) {
      await assertError(w.registry.abi as any[], register(w, safeA, handle), 'InvalidChar', [index]);
    }
    // Nothing registered: every one of them was refused before a write.
    assert.equal(await w.registry.read.nameOf([safeA.safe.address]), '');
  });

  it('rejects leading, trailing and doubled hyphens', async () => {
    for (const handle of ['-ab', 'ab-', 'a--b', 'a-b--c']) {
      await assertError(w.registry.abi as any[], register(w, safeA, handle), 'InvalidHyphen');
    }
  });

  it('alice blocks a1ice, al-ice and allce; rn and vv fold the same way', async () => {
    await register(w, safeA, 'alice');
    for (const handle of ['a1ice', 'al-ice', 'allce']) {
      await assertError(w.registry.abi as any[], register(w, safeB, handle), 'SkeletonTaken');
    }

    const rnOwner = await newAuthor(w);
    await register(w, rnOwner, 'c0rn');
    await assertError(w.registry.abi as any[], register(w, safeB, 'corn'), 'SkeletonTaken');

    // 'vv' folds to 'w'; the short form must still be a legal name, so use a
    // four-byte spelling whose folded form is three letters.
    const vvOwner = await newAuthor(w);
    await register(w, vvOwner, 'dvvx');
    await assertError(w.registry.abi as any[], register(w, safeB, 'dwx'), 'SkeletonTaken');
  });

  it('a hyphen cannot split a pair: cor-n, corn and c0rn all fold to com', async () => {
    assert.equal(await w.registry.read.skeletonOf(['cor-n']), 'com');
    assert.equal(await w.registry.read.skeletonOf(['corn']), 'com');
    assert.equal(await w.registry.read.skeletonOf(['c0rn']), 'com');

    await register(w, safeA, 'corn');
    await assertError(w.registry.abi as any[], register(w, safeB, 'cor-n'), 'SkeletonTaken');
    await assertError(w.registry.abi as any[], register(w, safeB, 'c0rn'), 'SkeletonTaken');
  });

  it('skeletonOf folds characters, hyphens and the two pairs', async () => {
    assert.equal(await w.registry.read.skeletonOf(['alice']), 'allce');
    assert.equal(await w.registry.read.skeletonOf(['a1ice']), 'allce');
    assert.equal(await w.registry.read.skeletonOf(['al-ice']), 'allce');
    assert.equal(await w.registry.read.skeletonOf(['c0rn']), 'com');
    assert.equal(await w.registry.read.skeletonOf(['corn']), 'com');
    assert.equal(await w.registry.read.skeletonOf(['avv']), 'aw');
    assert.equal(await w.registry.read.skeletonOf(['dvvx']), 'dwx');
    assert.equal(await w.registry.read.skeletonOf(['silver']), 'sllver');
    assert.equal(await w.registry.read.skeletonOf(['s1lver']), 'sllver');
    // Hyphens go before any pair rule: `r-n` is `rn`, and `rn` folds to `m`.
    assert.equal(await w.registry.read.skeletonOf(['r-n']), 'm');
    assert.equal(await w.registry.read.skeletonOf(['cor-n']), 'com');
    // Public and canonical for input registration refuses: uppercase lowers
    // before anything else.
    assert.equal(await w.registry.read.skeletonOf(['ALICE']), 'allce');
    assert.equal(await w.registry.read.skeletonOf(['A-1ICE']), 'allce');
  });

  // ── Reservation ────────────────────────────────────────────────

  it('a reserved name is refused to everyone, through any skeleton spelling', async () => {
    await reserve(w, ['g0ld']);
    await assertError(w.registry.abi as any[], register(w, safeA, 'gold'), 'Reserved');
    await assertError(w.registry.abi as any[], register(w, safeB, 'g0ld'), 'Reserved');

    await unreserve(w, ['g0ld']);
    await register(w, safeA, 'gold');
    same(await w.registry.read.resolve(['gold']), safeA.safe.address);
  });

  it('reserve and unreserve are governance-only and emit the skeleton', async () => {
    await assertError(
      w.registry.abi as any[],
      w.registry.write.reserve([['gold']]),
      'NotGovernance',
    );

    await reserve(w, ['gold']);
    const setLogs = await publicClient.getContractEvents({
      address: w.registry.address,
      abi: w.registry.abi,
      eventName: 'ReservedSet',
      fromBlock: 0n,
    });
    assert.equal(setLogs.length, 1);
    assert.equal(setLogs[0]!.args.reserved, true);
    assert.equal(setLogs[0]!.args.skeletonHash, keccak256(new TextEncoder().encode('gold')));
    // The spelling travels with the skeleton, so an indexer can recover it.
    assert.equal(setLogs[0]!.args.handle, 'gold');

    await unreserve(w, ['gold']);
    const all = await publicClient.getContractEvents({
      address: w.registry.address,
      abi: w.registry.abi,
      eventName: 'ReservedSet',
      fromBlock: 0n,
    });
    assert.equal(all.length, 2);
    assert.equal(all[1]!.args.reserved, false);
    assert.equal(all[1]!.args.handle, 'gold');
  });

  it('assignReserved is governance-only, gate-checks the Safe, and keeps the name reserved', async () => {
    await reserve(w, ['gold']);

    await assertError(
      w.registry.abi as any[],
      w.registry.write.assignReserved([['gold'], safeA.safe.address, safeA.module.address]),
      'NotGovernance',
    );

    // The Safe must pass the gate: a Safe without the module is NotAuthor.
    const bare = await viem.deployContract('MockSafeProxy', [w.singletonAddress]);
    await assertError(
      w.registry.abi as any[],
      assignReserved(w, 'gold', bare.address, safeA.module.address),
      'NotAuthor',
    );

    await assignReserved(w, 'gold', safeA.safe.address, safeA.module.address);
    same(await w.registry.read.resolve(['gold']), safeA.safe.address);
    assert.equal(await w.registry.read.nameOf([safeA.safe.address]), 'gold');

    // Kept reserved: another Safe cannot take it even after this one releases.
    await assertError(w.registry.abi as any[], register(w, safeB, 'gold'), 'Reserved');

    await release(w, safeA);
    await networkHelpers.time.increase(COOLDOWN_SECONDS);
    await assertError(w.registry.abi as any[], register(w, safeB, 'gold'), 'Reserved');

    // The released reserved name returns to governance's pool, not to public
    // registration: governance can assign it again.
    await assignReserved(w, 'gold', safeB.safe.address, safeB.module.address);
    same(await w.registry.read.resolve(['gold']), safeB.safe.address);
  });

  it('reserve, unreserve and assignReserved refuse spellings register would refuse', async () => {
    const invalid: Array<[string, string, bigint[]]> = [
      ['', 'InvalidLength', []],
      ['ab', 'InvalidLength', []],
      ['Gold', 'InvalidChar', [0n]],
      ['-gold', 'InvalidHyphen', []],
      ['gold-', 'InvalidHyphen', []],
      ['g--old', 'InvalidHyphen', []],
    ];
    for (const [handle, error, args] of invalid) {
      await assertError(w.registry.abi as any[], reserve(w, [handle]), error, args);
      await assertError(w.registry.abi as any[], unreserve(w, [handle]), error, args);
      await assertError(
        w.registry.abi as any[],
        assignReserved(w, handle, safeA.safe.address, safeA.module.address),
        error,
        args,
      );
    }

    // A refused batch reserved nothing: `gold` is still free to register.
    assert.deepEqual([...(await w.registry.read.check(['gold']))], [true, 0]);
    await register(w, safeA, 'gold');
  });

  it('assignReserved refuses a name that is not reserved', async () => {
    await assertError(
      w.registry.abi as any[],
      assignReserved(w, 'gold', safeA.safe.address, safeA.module.address),
      'Reserved',
    );
  });

  it('assignReserved keeps one handle per Safe', async () => {
    await reserve(w, ['gold', 'silver']);
    await assignReserved(w, 'gold', safeA.safe.address, safeA.module.address);
    await assertError(
      w.registry.abi as any[],
      assignReserved(w, 'silver', safeA.safe.address, safeA.module.address),
      'AlreadyRegistered',
    );
  });

  // ── One handle, release, cooldown, versions ─────────────────────

  it('one handle per Safe: a second register reverts AlreadyRegistered', async () => {
    await register(w, safeA, 'alice');
    await assertError(w.registry.abi as any[], register(w, safeA, 'bobcat'), 'AlreadyRegistered');
    assert.equal(await w.registry.read.nameOf([safeA.safe.address]), 'alice');
  });

  it('release frees the name, starts the cooldown, and the next owner gets version 2', async () => {
    await register(w, safeA, 'alice');
    const first = await w.registry.read.entry(['alice']);
    assert.equal(first.version, 1);
    assert.equal(await w.registry.read.versionOf(['alice']), 1);

    await release(w, safeA);
    assert.equal(await w.registry.read.nameOf([safeA.safe.address]), '');
    same(await w.registry.read.resolve(['alice']), zeroAddress);
    const gone = await w.registry.read.entry(['alice']);
    same(gone.safe, zeroAddress);
    assert.equal(gone.handle, '');
    // The version is retained even though the entry is gone: never reused.
    assert.equal(await w.registry.read.versionOf(['alice']), 1);

    const releasedLogs = await publicClient.getContractEvents({
      address: w.registry.address,
      abi: w.registry.abi,
      eventName: 'Released',
      fromBlock: 0n,
    });
    assert.equal(releasedLogs.length, 1);
    same(releasedLogs[0]!.args.safe!, safeA.safe.address);
    // The event carries the skeleton, so a released name's freed spellings are
    // readable without recomputing them offchain.
    assert.equal(
      releasedLogs[0]!.args.skeletonHash,
      keccak256(new TextEncoder().encode('allce')),
    );

    await assertErrorName(w.registry.abi as any[], register(w, safeB, 'alice'), 'CoolingDown');
    await networkHelpers.time.increase(COOLDOWN_SECONDS);

    await register(w, safeB, 'alice');
    const second = await w.registry.read.entry(['alice']);
    assert.equal(second.version, 2);
    assert.equal(await w.registry.read.versionOf(['alice']), 2);
    same(second.safe, safeB.safe.address);
    same(await w.registry.read.resolve(['alice']), safeB.safe.address);
    assert.equal(await w.registry.read.nameOf([safeB.safe.address]), 'alice');
  });

  it('a new spelling of the same skeleton continues the version sequence', async () => {
    await register(w, safeA, 'alice');
    await release(w, safeA);
    // The version is keyed by skeleton, so every spelling sees it, before and
    // after the cooldown.
    assert.equal(await w.registry.read.versionOf(['alice']), 1);
    assert.equal(await w.registry.read.versionOf(['al-ice']), 1);

    await networkHelpers.time.increase(COOLDOWN_SECONDS + 1);
    await register(w, safeB, 'al-ice');

    const entry = await w.registry.read.entry(['al-ice']);
    assert.equal(entry.version, 2);
    assert.equal(await w.registry.read.versionOf(['alice']), 2);
    assert.equal(await w.registry.read.versionOf(['al-ice']), 2);
  });

  it('release with no handle reverts NoHandle; setRecordsLocation too', async () => {
    await assertError(w.registry.abi as any[], release(w, safeA), 'NoHandle');
    await assertError(
      w.registry.abi as any[],
      setLocation(w, safeA, w.gate.address),
      'NoHandle',
    );
  });

  it('setRecordsLocation accepts a location the gate accepts and emits the handle hash', async () => {
    await register(w, safeA, 'alice');
    // AuthorFactory records one module per Safe, so a second real module cannot
    // exist. The permissive gate stands in for a gate that accepts the move; the
    // registry's check is what this test exercises.
    const permissive = await viem.deployContract('MockPermissiveGate');
    await asGovernor(w, 'setAuthorGate', [permissive.address]);
    const newLocation = await viem.deployContract('MockSingleton');
    await setLocation(w, safeA, newLocation.address);

    const entry = await w.registry.read.entry(['alice']);
    same(entry.recordsLocation, newLocation.address);

    const logs = await publicClient.getContractEvents({
      address: w.registry.address,
      abi: w.registry.abi,
      eventName: 'RecordsLocationSet',
      fromBlock: 0n,
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.args.handleHash, keccak256(new TextEncoder().encode('alice')));
    same(logs[0]!.args.location!, newLocation.address);
  });

  it('setRecordsLocation refuses a location the gate refuses and keeps the old pointer', async () => {
    await register(w, safeA, 'alice');
    const before = (await w.registry.read.entry(['alice'])).recordsLocation;
    const other = await newAuthor(w);
    // Bound to another Safe, so the gate says no even though it is real module
    // proxy code.
    await assertError(
      w.registry.abi as any[],
      setLocation(w, safeA, other.module.address),
      'NotAuthor',
    );
    same((await w.registry.read.entry(['alice'])).recordsLocation, before);
  });

  // ── The gate at the registry ───────────────────────────────────

  it('register refuses an EOA, a Safe without the module, and a module bound to another Safe', async () => {
    // EOA calling directly: no Safe code, so the gate says no.
    await assertError(
      w.registry.abi as any[],
      w.registry.write.register(['alice', safeA.module.address], { account: w.alice.account }),
      'NotAuthor',
    );

    // A Safe with the module not enabled.
    const bare = await viem.deployContract('MockSafeProxy', [w.singletonAddress]);
    const module = await deployModule(w, bare.address);
    await assertError(
      w.registry.abi as any[],
      bare.write.execCall([w.registry.address, registryCall(w, 'register', ['alice', module.address])]),
      'NotAuthor',
    );

    // A module bound to someone else, enabled on this Safe.
    const other = await newAuthor(w);
    await safeA.safe.write.enableModule([other.module.address]);
    // other.module is enabled here but answers safe() = other.safe, so the gate
    // refuses it even though the module is enabled on the registering Safe.
    await assertError(
      w.registry.abi as any[],
      asSafe(w, safeA, 'register', ['alice', other.module.address]),
      'NotAuthor',
    );
  });

  // ── check ──────────────────────────────────────────────────────

  it('check reports every reason, and is caller-independent', async () => {
    const free = await w.registry.read.check(['fresh']);
    assert.deepEqual([free[0], free[1]], [true, 0]);

    const freeAgain = await w.registry.read.check(['fresh'], { account: w.stranger.account });
    assert.deepEqual([freeAgain[0], freeAgain[1]], [true, 0]);

    assert.equal((await w.registry.read.check(['Fresh']))[1], 1);
    assert.equal((await w.registry.read.check(['ab']))[1], 2);
    assert.equal((await w.registry.read.check(['-ab']))[1], 3);

    await reserve(w, ['gold']);
    assert.equal((await w.registry.read.check(['gold']))[1], 4);

    await register(w, safeA, 'alice');
    assert.equal((await w.registry.read.check(['a1ice']))[1], 5);
    // The registered spelling itself reads as registered, not skeleton-taken.
    assert.equal((await w.registry.read.check(['alice']))[1], 7);
    assert.equal((await w.registry.read.check(['alice'], { account: w.bob.account }))[1], 7);

    // A fresh Safe registers and releases, so a cooling skeleton exists without
    // disturbing the registered 'alice'.
    const cooled = await newAuthor(w);
    await register(w, cooled, 'cobalt');
    await release(w, cooled);
    assert.equal((await w.registry.read.check(['cobalt']))[1], 6);
    assert.equal((await w.registry.read.check(['alice']))[1], 7);
  });

  // ── Governance surface ─────────────────────────────────────────

  it('governance has no function that can change a registered entry', async () => {
    await register(w, safeA, 'alice');
    const before = await w.registry.read.entry(['alice']);

    const functions = (w.registry.abi as any[]).filter((item) => item.type === 'function');
    const names = functions.map((item) => item.name);
    for (const forbidden of [
      'setOwner',
      'setVersion',
      'setRecordsLocationFor',
      'releaseFor',
      'forceRelease',
      'transferHandle',
      'assignHandle',
    ]) {
      assert.ok(!names.includes(forbidden), `the surface must not include ${forbidden}`);
    }
    const releaseFn = functions.find((item) => item.name === 'release');
    assert.equal(releaseFn.inputs.length, 0, 'release must only ever act on msg.sender');
    const assignFn = functions.find((item) => item.name === 'assignReserved');
    assert.deepEqual(
      assignFn.inputs.map((input: any) => input.type),
      ['string', 'address', 'address'],
    );

    // Nothing moved, and the owning Safe still writes its own entry.
    const after = await w.registry.read.entry(['alice']);
    same(after.safe, before.safe);
    assert.equal(after.version, before.version);
    same(after.recordsLocation, before.recordsLocation);
  });

  it('setAuthorGate refuses zero, code-less addresses and non-governance', async () => {
    await assertError(
      w.registry.abi as any[],
      w.registry.write.transferGovernance([w.stranger.account.address]),
      'NotGovernance',
    );
    await assertError(
      w.registry.abi as any[],
      asGovernor(w, 'setAuthorGate', [zeroAddress]),
      'ZeroAddress',
    );
    await assertError(
      w.registry.abi as any[],
      asGovernor(w, 'setAuthorGate', [w.stranger.account.address]),
      'NotAContract',
    );

    const secondGate = await viem.deployContract('S2SAuthorGate', [
      [w.singletonAddress],
      [w.proxyCodehash],
      [w.factoryAddress],
      w.moduleProxyCodehash,
    ]);
    await asGovernor(w, 'setAuthorGate', [secondGate.address]);
    same(await w.registry.read.authorGate(), secondGate.address);

    const logs = await publicClient.getContractEvents({
      address: w.registry.address,
      abi: w.registry.abi,
      eventName: 'AuthorGateSet',
      fromBlock: 0n,
    });
    assert.equal(logs.length, 1);
    same(logs[0]!.args.gate!, secondGate.address);
  });

  it('transferGovernance refuses zero, moves the role, and the old governor loses it', async () => {
    await assertError(
      w.registry.abi as any[],
      asGovernor(w, 'transferGovernance', [zeroAddress]),
      'ZeroAddress',
    );

    const nextGovernor = await viem.deployContract('MockGovernance');
    await asGovernor(w, 'transferGovernance', [nextGovernor.address]);
    same(await w.registry.read.governance(), nextGovernor.address);

    const transferLogs = await publicClient.getContractEvents({
      address: w.registry.address,
      abi: w.registry.abi,
      eventName: 'GovernanceTransferred',
      fromBlock: 0n,
    });
    assert.equal(transferLogs.length, 1);

    await assertError(w.registry.abi as any[], reserve(w, ['gold']), 'NotGovernance');
    await nextGovernor.write.execute([w.registry.address, registryCall(w, 'reserve', [['gold']])]);
    await assertError(w.registry.abi as any[], register(w, safeA, 'gold'), 'Reserved');
  });

  it('the constructor refuses zero and code-less gate and governance', async () => {
    await assertError(
      w.registry.abi as any[],
      viem.deployContract('S2SRegistry', [zeroAddress, w.governance.address]),
      'ZeroAddress',
    );
    await assertError(
      w.registry.abi as any[],
      viem.deployContract('S2SRegistry', [w.gate.address, zeroAddress]),
      'ZeroAddress',
    );
    await assertError(
      w.registry.abi as any[],
      viem.deployContract('S2SRegistry', [w.alice.account.address, w.governance.address]),
      'NotAContract',
    );
    await assertError(
      w.registry.abi as any[],
      viem.deployContract('S2SRegistry', [w.gate.address, w.alice.account.address]),
      'NotAContract',
    );
  });

  it('Registered carries the handle, Safe and version, and check events line up', async () => {
    await register(w, safeA, 'alice');
    const logs = await publicClient.getContractEvents({
      address: w.registry.address,
      abi: w.registry.abi,
      eventName: 'Registered',
      fromBlock: 0n,
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.args.handle, 'alice');
    assert.equal(logs[0]!.args.handleHash, keccak256(new TextEncoder().encode('alice')));
    assert.equal(logs[0]!.args.version, 1);
    same(logs[0]!.args.safe!, safeA.safe.address);
  });

  // ── Fuzz and invariant ─────────────────────────────────────────

  it('fuzz: no two registered handles share a skeleton', async () => {
    // A deterministic generator, so a failure reproduces. Each base word is
    // registered once, then variants that collapse to the same skeleton must be
    // refused; the registered set is checked pairwise at the end.
    let seed = 0x5eed;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    const bases = ['alice', 'bison', 'corn', 'ember', 'raven', 'silver', 'otter', 'wolves'];
    const registered: string[] = [];
    const skeletons = new Set<string>();
    // One free Safe is enough: every variant registration reverts, so it never
    // acquires a handle and can be reused.
    const chooser = await newAuthor(w);

    for (const base of bases) {
      const author = await newAuthor(w);
      await register(w, author, base);
      registered.push(base);

      const variants: string[] = [];
      for (let i = 0; i < base.length; i++) {
        const c = base[i]!;
        if (c === 'i') variants.push(base.slice(0, i) + '1' + base.slice(i + 1));
        if (c === 'i') variants.push(base.slice(0, i) + 'l' + base.slice(i + 1));
        if (c === 'o') variants.push(base.slice(0, i) + '0' + base.slice(i + 1));
        if (c === 's') variants.push(base.slice(0, i) + '5' + base.slice(i + 1));
        if (c === 'r' && base[i + 1] === 'n') variants.push(base.slice(0, i) + 'm' + base.slice(i + 2));
        if (c === 'v' && base[i + 1] === 'v') variants.push(base.slice(0, i) + 'w' + base.slice(i + 2));
        if (i > 0 && i < base.length - 1 && base[i - 1] !== '-' && base[i + 1] !== '-') {
          // Insert a hyphen before the character: same bytes minus the hyphen,
          // so the same skeleton, and it must not become a second name.
          variants.push(base.slice(0, i) + '-' + base.slice(i));
        }
      }
      assert.ok(variants.length > 0, `no variant generated for ${base}`);

      // Two variants per base, picked by the generator and distinct by index.
      const picked = new Set<number>();
      while (picked.size < Math.min(2, variants.length)) {
        picked.add(Math.floor(random() * variants.length));
      }
      for (const index of picked) {
        const variant = variants[index]!;
        const skeleton = await w.registry.read.skeletonOf([variant]);
        assert.equal(
          skeleton,
          await w.registry.read.skeletonOf([base]),
          `${variant} must fold to ${base}'s skeleton`,
        );
        await assertError(w.registry.abi as any[], register(w, chooser, variant), 'SkeletonTaken');
      }

      const skeleton = await w.registry.read.skeletonOf([base]);
      assert.ok(!skeletons.has(skeleton), `skeleton ${skeleton} was registered twice`);
      skeletons.add(skeleton);
    }

    // Every name currently registered resolves, and no skeleton repeats.
    const seen = new Set<string>();
    for (const handle of registered) {
      const skeleton = await w.registry.read.skeletonOf([handle]);
      assert.ok(!seen.has(skeleton), `duplicate skeleton ${skeleton}`);
      seen.add(skeleton);
      const owner = await w.registry.read.resolve([handle]);
      assert.notEqual(getAddress(owner), getAddress(zeroAddress));
    }
    assert.equal(seen.size, registered.length);
  });

  it('invariant: resolve(nameOf(safe)) is the Safe, for every registered Safe', async () => {
    const handles = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const authors: Array<Awaited<ReturnType<typeof newAuthor>>> = [];

    for (const handle of handles) {
      const author = await newAuthor(w);
      await register(w, author, handle);
      authors.push(author);
    }

    for (const author of authors) {
      const name = await w.registry.read.nameOf([author.safe.address]);
      assert.notEqual(name, '');
      same(await w.registry.read.resolve([name]), author.safe.address);
    }

    // And the reverse direction: no registered handle resolves to a Safe whose
    // nameOf is a different handle.
    for (const handle of handles) {
      const safe = await w.registry.read.resolve([handle]);
      assert.equal(await w.registry.read.nameOf([safe]), handle);
    }
  });
});
