import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { network } from 'hardhat';
import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
} from 'viem';

/**
 * One change from V4: the factory that approves upgrades is an immutable
 * constructor argument, not a storage slot written by `initialize`.
 *
 * The property the change exists for is the V2 jump. V4's `factory` slot is
 * written only by `initialize`, so a proxy that upgrades in place keeps zero
 * there and every later upgrade reverts `NoFactory()`. V5 answers the same
 * factory for every proxy over it, so a proxy running V2 reaches V5 in one hop
 * and keeps its agreements, offers and whitelists.
 *
 * The other property is that removing the slot moved nothing. V4 appended
 * `factory` last, so the slots below it must be untouched: asserted by comparing
 * two freshly deployed proxies slot by slot, and by writing through each module's
 * ABI and reading the other's.
 *
 * Hardhat 3 + `node:test` + viem, same wiring as `S2SPublicationModuleV4.test.ts`.
 */

const { viem } = await network.create();

type LayoutEntry = { label: string; slot: string; offset: number; type: string };
type BuildInfo = {
  output: {
    contracts?: Record<
      string,
      Record<string, { storageLayout?: { storage: LayoutEntry[] } } | undefined>
    >;
  };
};

/**
 * The layout solc compiled, not values read back from a proxy. Reading two
 * proxies proves only what was written: a variable declared at the removed slot
 * and never used leaves both sides equal while the declaration set has changed.
 * The compiler's own answer is the one that cannot be faked.
 */
function compiledLayout(contract: string): LayoutEntry[] {
  const dir = fileURLToPath(new URL('../artifacts/build-info', import.meta.url));
  for (const file of readdirSync(dir)) {
    // Hardhat writes `<id>.json` (input only) beside `<id>.output.json`.
    if (!file.endsWith('.output.json')) continue;
    const build = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as BuildInfo;
    for (const source of Object.values(build.output?.contracts ?? {})) {
      const found = source[contract]?.storageLayout?.storage;
      if (found) return found;
    }
  }
  throw new Error(`No compiled storageLayout for ${contract} in ${dir}`);
}

const publicClient = await viem.getPublicClient();

type Hex = `0x${string}`;

const ERRORS = parseAbi([
  'error OnlySafe()',
  'error InvalidFactory(address factory)',
  'error ImplementationNotApproved(address implementation)',
  'error AlreadyBackfilled()',
  'error ProtocolSafeMismatch(address factorySays, address expected)',
]);

const enc = {
  onlySafe: encodeErrorResult({ abi: ERRORS, errorName: 'OnlySafe' }),
  invalidFactory: (factory: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'InvalidFactory', args: [factory] }),
  alreadyBackfilled: encodeErrorResult({ abi: ERRORS, errorName: 'AlreadyBackfilled' }),
  protocolSafeMismatch: (factorySays: Hex, expected: Hex) =>
    encodeErrorResult({
      abi: ERRORS,
      errorName: 'ProtocolSafeMismatch',
      args: [factorySays, expected],
    }),
  notApproved: (implementation: Hex) =>
    encodeErrorResult({
      abi: ERRORS,
      errorName: 'ImplementationNotApproved',
      args: [implementation],
    }),
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

const FACTORY_CALLS = parseAbi([
  'function createModule(address safe, address[] _authors, address[] _devs)',
  'function setImplementation(address _implementation)',
  'function getModulesForSafe(address safe) view returns (address[])',
]);

const MODULE_CALLS = parseAbi([
  'function upgradeTo(address newImplementation)',
  'function upgradeToAndCall(address newImplementation, bytes data)',
  'function factory() view returns (address)',
  'function initialize(address _safe, address[] _authors, address[] _devs)',
  'function reinitializeV3()',
]);

/**
 * `upgradeTo` for an upgrade that is expected to land: `upgradeToAndCall` with
 * empty data force-delegatecalls the new implementation with no calldata, and
 * this module has no fallback, so a successful call needs a real function to
 * run. Authorisation is identical on both paths.
 */
