import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import {
  encodeAbiParameters,
  encodeErrorResult,
  getAddress,
  keccak256,
  parseAbi,
  toFunctionSelector,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem';

/**
 * First contract test suite in the repo — establishes the pattern:
 * hardhat 3 + `node:test` + the hardhat-viem / network-helpers plugins.
 * `pnpm test` runs `hardhat test`, which dispatches to the node test runner.
 */

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();

const genesis = (label: string) => keccak256(toHex(label));

/**
 * An EIP-165 id as the XOR of the selectors, taken from the signatures the
 * contract actually compiles to rather than typed in as a literal — the same
 * shape as the guard's id test.
 */
const interfaceIdOf = (signatures: string[]) =>
  `0x${signatures
    .map((s) => BigInt(toFunctionSelector(s)))
    .reduce((a, b) => a ^ b, 0n)
    .toString(16)
    .padStart(8, '0')}` as `0x${string}`;

/** Safe 1.4.1 `type(Guard).interfaceId`: what a Safe's `setGuard` asks for. */
const GUARD_ID = '0xe6d7a83a' as `0x${string}`;

/**
 * Storage slots of the versions log for a genesis, derived from the compiled
 * layout rather than from memory. Dump `storageLayout` out of
 * `artifacts/build-info/*.output.json` and `safe` is at 101, `versions` at 102.
 *
 * `versions` is a mapping to a dynamic array, so there are two hashes, not one:
 *
 *   length slot  = keccak256(abi.encode(genesis, uint256(102)))
 *   element base = keccak256(abi.encode(length slot)) + index * 2
 *
 * The intermediate word is the array's length slot, not the array's data: an
 * entry written at `length + 1` lands in unrelated storage and every assertion
 * here fails, which is the point of deriving it instead of guessing.
 *
 * Each element is two words: `cid` (a string is one length word, with its bytes
 * elsewhere) then `timestamp` and `blockNumber` packed into one word at offsets
 * 0 and 8. A pre-upgrade entry's second word is a plain uint256 timestamp: its
 * low 64 bits are the timestamp, the next 64 are zero.
 */
const VERSIONS_SLOT = 102n;

/** Slot holding the number of versions of `genesis`. */
const versionsLengthSlot = (g: `0x${string}`) =>
  BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [g, VERSIONS_SLOT])));

/** First word of element `index`: the `cid` length word. */
const entryBase = (g: `0x${string}`, index = 0n) =>
  BigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }], [versionsLengthSlot(g)]))) + index * 2n;

/** Second word of an entry: the packed `timestamp` | `blockNumber` pair. */
const timestampWord = (g: `0x${string}`, index = 0n) => entryBase(g, index) + 1n;

/** An unknown genesis is a `bytes32(0)` Entry, so tests need one that is never appended. */
const UNKNOWN = genesis('never-appended');

type Deployment = Awaited<ReturnType<typeof deployDrafts>>;

/**
 * Deploy both implementations, the one factory, and one drafts index for
 * `safe` — the module's only writer. Going through the factory is also what
 * production does, and Hardhat only emits artifacts for `src`, so the OZ proxy
 * is not deployable by name here.
 */
async function deployDrafts() {
  const [deployer, safe, stranger] = await viem.getWalletClients();

  const implementation = await viem.deployContract('DraftsModuleV1');
  // The factory deploys both module kinds; the history implementation is a
  // constructor argument here and nothing in this suite proxies onto it.
  const historyImplementation = await viem.deployContract('OwnerHistoryModuleV1');
  const factory = await viem.deployContract('AuthorContractsFactory', [
    implementation.address,
    historyImplementation.address,
  ]);

  await factory.write.createDraftsModule([safe.account.address]);
  const modules = await factory.read.getDraftsModulesForSafe([safe.account.address]);
  const drafts = await viem.getContractAt('DraftsModuleV1', modules[0]!);

  return { drafts, implementation, historyImplementation, factory, deployer, safe, stranger };
}

/** Append from the Safe — the only caller `append` accepts. */
async function appendAsSafe(d: Deployment, hash: `0x${string}`, cid: string) {
  await d.drafts.write.append([hash, cid], { account: d.safe.account });
}

/** viem returns the named struct fields as an object, not a tuple. */
async function fetch(d: Deployment, hash: `0x${string}`) {
  return d.drafts.read.fetch([hash]);
}

const ERROR_ABI = parseAbi([
  'error OnlySafe()',
  'error ZeroHash()',
  'error EmptyCid()',
  'error ZeroAddress()',
  'error OnlyDeployer()',
]);

const selectorOf = (name: 'OnlySafe' | 'ZeroHash' | 'EmptyCid' | 'ZeroAddress' | 'OnlyDeployer') =>
  encodeErrorResult({ abi: ERROR_ABI, errorName: name });

/** viem wraps reverts: raw revert data and reason strings all live on the cause chain. */
function revertText(error: unknown): string {
  const parts: string[] = [];
  for (let e = error as any; e; e = e.cause) {
    if (typeof e.raw === 'string') parts.push(e.raw);
    if (typeof e.message === 'string') parts.push(e.message);
  }
  return parts.join('\n');
}

/**
 * Assert a call reverts with a selector (`selectorOf`) or a regex over the cause
 * chain. A selector is needed where viem cannot name the error: the module's
 * custom errors are not in the factory's ABI, and OZ 4.9 reverts `initialize`
 * with a reason string, not a custom error.
 */