const upgradeToData = (implementation: Hex) =>
  encodeFunctionData({ abi: MODULE_CALLS, functionName: 'upgradeTo', args: [implementation] });

const upgradeToAndCallData = (implementation: Hex, data: Hex) =>
  encodeFunctionData({
    abi: MODULE_CALLS,
    functionName: 'upgradeToAndCall',
    args: [implementation, data],
  });

/** The payload a V2 proxy needs: the one-shot backfill of `agreementsHeldBy`. */
const REINIT_V3 = encodeFunctionData({ abi: MODULE_CALLS, functionName: 'reinitializeV3' });

const genesisOf = (label: string) => keccak256(toHex(label));

/**
 * V4 implementation (version 1) → MockCaller (protocol safe, and publication
 * safe) → V4 create2 factory → V5 implementation, approved on that factory.
 */
async function deploy() {
  const [deployer, author, stranger] = await viem.getWalletClients();

  const v4 = await viem.deployContract('S2SPublicationModuleV4');
  const caller = await viem.deployContract('MockCaller');
  const factory = await viem.deployContract('S2SPublicationModuleV4Create2Factory', [
    caller.address,
    v4.address,
    [],
  ]);
  const v5 = await viem.deployContract('S2SPublicationModuleV5', [factory.address, caller.address]);
  await approve(caller, factory.address, v5.address);

  return { deployer, author, stranger, v4, v5, caller, factory, safe: caller.address };
}

type Stack = Awaited<ReturnType<typeof deploy>>;

async function asSafe(caller: Stack['caller'], target: Hex, data: Hex) {
  const hash = await caller.write.exec([target, data]);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

function approve(caller: Stack['caller'], factory: Hex, implementation: Hex) {
  return asSafe(
    caller,
    factory,
    encodeFunctionData({
      abi: FACTORY_CALLS,
      functionName: 'setImplementation',
      args: [implementation],
    }),
  );
}

/** A V5 proxy the factory created for the caller, which is also its safe. */
async function createModule(d: Stack) {
  await asSafe(
    d.caller,
    d.factory.address,
    encodeFunctionData({
      abi: FACTORY_CALLS,
      functionName: 'createModule',
      args: [d.safe, [], []],
    }),
  );
  const [module] = await d.factory.read.getModulesForSafe([d.safe]);
  return module!;
}

async function upgradeTo(d: Stack, module: Hex, implementation: Hex) {
  await asSafe(d.caller, module, upgradeToData(implementation));
}

const moduleAt = (address: Hex) => viem.getContractAt('S2SPublicationModuleV5', address);

async function readSlot(address: Hex, slot: Hex | number): Promise<bigint> {
  const key = typeof slot === 'number' ? (`0x${slot.toString(16)}` as Hex) : slot;
  const value = await publicClient.getStorageAt({ address, slot: key });
  return value && value !== '0x' ? BigInt(value) : 0n;
}

/** Raw storage, 32 bytes per slot, low slot first. */
async function storage(address: Hex, count = 130): Promise<bigint[]> {
  const out: bigint[] = [];
  for (let slot = 0; slot < count; slot++) out.push(await readSlot(address, slot));
  return out;
}

/** `keccak256(abi.encode(key, base))`, the slot of `mapping(key => …)`. */
function mappingSlot(key: Hex, base: number): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key, BigInt(base)]),
  );
}

const asWord = (address: Hex) => BigInt(address);