async function assertReverts(call: Promise<unknown>, expected: string | RegExp) {
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected a revert matching ${expected}, but the call succeeded`);
  const text = revertText(caught);
  if (typeof expected === 'string') {
    assert.ok(
      text.includes(expected),
      `expected revert data ${expected}, got:\n${text.slice(0, 500)}`,
    );
  } else {
    assert.match(text, expected);
  }
}

describe('DraftsModuleV1', () => {
  let d: Deployment;

  beforeEach(async () => {
    d = await deployDrafts();
  });

  it('initializes: safe is the writer, NAME is the discovery string, log is empty', async () => {
    assert.equal(getAddress(await d.drafts.read.safe()), getAddress(d.safe.account.address!));
    assert.equal(await d.drafts.read.NAME(), 'S2S Drafts Module V1');
    assert.equal(await d.drafts.read.count(), 0n);
    assert.equal(await d.drafts.read.versionCount([UNKNOWN]), 0n);
  });

  it('append binds the author and pushes the genesis onto the log', async () => {
    const hash = genesis('draft-a');
    await appendAsSafe(d, hash, 'bafy-draft-a-v1');

    assert.equal(await d.drafts.read.isDraft([hash]), true);
    assert.equal(getAddress(await d.drafts.read.authorOf([hash])), getAddress(d.safe.account.address!));
    assert.equal(await d.drafts.read.count(), 1n);
    assert.equal(await d.drafts.read.versionCount([hash]), 1n);

    const entry = await fetch(d, hash);
    assert.equal(entry.genesis, hash);
    assert.equal(getAddress(entry.author), getAddress(d.safe.account.address!));
    assert.equal(entry.cid, 'bafy-draft-a-v1');
    assert.equal(entry.versionCount, 1n);
    assert.ok(entry.timestamp > 0n);
  });

  it('append from a non-safe reverts OnlySafe, and bad input reverts its own error', async () => {
    const hash = genesis('draft-a');

    await assert.rejects(
      d.drafts.write.append([hash, 'bafy-draft-a-v1'], { account: d.stranger.account }),
      /OnlySafe/,
    );

    await assert.rejects(appendAsSafe(d, zeroHash, 'bafy-nope'), /ZeroHash/);
    await assert.rejects(appendAsSafe(d, hash, ''), /EmptyCid/);

    assert.equal(await d.drafts.read.count(), 0n);
    assert.equal(await d.drafts.read.isDraft([hash]), false);
  });

  it('repeated append accumulates versions in order with increasing timestamps', async () => {
    const hash = genesis('draft-a');
    const cids = ['bafy-v1', 'bafy-v2', 'bafy-v3'];

    const stamps: bigint[] = [];
    for (const cid of cids) {
      stamps.push(await networkHelpers.time.latest());
      await appendAsSafe(d, hash, cid);
      await networkHelpers.time.increase(60);
    }

    assert.equal(await d.drafts.read.count(), 1n);
    assert.equal(await d.drafts.read.versionCount([hash]), 3n);

    const [timestamps, historyCids] = await d.drafts.read.history([hash]);
    assert.deepEqual([...historyCids], cids);
    assert.equal(timestamps.length, 3);
    assert.ok(timestamps[0] >= stamps[0]);
    assert.ok(timestamps[1] > timestamps[0]);
    assert.ok(timestamps[2] > timestamps[1]);

    // fetch returns the LATEST version, not the first.
    const entry = await fetch(d, hash);
    assert.equal(entry.cid, 'bafy-v3');
    assert.equal(entry.timestamp, timestamps[2]);
    assert.equal(entry.versionCount, 3n);
  });

  it('append records the block of its own transaction, index-aligned with history', async () => {
    const hash = genesis('draft-with-block');

    // Explicit mining: "the block the append landed in" only means something if
    // the blocks around it differ from it.
    await networkHelpers.mine(3);
    const firstTx = await d.drafts.write.append([hash, 'bafy-blocked-v1'], {
      account: d.safe.account,
    });
    const firstReceipt = await publicClient.waitForTransactionReceipt({ hash: firstTx });
    const firstBlock = firstReceipt.blockNumber!;

    await networkHelpers.mine(2);
    const secondTx = await d.drafts.write.append([hash, 'bafy-blocked-v2'], {
      account: d.safe.account,
    });
    const secondReceipt = await publicClient.waitForTransactionReceipt({ hash: secondTx });
    const secondBlock = secondReceipt.blockNumber!;
    assert.ok(secondBlock > firstBlock + 1n, 'the two appends are in distinguishable blocks');

    const [timestamps] = await d.drafts.read.history([hash]);
    const blocks = await d.drafts.read.blocksOf([hash]);

    assert.equal(blocks.length, 2);
    assert.equal(timestamps.length, 2);
    assert.equal(blocks[0], firstBlock);
    assert.equal(blocks[1], secondBlock);
    assert.equal(timestamps[0], (await publicClient.getBlock({ blockNumber: firstBlock }))!.timestamp);
    assert.equal(timestamps[1], (await publicClient.getBlock({ blockNumber: secondBlock }))!.timestamp);

    // `Entry.timestamp` is the same value as the latest history entry, cast to
    // uint256 on the way out; `Entry` itself is unchanged.
    const entry = await fetch(d, hash);
    assert.equal(entry.timestamp, timestamps[1]);
    assert.equal(entry.cid, 'bafy-blocked-v2');
  });

  it('a pre-upgrade entry reads its timestamp and reports no block', async () => {
    const hash = genesis('draft-pre-upgrade');
    await appendAsSafe(d, hash, 'bafy-published-before');

    const [before] = await d.drafts.read.history([hash]);
    assert.equal(before.length, 1);
    const realTimestamp = before[0]!;

    // An old-format word: a plain uint256 timestamp, low 64 bits only. It must
    // differ from the real one, so a write that misses the slot leaves the old
    // value in place and the assertion below fails instead of passing by luck.
    const OLD_TIMESTAMP = 1_700_000_001n;
    assert.notEqual(OLD_TIMESTAMP, realTimestamp, 'the planted value must not match the live one');

    const slot = timestampWord(hash);
    await networkHelpers.setStorageAt(d.drafts.address, slot, OLD_TIMESTAMP);

    const [timestamps] = await d.drafts.read.history([hash]);
    const blocks = await d.drafts.read.blocksOf([hash]);

    assert.equal(timestamps[0], OLD_TIMESTAMP, `nothing at slot ${slot}: the slot is wrong`);
    assert.equal(blocks[0], 0n); // high 64 bits of the old word are zero
    assert.equal((await fetch(d, hash)).timestamp, OLD_TIMESTAMP);

    // The log is still whole: the CID word was untouched, so only the timestamp
    // pair changed.
    const [, cids] = await d.drafts.read.history([hash]);
    assert.equal(cids[0], 'bafy-published-before');
  });

  it('a CID longer than 31 bytes reads back intact, and does not shift the stride', async () => {
    const hash = genesis('draft-long-cid');
    // A real CIDv1 base32 is already past 31 bytes; this one is longer still, so
    // the string is one length word plus overflow either way, and the element
    // must stay two words.
    const long = `bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi${'q'.repeat(120)}`;
    assert.ok(long.length > 31);

    await appendAsSafe(d, hash, long);
    await appendAsSafe(d, hash, 'bafy-short');

    const [timestamps, cids] = await d.drafts.read.history([hash]);
    const blocks = await d.drafts.read.blocksOf([hash]);

    assert.deepEqual([...cids], [long, 'bafy-short']);
    // The longer element did not push the next one: its block is read from the
    // second element's own second word.
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0]! > 0n && blocks[1]! >= blocks[0]!);
    assert.ok(timestamps[1]! >= timestamps[0]!);
    assert.equal((await fetch(d, hash)).cid, 'bafy-short');
  });

  it('blocksOf answers an empty array on an unknown genesis and on an empty log', async () => {
    assert.deepEqual([...(await d.drafts.read.blocksOf([UNKNOWN]))], []);
    assert.deepEqual([...(await d.drafts.read.blocksOf([zeroHash]))], []);

    // A genesis that is known but has no versions cannot exist (append is what
    // creates it), so the other empty case is a module with no appends at all.
    await d.factory.write.createDraftsModule([d.safe.account.address]);
    const modules = await d.factory.read.getDraftsModulesForSafe([d.safe.account.address]);
    const fresh = await viem.getContractAt('DraftsModuleV1', modules.at(-1)!);
    assert.equal(await fresh.read.count(), 0n);
    assert.deepEqual([...(await fresh.read.blocksOf([genesis('draft-a')]))], []);
  });

  it('fetch on an unknown genesis returns a zeroed Entry instead of reverting', async () => {
    const entry = await fetch(d, UNKNOWN);

    assert.equal(entry.versionCount, 0n);
    assert.equal(entry.genesis, zeroHash);
    assert.equal(entry.author, zeroAddress);
    assert.equal(entry.cid, '');
    assert.equal(entry.timestamp, 0n);

    const [timestamps, cids] = await d.drafts.read.history([UNKNOWN]);
    assert.equal(timestamps.length, 0);
    assert.equal(cids.length, 0);
  });

  it('fetchAll is in insertion order and fetchAllPaged pages it', async () => {
    const hashes = [genesis('a'), genesis('b'), genesis('c'), genesis('d')];
    for (const [i, hash] of hashes.entries()) {
      await appendAsSafe(d, hash, `bafy-${i}`);
    }
    // A second version on the first one must not move it in the list.
    await appendAsSafe(d, hashes[0], 'bafy-0-v2');

    assert.equal(await d.drafts.read.count(), 4n);

    const all = await d.drafts.read.fetchAll();
    assert.deepEqual(
      all.map((e) => e.genesis),
      hashes,
    );
    assert.deepEqual(
      all.map((e) => e.cid),
      ['bafy-0-v2', 'bafy-1', 'bafy-2', 'bafy-3'],
    );
    assert.deepEqual(
      all.map((e) => e.versionCount),
      [2n, 1n, 1n, 1n],
    );

    const middle = await d.drafts.read.fetchAllPaged([1n, 2n]);
    assert.deepEqual(
      middle.map((e) => e.genesis),
      [hashes[1], hashes[2]],
    );

    const tail = await d.drafts.read.fetchAllPaged([3n, 10n]);
    assert.deepEqual(
      tail.map((e) => e.genesis),
      [hashes[3]],
    );

    assert.deepEqual(await d.drafts.read.fetchAllPaged([10n, 2n]), []);
    assert.deepEqual(await d.drafts.read.fetchAllPaged([0n, 0n]), []);
  });

  it('factory createDraftsModule yields a working proxy for the Safe', async () => {
    assert.equal(getAddress(await d.factory.read.draftsImplementation()), getAddress(d.implementation.address));
    assert.equal(await d.factory.read.draftsImplementationCount(), 1n);
    assert.equal(getAddress(await d.factory.read.getDraftsImplementationByVersion([1n])), getAddress(d.implementation.address));

    const modules = await d.factory.read.getDraftsModulesForSafe([d.safe.account.address]);
    assert.equal(modules.length, 1);

    const module = await viem.getContractAt('DraftsModuleV1', modules[0]!);
    assert.equal(getAddress(await module.read.safe()), getAddress(d.safe.account.address!));

    const hash = genesis('draft-via-factory');
    await module.write.append([hash, 'bafy-factory'], { account: d.safe.account });

    const entry = await module.read.fetch([hash]);
    assert.equal(entry.cid, 'bafy-factory');
    assert.equal(entry.versionCount, 1n);
    assert.equal(await module.read.count(), 1n);

    await assert.rejects(
      module.write.append([hash, 'bafy-stranger'], { account: d.stranger.account }),
      /OnlySafe/,
    );
  });

  it('a second append does not reassign the binding, and appends no second list entry', async () => {
    const hash = genesis('draft-a');
    await appendAsSafe(d, hash, 'bafy-v1');
    const boundAt = getAddress(await d.drafts.read.authorOf([hash]));
    assert.equal(boundAt, getAddress(d.safe.account.address!));

    await appendAsSafe(d, hash, 'bafy-v2');

    assert.equal(getAddress(await d.drafts.read.authorOf([hash])), boundAt);
    assert.equal(await d.drafts.read.count(), 1n);
    assert.equal(await d.drafts.read.versionCount([hash]), 2n);

    // The same CID appended twice is a second version, not an update: no dedupe,
    // which is what a retried Safe proposal leaves behind.
    await appendAsSafe(d, hash, 'bafy-v2');
    const [, cids] = await d.drafts.read.history([hash]);
    assert.deepEqual([...cids], ['bafy-v1', 'bafy-v2', 'bafy-v2']);
    assert.equal(await d.drafts.read.versionCount([hash]), 3n);
  });

  it('a paged read whose offset+limit lands exactly on count is not clamped short', async () => {
    const hashes = [genesis('a'), genesis('b'), genesis('c'), genesis('d')];
    for (const [i, hash] of hashes.entries()) {
      await appendAsSafe(d, hash, `bafy-${i}`);
    }

    const page = await d.drafts.read.fetchAllPaged([1n, 3n]); // 1 + 3 === count
    assert.deepEqual(
      page.map((e) => e.genesis),
      [hashes[1], hashes[2], hashes[3]],
    );

    const whole = await d.drafts.read.fetchAllPaged([0n, 4n]); // 0 + 4 === count
    assert.equal(whole.length, 4);

    const oneShort = await d.drafts.read.fetchAllPaged([0n, 3n]);
    assert.equal(oneShort.length, 3);
  });

  it('fetchAllPaged clamps a huge limit instead of overflowing', async () => {
    const hashes = [genesis('a'), genesis('b'), genesis('c')];
    for (const [i, hash] of hashes.entries()) {
      await appendAsSafe(d, hash, `bafy-${i}`);
    }

    // type(uint256).max is the natural way to say "to the end"; offset + limit
    // used to overflow (Panic 0x11) before the clamp.
    const max = (1n << 256n) - 1n;

    const fromOne = await d.drafts.read.fetchAllPaged([1n, max]);
    assert.deepEqual(
      fromOne.map((e) => e.genesis),
      [hashes[1], hashes[2]],
    );

    const everything = await d.drafts.read.fetchAllPaged([0n, max]);
    assert.equal(everything.length, 3);

    assert.deepEqual(await d.drafts.read.fetchAllPaged([3n, max]), []);
  });

  it('supportsInterface answers the drafts role id and nothing else', async () => {
    const draftsId = interfaceIdOf([
      'function append(bytes32,string)',
      'function isDraft(bytes32)',
      'function authorOf(bytes32)',
      'function count()',
    ]);
    const historyId = interfaceIdOf([
      'function sync()',
      'function isOwner(address)',
      'function isOwnerAt(address,uint256)',
      'function wasOwnerAt(address,uint256)',
      'function eraCount()',
    ]);

    // Literals so a drift in the interface surfaces here; the ids are constants
    // of the published contract, so they may never change.
    assert.equal(draftsId, '0xefb74036');
    assert.equal(historyId, '0xee855023');

    // The role must be distinguishable from the guard's, and from the other
    // module's: an id two roles share tells a reader nothing.
    assert.notEqual(draftsId, GUARD_ID);
    assert.notEqual(historyId, GUARD_ID);
    assert.notEqual(draftsId, historyId);

    for (const target of [d.drafts.address, d.implementation.address]) {
      const module = await viem.getContractAt('DraftsModuleV1', target);
      assert.equal(await module.read.supportsInterface([draftsId]), true);
      assert.equal(await module.read.supportsInterface(['0x01ffc9a7']), true); // IERC165
      assert.equal(await module.read.supportsInterface([historyId]), false);
      assert.equal(await module.read.supportsInterface([GUARD_ID]), false);
      assert.equal(await module.read.supportsInterface(['0xffffffff']), false);
      assert.equal(await module.read.supportsInterface(['0x12345678']), false); // a random id
    }

    // The other module answers its own id, and not this one.
    const history = await viem.getContractAt('OwnerHistoryModuleV1', d.historyImplementation.address);
    assert.equal(await history.read.supportsInterface([historyId]), true);
    assert.equal(await history.read.supportsInterface([draftsId]), false);
    assert.equal(await history.read.supportsInterface([GUARD_ID]), false);
  });

  it('initialize rejects address(0) instead of birthing a dead module', async () => {
    await assertReverts(
      d.factory.write.createDraftsModule([zeroAddress]),
      selectorOf('ZeroAddress'),
    );
    assert.equal((await d.factory.read.getDraftsModulesForSafe([zeroAddress])).length, 0);
  });

  it('setDraftsImplementation is deployer-only; createDraftsModule stays open by design', async () => {
    assert.equal(
      getAddress(await d.factory.read.deployer()),
      getAddress(d.deployer.account.address!),
    );

    const other = await viem.deployContract('DraftsModuleV1');

    await assertReverts(
      d.factory.write.setDraftsImplementation([other.address], { account: d.stranger.account }),
      selectorOf('OnlyDeployer'),
    );
    assert.equal(
      getAddress(await d.factory.read.draftsImplementation()),
      getAddress(d.implementation.address),
    );
    assert.equal(await d.factory.read.draftsImplementationCount(), 1n);

    // The deployer moves it; the history records the swap and new modules follow it.
    await d.factory.write.setDraftsImplementation([other.address]);
    assert.equal(getAddress(await d.factory.read.draftsImplementation()), getAddress(other.address));
    assert.equal(await d.factory.read.draftsImplementationCount(), 2n);
    assert.equal(
      getAddress(await d.factory.read.getDraftsImplementationByVersion([2n])),
      getAddress(other.address),
    );

    await d.factory.write.createDraftsModule([d.safe.account.address]);
    const modules = await d.factory.read.getDraftsModulesForSafe([d.safe.account.address]);
    assert.equal(modules.length, 2);
    assert.equal(getAddress(await viem.getContractAt('DraftsModuleV1', modules[1]!).then((c) => c.read.safe())), getAddress(d.safe.account.address!));
  });

  it('getDraftsModulesForSafe is an index, not a permission: anyone can append an entry', async () => {
    // createDraftsModule is permissionless on purpose (deploying a proxy
    // installs nothing; the Safe must still call the module itself), so a
    // stranger can push an entry for a Safe it has nothing to do with.
    // Intersecting the index with what the Safe actually uses is the reader's
    // job.
    await d.factory.write.createDraftsModule([d.safe.account.address], { account: d.stranger.account });

    const modules = await d.factory.read.getDraftsModulesForSafe([d.safe.account.address]);
    assert.equal(modules.length, 2); // the helper's proxy plus the stranger's
  });

  it('getDraftsImplementationByVersion is 1-based and reverts InvalidVersion outside the history', async () => {
    const VERSION_ABI = parseAbi(['error InvalidVersion()']);
    const invalidVersion = encodeErrorResult({ abi: VERSION_ABI, errorName: 'InvalidVersion' });

    assert.equal(
      getAddress(await d.factory.read.getDraftsImplementationByVersion([1n])),
      getAddress(d.implementation.address),
    );
    await assertReverts(d.factory.read.getDraftsImplementationByVersion([0n]), invalidVersion);
    await assertReverts(d.factory.read.getDraftsImplementationByVersion([2n]), invalidVersion);

    // The two histories are independent: the drafts history grew above, the
    // owner-history one is still the constructor seed.
    assert.equal(await d.factory.read.ownerHistoryImplementationCount(), 1n);
    assert.equal(
      getAddress(await d.factory.read.ownerHistoryImplementation()),
      getAddress(d.historyImplementation.address),
    );
  });

  it('the UUPS gate is exercisable today: stranger upgrade, bare init, double init all revert', async () => {
    const next = await viem.deployContract('DraftsModuleV1');

    await assertReverts(
      d.drafts.write.upgradeToAndCall([next.address, '0x'], { account: d.stranger.account }),
      selectorOf('OnlySafe'),
    );

    // The bare implementation has its initializers disabled in the constructor.
    const bare = await viem.getContractAt('DraftsModuleV1', d.implementation.address);
    await assertReverts(bare.write.initialize([d.safe.account.address]), /already initialized/);

    // The proxy is already initialised.
    await assertReverts(
      d.drafts.write.initialize([d.safe.account.address], { account: d.safe.account }),
      /already initialized/,
    );

    // And the Safe's own swap goes through, emitting the module's event, with
    // storage intact.
    const hash = genesis('survives-upgrade');
    await appendAsSafe(d, hash, 'bafy-survives');

    // `upgradeTo`, not `upgradeToAndCall(impl, '0x')`: OZ 4.9.6 forces the
    // delegatecall on the AndCall variant (forceCall = true), which reverts on a
    // module with no fallback.
    await assertReverts(
      d.drafts.write.upgradeToAndCall([next.address, '0x'], { account: d.safe.account }),
      /low-level delegate call failed/,
    );

    const publicClient = await viem.getPublicClient();
    await d.drafts.write.upgradeTo([next.address], { account: d.safe.account });

    const logs = await publicClient.getContractEvents({
      address: d.drafts.address,
      abi: d.drafts.abi,
      eventName: 'ContractUpgraded',
      fromBlock: 0n,
    });
    assert.equal(logs.length, 1);
    assert.equal(getAddress(logs[0]!.args.implementation!), getAddress(next.address));

    assert.equal(getAddress(await d.drafts.read.safe()), getAddress(d.safe.account.address!));
    assert.equal(await d.drafts.read.count(), 1n);
    assert.equal((await fetch(d, hash)).cid, 'bafy-survives');
  });
});