describe('S2SPublicationModuleV5 — the factory is a constructor constant', () => {
  it('answers the factory it was constructed with, through the proxy', async () => {
    const d = await deploy();
    const module = await moduleAt(await createModule(d));

    assert.equal((await module.read.factory()).toLowerCase(), d.factory.address.toLowerCase());
    assert.equal(await module.read.NAME(), 'S2S Publication Module V5');
  });

  it('leaves no storage slot holding the factory, unlike V4', async () => {
    const d = await deploy();
    const module = await createModule(d);
    const words = await storage(module);

    // V4 wrote the factory into a slot. V5 has none: the answer is a constant,
    // and a proxy upgraded from V2 is left with that slot at zero.
    assert.equal(
      words.filter((value) => value === asWord(d.factory.address)).length,
      0,
      'no slot may hold the factory address',
    );
  });

  it('refuses a factory with no code, which no later call could correct', async () => {
    const [deployer] = await viem.getWalletClients();

    await expectRevert(
      viem.deployContract('S2SPublicationModuleV5', [zeroAddress, deployer.account.address]),
      enc.invalidFactory(zeroAddress),
      'InvalidFactory',
    );
    await expectRevert(
      viem.deployContract('S2SPublicationModuleV5', [
        deployer.account.address,
        deployer.account.address,
      ]),
      enc.invalidFactory(deployer.account.address),
      'InvalidFactory',
    );
  });

  /**
   * The factory is an immutable, so a module bound to one the protocol does not
   * control is one hop from arbitrary code on every proxy that adopts it. The
   * constructor reads the factory's own `protocolSafe()` and refuses a pair that
   * disagrees.
   */
  it('refuses a protocol safe the factory does not name', async () => {
    const d = await deploy();
    const [deployer] = await viem.getWalletClients();

    await expectRevert(
      viem.deployContract('S2SPublicationModuleV5', [d.factory.address, deployer.account.address]),
      enc.protocolSafeMismatch(d.safe, deployer.account.address),
      'ProtocolSafeMismatch',
    );
  });

  it('keeps answering the same factory after the proxy is upgraded', async () => {
    const d = await deploy();
    const module = await createModule(d);
    const next = await viem.deployContract('S2SPublicationModuleV5', [d.factory.address, d.safe]);

    await approve(d.caller, d.factory.address, next.address);
    await upgradeTo(d, module, next.address);

    assert.equal(
      (await (await moduleAt(module)).read.factory()).toLowerCase(),
      d.factory.address.toLowerCase(),
      'the constant travels with the code, so a proxy answers it without writing it',
    );
  });
});

describe('S2SPublicationModuleV5 — approved upgrades', () => {
  it('lets the safe upgrade to an implementation the factory has set', async () => {
    const d = await deploy();
    const module = await createModule(d);
    const next = await viem.deployContract('S2SPublicationModuleV5', [d.factory.address, d.safe]);

    await approve(d.caller, d.factory.address, next.address);
    await upgradeTo(d, module, next.address);

    assert.equal(await d.factory.read.isApprovedImplementation([next.address]), true);
    assert.equal(await (await moduleAt(module)).read.NAME(), 'S2S Publication Module V5');
  });

  it('refuses an implementation the immutable factory never set', async () => {
    const d = await deploy();
    const module = await createModule(d);
    // A real V5 over the same factory, so the refusal is about approval only.
    const unapproved = await viem.deployContract('S2SPublicationModuleV5', [
      d.factory.address,
      d.safe,
    ]);

    await expectRevert(
      asSafe(d.caller, module, upgradeToAndCallData(unapproved.address, '0x')),
      enc.notApproved(unapproved.address),
      'ImplementationNotApproved',
    );
  });

  it('refuses an upgrade started by anyone but the safe', async () => {
    const d = await deploy();
    const module = await createModule(d);
    const next = await viem.deployContract('S2SPublicationModuleV5', [d.factory.address, d.safe]);
    await approve(d.caller, d.factory.address, next.address);

    await expectRevert(
      d.stranger.writeContract({
        address: module,
        abi: MODULE_CALLS,
        functionName: 'upgradeToAndCall',
        args: [next.address, '0x'],
      }),
      enc.onlySafe,
      'OnlySafe',
    );
  });
});

/**
 * The proxy is born under the plain-CREATE V3 factory, which is the deploy path
 * every existing V2 publication took: its storage is V2's, and it has no slot
 * for a factory at all. One `upgradeToAndCall` takes it to V5, and V2's own
 * `onlySafe` right is what authorises the hop. The factory's approval set is not
 * consulted on the way in, which is the point of the immutable: a V2 publication
 * whose implementation is not in the deployed factory's frozen legacy set can
 * still reach V5.
 */
async function v2Proxy(d: Stack) {
  const v2 = await viem.deployContract('S2SPublicationModuleV2');
  const birthplace = await viem.deployContract('S2SPublicationModuleV3Factory', [
    d.caller.address,
    v2.address,
  ]);
  await asSafe(
    d.caller,
    birthplace.address,
    encodeFunctionData({
      abi: FACTORY_CALLS,
      functionName: 'createModule',
      args: [d.safe, [d.author.account.address], []],
    }),
  );
  const [proxy] = await birthplace.read.getModulesForSafe([d.safe]);
  return proxy!;
}

describe('S2SPublicationModuleV5 — a V2 proxy upgrades in one hop', () => {
  it('keeps agreements, offers and whitelists across the jump', async () => {
    const d = await deploy();
    const proxy = await v2Proxy(d);
    const v2At = await viem.getContractAt('S2SPublicationModuleV2', proxy);

    const agreed = genesisOf('manuscript-agreed');
    const offered = genesisOf('manuscript-offered');
    await d.author.writeContract({
      address: proxy,
      abi: v2At.abi,
      functionName: 'makeOffer',
      args: [agreed, 'cid-agreed'],
    });
    await d.stranger.writeContract({
      address: proxy,
      abi: v2At.abi,
      functionName: 'makeOffer',
      args: [offered, 'cid-offered'],
    });

    assert.equal(await v2At.read.getDealCount(), 1n);
    assert.equal(await v2At.read.getOfferCount(), 1n);
    const [beforeAgreement] = await v2At.read.getDeals([0n, 10n]);
    const [beforeOffer] = await v2At.read.getOffers([0n, 10n]);

    await asSafe(d.caller, proxy, upgradeToAndCallData(d.v5.address, REINIT_V3));

    const module = await moduleAt(proxy);
    assert.equal(await module.read.NAME(), 'S2S Publication Module V5');
    assert.equal((await module.read.factory()).toLowerCase(), d.factory.address.toLowerCase());
    assert.equal(await module.read.hasDeal([agreed]), true);
    assert.equal(await module.read.getDealCount(), 1n);
    assert.equal(await module.read.getOfferCount(), 1n);
    assert.equal(await module.read.canRead([agreed, d.author.account.address]), true);

    const [afterAgreement] = await module.read.getDeals([0n, 10n]);
    const [afterOffer] = await module.read.getOffers([0n, 10n]);
    assert.equal(afterAgreement!.genesis, beforeAgreement!.genesis);
    assert.equal(afterAgreement!.cid, beforeAgreement!.cid);
    assert.equal(afterAgreement!.author.toLowerCase(), beforeAgreement!.author.toLowerCase());
    assert.equal(afterOffer!.genesis, beforeOffer!.genesis);
    assert.equal(afterOffer!.cid, beforeOffer!.cid);

    assert.equal(await module.read.ownerHasAgreement([d.author.account.address]), true);
    assert.equal(await module.read.isWhitelistedAuthor([d.author.account.address]), true);
  });

  it('backfills agreementsHeldBy exactly once', async () => {
    const d = await deploy();
    const proxy = await v2Proxy(d);
    const v2At = await viem.getContractAt('S2SPublicationModuleV2', proxy);

    // Two agreements for the same author, so a second backfill would double it.
    for (const label of ['first', 'second']) {
      await d.author.writeContract({
        address: proxy,
        abi: v2At.abi,
        functionName: 'makeOffer',
        args: [genesisOf(label), `cid-${label}`],
      });
    }

    await asSafe(d.caller, proxy, upgradeToAndCallData(d.v5.address, REINIT_V3));

    const module = await moduleAt(proxy);
    assert.equal(await module.read.getAgreementCount(), 2n);
    assert.equal(await module.read.ownerHasAgreement([d.author.account.address]), true);

    // The counter is `mapping(address => uint256)`, so its slot is a hash. Find
    // it by the author key: the only nonzero entry under that key is the count.
    const author = d.author.account.address;
    const counters: { base: number; slot: Hex; value: bigint }[] = [];
    for (let base = 0; base < 130; base++) {
      const slot = mappingSlot(author, base);
      const value = await readSlot(proxy, slot);
      if (value !== 0n) counters.push({ base, slot, value });
    }
    assert.equal(counters.length, 1, 'one address-keyed counter for a whitelisted author');
    assert.equal(counters[0]!.value, 2n, 'one increment per agreement, never two runs');
    assert.equal(await readSlot(proxy, 0), 2n, 'nonce 2 is spent');
    assert.equal(await readSlot(proxy, 119), 1n, 'the backfill set the sentinel in the slot');

    // A second payload reverts and the counter is unchanged.
    const reason = 'Initializable: contract is already initialized';
    await assert.rejects(
      asSafe(d.caller, proxy, REINIT_V3),
      (error: unknown) => errorText(error).includes(reason),
      `expected "${reason}"`,
    );
    assert.equal(await readSlot(proxy, counters[0]!.slot), 2n);
  });

  /**
   * A proxy the factory created as V5 has never run the backfill and must never
   * run it: `_addAgreement` counted every agreement at the time it was struck,
   * so a second pass doubles the counter and `_removeAgreement` floors at zero
   * rather than unwinding, which leaves `ownerHasAgreement` true for an author
   * holding nothing.
   */
  it('refuses the backfill on a proxy whose counts are already right', async () => {
    const d = await deploy();
    const proxy = await createModule(d);
    const module = await moduleAt(proxy);

    // The safe strikes it, so it lands as an agreement and `_addAgreement`
    // increments the author's counter immediately.
    await asSafe(
      d.caller,
      proxy,
      encodeFunctionData({
        abi: module.abi,
        functionName: 'makeOffer',
        args: [genesisOf('counted-once'), 'cid-counted-once'],
      }),
    );
    assert.equal(await module.read.getAgreementCount(), 1n);

    await expectRevert(
      asSafe(d.caller, proxy, REINIT_V3),
      enc.alreadyBackfilled,
      'AlreadyBackfilled',
    );
    assert.equal(await readSlot(proxy, 119), 1n, 'initialize set the sentinel');
  });
});

describe('S2SPublicationModuleV5 — storage below the removed slot', () => {
  /**
   * V4 appends the factory as its last declaration; V5 replaces that declaration
   * with the backfill sentinel. Every slot below must keep the same owner, and
   * nothing may be declared after it. This compares the layouts solc emitted, so
   * a declaration added and never written fails it.
   */
  it('declares V4 layout below the removed slot, and one bool in place of it', () => {
    const v4 = compiledLayout('S2SPublicationModuleV4');
    const v5 = compiledLayout('S2SPublicationModuleV5');

    const v4Factory = v4.find((entry) => entry.label === 'factory');
    assert.ok(v4Factory, 'V4 declares a factory slot');
    const removed = Number(v4Factory.slot);

    // solc stamps structs with an id local to the compilation unit, so the id
    // differs between files for the same struct; the name is what matters.
    const typeOf = (type: string) => type.replace(/(t_struct\([^)]*\))\d+_storage/g, '$1_storage');
    const same = (entry: LayoutEntry) => ({
      label: entry.label,
      slot: entry.slot,
      offset: entry.offset,
      type: typeOf(entry.type),
    });
    assert.deepEqual(
      v5.filter((entry) => Number(entry.slot) < removed).map(same),
      v4.filter((entry) => Number(entry.slot) < removed).map(same),
      'every slot below the removed one belongs to the same declaration, in the same order',
    );

    const v5AtRemoved = v5.filter((entry) => Number(entry.slot) === removed);
    assert.deepEqual(v5AtRemoved.map(same), [
      { label: '_backfilled', slot: String(removed), offset: 0, type: 't_bool' },
    ]);
    assert.equal(v5.length, v4.length, 'V5 declares nothing beyond the removed slot');
    assert.equal(
      v5.filter((entry) => Number(entry.slot) > removed).length,
      v4.filter((entry) => Number(entry.slot) > removed).length,
      'no new declaration sits above the sentinel',
    );
  });

  /**
   * And the values agree where both are written, which the layout cannot show.
   * Both proxies are freshly deployed over the same initializer arguments.
   */
  it('matches V4 slot for slot, and leaves the factory slot empty', async () => {
    const d = await deploy();
    const author = d.author.account.address;
    const dev = d.stranger.account.address;

    // The same deploy path, one factory per implementation, the same safe and
    // the same initializer arguments: the two proxies differ only in the code
    // they run.
    const overV4 = await viem.deployContract('S2SPublicationModuleV3Factory', [
      d.safe,
      d.v4.address,
    ]);
    const overV5 = await viem.deployContract('S2SPublicationModuleV3Factory', [
      d.safe,
      d.v5.address,
    ]);
    for (const factory of [overV4, overV5]) {
      await asSafe(
        d.caller,
        factory.address,
        encodeFunctionData({
          abi: FACTORY_CALLS,
          functionName: 'createModule',
          args: [d.safe, [author], [dev]],
        }),
      );
    }
    const [fromV4] = await overV4.read.getModulesForSafe([d.safe]);
    const [fromV5] = await overV5.read.getModulesForSafe([d.safe]);

    const v4Slots = await storage(fromV4!);
    const v5Slots = await storage(fromV5!);

    // V4's `initialize` recorded the factory that called it. That is the slot
    // V5 dropped, and it must be the last one V4 declared.
    const factorySlot = v4Slots.findIndex((value) => value === asWord(overV4.address));
    assert.ok(factorySlot > 0, 'V4 must record its factory');
    assert.equal(
      v4Slots.filter((value) => value === asWord(overV4.address)).length,
      1,
      'the factory was one slot',
    );
    // V5 uses the same index for the backfill sentinel, which `initialize` set.
    // No slot holds the factory address, which the test above covers.
    assert.equal(v5Slots[factorySlot], 1n, 'V5 keeps only the backfill sentinel there');

    for (let slot = 0; slot < factorySlot; slot++) {
      assert.equal(v5Slots[slot], v4Slots[slot], `slot ${slot} moved between V4 and V5`);
    }

    // Write through one layout, read through the other: each ABI over the same
    // proxy, so the assertion is about the slot and nothing else.
    const asV4 = await viem.getContractAt('S2SPublicationModuleV4', fromV4);
    const asV5OverV4 = await viem.getContractAt('S2SPublicationModuleV5', fromV4);
    const asV5 = await viem.getContractAt('S2SPublicationModuleV5', fromV5);
    const asV4OverV5 = await viem.getContractAt('S2SPublicationModuleV4', fromV5);

    await asSafe(
      d.caller,
      fromV4!,
      encodeFunctionData({
        abi: asV4.abi,
        functionName: 'whitelistDev',
        args: [d.deployer.account.address],
      }),
    );
    assert.equal(await asV5OverV4.read.isWhitelistedDev([d.deployer.account.address]), true);

    await asSafe(
      d.caller,
      fromV5!,
      encodeFunctionData({
        abi: asV5.abi,
        functionName: 'whitelistAuthor',
        args: [d.deployer.account.address],
      }),
    );
    assert.equal(await asV4OverV5.read.isWhitelistedAuthor([d.deployer.account.address]), true);
  });
});
