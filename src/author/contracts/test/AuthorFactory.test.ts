import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import {
  encodeErrorResult,
  getAddress,
  getContract,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem';
import { Artifact_S2SRecordsModuleV0_1 as RecordsArtifact } from '@s2s/publication-contracts/artifacts/S2SRecordsModuleV0_1';

/**
 * Factory suite: the CREATE2 prediction views against the deployment they
 * predict, and the records role. Same style as `DraftsModuleV1.test.ts` —
 * hardhat 3 + `node:test` + viem, going through the factory because Hardhat only
 * emits artifacts for `src` and the OZ proxy is not deployable by name here.
 *
 * Each test reads the prediction, then creates, then compares. Nothing here
 * recomputes the CREATE2 hash in TypeScript: a reimplementation in the test
 * would agree with a wrong contract, so the assertion is prediction versus the
 * proxy the factory actually produced.
 *
 * The records implementation is the real `S2SRecordsModuleV0_1`, deployed from
 * the artifact the publication package exports — the same source the author
 * deploy script uses. It is not compiled here, so it is deployed by hand rather
 * than through `viem.deployContract('name')`.
 */

const { viem } = await network.create();

const publicClient = await viem.getPublicClient();

type Hex = `0x${string}`;
type Deployment = Awaited<ReturnType<typeof deployFactory>>;

const RECORDS_KIND: Hex = keccak256(toHex('s2s.module.records'));
const DRAFTS_KIND: Hex = keccak256(toHex('s2s.module.drafts'));

/** `keccak256("eip1967.proxy.implementation") - 1`. */
const ERC1967_IMPLEMENTATION_SLOT: Hex =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/** Compare addresses as checksummed strings; the chain decodes either casing. */
const same = (a: Hex, b: Hex) => assert.equal(getAddress(a), getAddress(b));

const ERROR_ABI = parseAbi(['error ZeroAddress()', 'error SafeCallFailed()']);
const ZERO_ADDRESS_ERROR = encodeErrorResult({ abi: ERROR_ABI, errorName: 'ZeroAddress' });
const SAFE_CALL_FAILED_ERROR = encodeErrorResult({ abi: ERROR_ABI, errorName: 'SafeCallFailed' });

/** viem wraps reverts: raw revert data and reason strings all live on the cause chain. */
function revertText(error: unknown): string {
  const parts: string[] = [];
  for (let e = error as any; e; e = e.cause) {
    if (typeof e.raw === 'string') parts.push(e.raw);
    if (typeof e.message === 'string') parts.push(e.message);
  }
  return parts.join('\n');
}

async function assertReverts(call: Promise<unknown>, expected: string) {
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected a revert matching ${expected}, but the call succeeded`);
  const text = revertText(caught);
  assert.ok(
    text.includes(expected),
    `expected revert data ${expected}, got:\n${text.slice(0, 500)}`,
  );
}

/** For the errors whose arguments are the point, the name is enough. */
async function assertRevertsNamed(call: Promise<unknown>, name: string) {
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected a revert naming ${name}, but the call succeeded`);
  const text = revertText(caught);
  assert.ok(text.includes(name), `expected ${name} in:\n${text.slice(0, 500)}`);
}

/**
 * Deploy the real records implementation with the publication package's
 * bytecode. The constructor takes `(factory, protocolSafe)` and reads the
 * factory's `protocolSafe()` back, so the factory must exist first.
 */
async function deployRecordsImplementation(factory: Hex, protocolSafe: Hex): Promise<Hex> {
  const [wallet] = await viem.getWalletClients();
  const hash = await wallet.deployContract({
    abi: RecordsArtifact.abi as never,
    bytecode: RecordsArtifact.bytecode as Hex,
    args: [factory, protocolSafe],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.ok(receipt.contractAddress, 'the records implementation deployed to no address');
  return receipt.contractAddress;
}

async function deployFactory() {
  const [deployer, ownerOne, ownerTwo, stranger] = await viem.getWalletClients();

  // A history proxy reads the Safe during `initialize`, so both test Safes are
  // `MockSafe` contracts: an EOA has no `getOwners()` and the create would
  // revert `SafeCallFailed` before any address existed worth predicting. The
  // drafts module would accept an EOA, and using the same two Safes for both
  // roles is what makes the four-prediction test a real cross-product.
  const owners = [ownerOne.account.address, ownerTwo.account.address];
  const safeA = await viem.deployContract('MockSafe', [owners]);
  const safeB = await viem.deployContract('MockSafe', [owners]);

  // The protocol Safe is not an authority in this factory. It is a fixture here
  // because the records implementation compares it against its own argument.
  const protocolSafe = await viem.deployContract('MockSafe', [owners]);

  const draftsImplementation = await viem.deployContract('DraftsModuleV1');
  const historyImplementation = await viem.deployContract('OwnerHistoryModuleV1');
  const factory = await viem.deployContract('AuthorFactory', [
    draftsImplementation.address,
    historyImplementation.address,
    protocolSafe.address,
  ]);

  // Deployed but not set: the pointer is moved by each test that needs it, so
  // "no implementation" is the default state.
  const recordsImplementation = await deployRecordsImplementation(
    factory.address,
    protocolSafe.address,
  );

  return {
    factory,
    draftsImplementation,
    historyImplementation,
    recordsImplementation,
    protocolSafe: protocolSafe.address,
    deployer: deployer.account.address,
    safeA: safeA.address,
    safeB: safeB.address,
    stranger: stranger.account,
    strangerAddress: stranger.account.address,
  };
}

/** Set the records pointer to the real implementation deployed in `deployFactory`. */
async function enableRecords(d: Deployment) {
  await d.factory.write.setRecordsImplementation([d.recordsImplementation]);
}

/** Create one drafts proxy and return both the predicted and deployed address. */
async function createDrafts(d: Deployment, safe: Hex) {
  const predicted = await d.factory.read.draftsModuleAddress([safe]);
  await d.factory.write.createDraftsModule([safe]);
  const modules = await d.factory.read.getDraftsModulesForSafe([safe]);
  return { predicted, deployed: modules[modules.length - 1]! };
}

/** Create one history proxy plus its guard; the prediction covers the proxy only. */
async function createHistory(d: Deployment, safe: Hex) {
  const predicted = await d.factory.read.ownerHistoryModuleAddress([safe]);
  await d.factory.write.createOwnerHistoryModule([safe]);
  const modules = await d.factory.read.getOwnerHistoryModulesForSafe([safe]);
  const proxy = modules[modules.length - 1]!;
  return { predicted, deployed: proxy, guard: await d.factory.read.guardFor([proxy]) };
}

/** Read the records module behind a proxy with the publication package's ABI. */
function recordsAt(address: Hex) {
  return getContract({
    address,
    abi: RecordsArtifact.abi as never,
    client: publicClient,
  });
}

describe('AuthorFactory', () => {
  let d: Deployment;

  beforeEach(async () => {
    d = await deployFactory();
  });

  it('the prediction equals the deployed proxy for a fresh Safe, both roles', async () => {
    const drafts = await createDrafts(d, d.safeA);
    same(drafts.deployed, drafts.predicted);

    const history = await createHistory(d, d.safeA);
    same(history.deployed, history.predicted);

    // Both proxies are distinct even though they share a Safe and a nonce: the
    // salt carries the role.
    assert.notEqual(getAddress(drafts.deployed), getAddress(history.deployed));

    // And what was deployed is the real module, not just an address that agreed.
    const draftsModule = await viem.getContractAt('DraftsModuleV1', drafts.deployed);
    same(await draftsModule.read.safe(), d.safeA);
    const historyModule = await viem.getContractAt('OwnerHistoryModuleV1', history.deployed);
    same(await historyModule.read.safe(), d.safeA);
    assert.notEqual(getAddress(history.guard), getAddress(history.deployed));
  });

  it('a prediction read before any create equals what that create deploys', async () => {
    // Nothing has been created yet for either Safe.
    const draftsBefore = await d.factory.read.draftsModuleAddress([d.safeB]);
    const historyBefore = await d.factory.read.ownerHistoryModuleAddress([d.safeB]);

    await d.factory.write.createDraftsModule([d.safeB]);
    await d.factory.write.createOwnerHistoryModule([d.safeB]);

    const drafts = await d.factory.read.getDraftsModulesForSafe([d.safeB]);
    const history = await d.factory.read.getOwnerHistoryModulesForSafe([d.safeB]);
    assert.equal(drafts.length, 1);
    assert.equal(history.length, 1);
    same(drafts[0]!, draftsBefore);
    same(history[0]!, historyBefore);
  });

  it('four predictions — two Safes, two roles — are four distinct addresses', async () => {
    const addresses = [
      await d.factory.read.draftsModuleAddress([d.safeA]),
      await d.factory.read.ownerHistoryModuleAddress([d.safeA]),
      await d.factory.read.draftsModuleAddress([d.safeB]),
      await d.factory.read.ownerHistoryModuleAddress([d.safeB]),
    ].map(getAddress);

    assert.equal(new Set(addresses).size, 4, `collision among ${addresses.join(', ')}`);

    // The prediction is stable while nothing intervenes: reading it twice, or
    // reading drafts and then history, does not move it.
    same(await d.factory.read.draftsModuleAddress([d.safeA]), addresses[0]!);
    same(await d.factory.read.draftsModuleAddress([d.safeB]), addresses[2]!);
  });

  it('a second create for the same Safe moves the address, and each create matches its own prediction', async () => {
    const first = await createDrafts(d, d.safeA);
    same(first.deployed, first.predicted);

    const secondPrediction = await d.factory.read.draftsModuleAddress([d.safeA]);
    assert.notEqual(getAddress(secondPrediction), getAddress(first.deployed));

    await d.factory.write.createDraftsModule([d.safeA]);
    const modules = await d.factory.read.getDraftsModulesForSafe([d.safeA]);
    assert.equal(modules.length, 2);
    same(modules[1]!, secondPrediction);
    same(modules[0]!, first.deployed);

    // Same for the history pair: the proxy moves, and the guard is fresh.
    const firstHistory = await createHistory(d, d.safeA);
    const secondHistory = await createHistory(d, d.safeA);
    same(firstHistory.deployed, firstHistory.predicted);
    same(secondHistory.deployed, secondHistory.predicted);
    assert.notEqual(getAddress(firstHistory.deployed), getAddress(secondHistory.deployed));
    assert.notEqual(getAddress(firstHistory.guard), getAddress(secondHistory.guard));
    same(await d.factory.read.guardFor([firstHistory.deployed]), firstHistory.guard);
    same(await d.factory.read.guardFor([secondHistory.deployed]), secondHistory.guard);
  });

  it('the index and event behaviour is unchanged', async () => {
    const drafts = await createDrafts(d, d.safeA);
    const draftsLogs = await publicClient.getContractEvents({
      address: d.factory.address,
      abi: d.factory.abi,
      eventName: 'DraftsModuleCreated',
      args: { safe: d.safeA },
      fromBlock: 0n,
    });
    assert.equal(draftsLogs.length, 1);
    same(draftsLogs[0]!.args.moduleProxy!, drafts.deployed);
    same(draftsLogs[0]!.args.implementation!, d.draftsImplementation.address);
    assert.equal((await d.factory.read.getDraftsModulesForSafe([d.safeA])).length, 1);

    const history = await createHistory(d, d.safeA);
    const historyLogs = await publicClient.getContractEvents({
      address: d.factory.address,
      abi: d.factory.abi,
      eventName: 'OwnerHistoryModuleCreated',
      args: { safe: d.safeA },
      fromBlock: 0n,
    });
    assert.equal(historyLogs.length, 1);
    same(historyLogs[0]!.args.moduleProxy!, history.deployed);
    same(historyLogs[0]!.args.guard!, history.guard);
    same(historyLogs[0]!.args.implementation!, d.historyImplementation.address);
    same(await d.factory.read.guardFor([history.deployed]), history.guard);

    const historyModules = await d.factory.read.getOwnerHistoryModulesForSafe([d.safeA]);
    assert.equal(historyModules.length, 1);
    same(historyModules[0]!, history.deployed);

    // The stranger's create lands too: permissionless creation is unchanged, and
    // it takes the next nonce, which is the case the prediction is exact for.
    await d.factory.write.createDraftsModule([d.safeA], { account: d.stranger });
    assert.equal((await d.factory.read.getDraftsModulesForSafe([d.safeA])).length, 2);
  });

  it('setDraftsImplementation moves the prediction, and the next create lands on it', async () => {
    const before = await createDrafts(d, d.safeA);
    same(before.deployed, before.predicted);

    const oldPrediction = await d.factory.read.draftsModuleAddress([d.safeA]);
    const next = await viem.deployContract('DraftsModuleV1');
    await d.factory.write.setDraftsImplementation([next.address]);

    const movedPrediction = await d.factory.read.draftsModuleAddress([d.safeA]);
    assert.notEqual(getAddress(movedPrediction), getAddress(oldPrediction));

    await d.factory.write.createDraftsModule([d.safeA]);
    const modules = await d.factory.read.getDraftsModulesForSafe([d.safeA]);
    same(modules[modules.length - 1]!, movedPrediction);

    // The moved proxy runs the new implementation's code, which is why the code
    // hash had to change with it.
    const module = await viem.getContractAt('DraftsModuleV1', movedPrediction);
    same(await module.read.safe(), d.safeA);

    // The history pointer is untouched: the two implementations stay separate.
    same(await d.factory.read.ownerHistoryImplementation(), d.historyImplementation.address);
  });

  it('the prediction answers for inputs no create can realise', async () => {
    // Two of them, documented on the views: a zero Safe, and a contract that
    // cannot answer getOwners(). Both make `initialize` revert, so no address is
    // ever occupied, while the view still returns the arithmetic answer.
    const predicted = await d.factory.read.draftsModuleAddress([zeroAddress]);
    assert.notEqual(getAddress(predicted), getAddress(zeroAddress));

    await assertReverts(
      d.factory.write.createDraftsModule([zeroAddress]),
      ZERO_ADDRESS_ERROR,
    );
    // Nothing was indexed, and the counter did not move: the revert took the
    // whole call with it.
    assert.equal((await d.factory.read.getDraftsModulesForSafe([zeroAddress])).length, 0);
    same(await d.factory.read.draftsModuleAddress([zeroAddress]), predicted);

    await assertReverts(
      d.factory.write.createOwnerHistoryModule([zeroAddress]),
      ZERO_ADDRESS_ERROR,
    );

    // A contract with no getOwners(): the history module reads the Safe inside
    // initialize, gets no answer, and reverts. The drafts module would accept it,
    // which is why the prediction is not a statement that a proxy exists.
    const notASafe = await viem.deployContract('DraftsModuleV1');
    const historyPrediction = await d.factory.read.ownerHistoryModuleAddress([notASafe.address]);
    assert.notEqual(getAddress(historyPrediction), getAddress(zeroAddress));

    await assertReverts(
      d.factory.write.createOwnerHistoryModule([notASafe.address]),
      SAFE_CALL_FAILED_ERROR,
    );
    assert.equal(
      (await d.factory.read.getOwnerHistoryModulesForSafe([notASafe.address])).length,
      0,
    );
    // The prediction did not move with the failed create.
    same(
      await d.factory.read.ownerHistoryModuleAddress([notASafe.address]),
      historyPrediction,
    );
  });

  // ── Records role ────────────────────────────────────────────────

  it('the constructor stores protocolSafe and does not require code at it', async () => {
    same(await d.factory.read.protocolSafe(), d.protocolSafe);

    // An EOA as the third argument is accepted: the records implementation
    // compares the value, this factory never calls it. No code check, unlike
    // the records implementation's own check of the factory.
    const eoaFactory = await viem.deployContract('AuthorFactory', [
      d.draftsImplementation.address,
      d.historyImplementation.address,
      d.strangerAddress,
    ]);
    same(await eoaFactory.read.protocolSafe(), d.strangerAddress);
    same(await eoaFactory.read.draftsImplementation(), d.draftsImplementation.address);
    same(await eoaFactory.read.ownerHistoryImplementation(), d.historyImplementation.address);
  });

  it('setRecordsImplementation rejects zero, no code, and the three wrong declarations', async () => {
    await assertRevertsNamed(
      d.factory.write.setRecordsImplementation([zeroAddress]),
      'ZeroAddress',
    );
    await assertRevertsNamed(
      d.factory.write.setRecordsImplementation([d.strangerAddress]),
      'NotAContract',
    );

    // A contract named as the gate, but not this factory.
    const wrongGate = await viem.deployContract('MockRecordsImplementation', [
      d.safeA,
      RECORDS_KIND,
      ERC1967_IMPLEMENTATION_SLOT,
    ]);
    await assertRevertsNamed(
      d.factory.write.setRecordsImplementation([wrongGate.address]),
      'ImplementationNotGated',
    );

    // This factory, the right UUPS answer, another kind.
    const wrongKind = await viem.deployContract('MockRecordsImplementation', [
      d.factory.address,
      DRAFTS_KIND,
      ERC1967_IMPLEMENTATION_SLOT,
    ]);
    await assertRevertsNamed(
      d.factory.write.setRecordsImplementation([wrongKind.address]),
      'ImplementationKindMismatch',
    );

    // Right kind, right gate, no upgrade door.
    const noUUPS = await viem.deployContract('MockRecordsImplementation', [
      d.factory.address,
      RECORDS_KIND,
      zeroHash,
    ]);
    await assertRevertsNamed(
      d.factory.write.setRecordsImplementation([noUUPS.address]),
      'NotUUPS',
    );

    // Nothing was set or versioned by any of the refusals.
    same(await d.factory.read.recordsImplementation(), zeroAddress);
    assert.equal(await d.factory.read.recordsImplementationCount(), 0n);
  });

  it('setRecordsImplementation accepts the real implementation and versions it', async () => {
    await enableRecords(d);

    same(await d.factory.read.recordsImplementation(), d.recordsImplementation);
    assert.equal(await d.factory.read.recordsImplementationCount(), 1n);
    same(await d.factory.read.getRecordsImplementationByVersion([1n]), d.recordsImplementation);

    const logs = await publicClient.getContractEvents({
      address: d.factory.address,
      abi: d.factory.abi,
      eventName: 'RecordsImplementationDeployed',
      fromBlock: 0n,
    });
    assert.equal(logs.length, 1);
    same(logs[0]!.args.implementation!, d.recordsImplementation);
    assert.equal(logs[0]!.args.version, 1n);

    // A second set appends a version; version 0 and past-the-end are refused.
    const second = await viem.deployContract('MockRecordsImplementation', [
      d.factory.address,
      RECORDS_KIND,
      ERC1967_IMPLEMENTATION_SLOT,
    ]);
    await d.factory.write.setRecordsImplementation([second.address]);
    assert.equal(await d.factory.read.recordsImplementationCount(), 2n);
    same(await d.factory.read.getRecordsImplementationByVersion([2n]), second.address);
    await assertRevertsNamed(
      d.factory.read.getRecordsImplementationByVersion([0n]),
      'InvalidVersion',
    );
    await assertRevertsNamed(
      d.factory.read.getRecordsImplementationByVersion([3n]),
      'InvalidVersion',
    );
  });

  it('createRecordsModule deploys at the prediction, records it, and is idempotent', async () => {
    await enableRecords(d);

    const predicted = await d.factory.read.recordsModuleAddress([d.safeA]);
    assert.notEqual(getAddress(predicted), getAddress(zeroAddress));
    same(await d.factory.read.recordsModule([d.safeA]), zeroAddress);

    // Permissionless, like the other two creates: the stranger pays the gas and
    // installs nothing.
    await d.factory.write.createRecordsModule([d.safeA], { account: d.stranger });

    same(await d.factory.read.recordsModule([d.safeA]), predicted);
    same(await d.factory.read.recordsModuleAddress([d.safeA]), predicted);

    // The proxy answers the real module's reads, so the factory-side
    // initializer ran with the right sender and the right Safe.
    const module = recordsAt(predicted);
    same(await module.read.safe(), d.safeA);
    same(await module.read.factory(), d.factory.address);
    assert.equal(await module.read.moduleKind(), RECORDS_KIND);

    // A retry returns the same module and deploys nothing.
    await d.factory.write.createRecordsModule([d.safeA]);
    same(await d.factory.read.recordsModule([d.safeA]), predicted);
    same(await d.factory.read.recordsModuleAddress([d.safeA]), predicted);
    const logs = await publicClient.getContractEvents({
      address: d.factory.address,
      abi: d.factory.abi,
      eventName: 'RecordsModuleCreated',
      args: { safe: d.safeA },
      fromBlock: 0n,
    });
    assert.equal(logs.length, 1);
    same(logs[0]!.args.moduleProxy!, predicted);
    same(logs[0]!.args.implementation!, d.recordsImplementation);

    // One per Safe: a second Safe gets a different module at a different address.
    const otherPrediction = await d.factory.read.recordsModuleAddress([d.safeB]);
    await d.factory.write.createRecordsModule([d.safeB]);
    same(await d.factory.read.recordsModule([d.safeB]), otherPrediction);
    assert.notEqual(getAddress(otherPrediction), getAddress(predicted));
    same(await recordsAt(otherPrediction).read.safe(), d.safeB);
  });

  it('createRecordsModule reverts with no implementation, and the prediction is zero', async () => {
    same(await d.factory.read.recordsModuleAddress([d.safeA]), zeroAddress);
    await assertRevertsNamed(
      d.factory.write.createRecordsModule([d.safeA]),
      'NoImplementation',
    );
    same(await d.factory.read.recordsModule([d.safeA]), zeroAddress);
  });

  it('a zero Safe is refused before any proxy exists', async () => {
    await enableRecords(d);
    await assertRevertsNamed(
      d.factory.write.createRecordsModule([zeroAddress]),
      'ZeroAddress',
    );
    same(await d.factory.read.recordsModule([zeroAddress]), zeroAddress);
  });

  it('isApproved and latestImplementation name the records kind and only the current implementation', async () => {
    same(await d.factory.read.latestImplementation([RECORDS_KIND]), zeroAddress);
    assert.equal(await d.factory.read.isApproved([RECORDS_KIND, zeroAddress]), false);

    await enableRecords(d);

    same(await d.factory.read.latestImplementation([RECORDS_KIND]), d.recordsImplementation);
    same(await d.factory.read.latestImplementation([DRAFTS_KIND]), zeroAddress);

    assert.equal(await d.factory.read.isApproved([RECORDS_KIND, d.recordsImplementation]), true);
    assert.equal(await d.factory.read.isApproved([RECORDS_KIND, d.safeA]), false);
    assert.equal(await d.factory.read.isApproved([RECORDS_KIND, zeroAddress]), false);
    assert.equal(await d.factory.read.isApproved([DRAFTS_KIND, d.recordsImplementation]), false);

    // Moving the pointer moves the approval: exactly one target per kind, so a
    // module can upgrade only to what the deployer set last.
    const next = await viem.deployContract('MockRecordsImplementation', [
      d.factory.address,
      RECORDS_KIND,
      ERC1967_IMPLEMENTATION_SLOT,
    ]);
    await d.factory.write.setRecordsImplementation([next.address]);

    assert.equal(await d.factory.read.isApproved([RECORDS_KIND, d.recordsImplementation]), false);
    assert.equal(await d.factory.read.isApproved([RECORDS_KIND, next.address]), true);
    same(await d.factory.read.latestImplementation([RECORDS_KIND]), next.address);
  });

  it('the records salt has no nonce: changing the implementation moves the predicted address', async () => {
    // The implementation is a proxy constructor argument, so it is part of the
    // init code hash. That is the one input that moves the records address, and
    // the create must land where the last prediction said.
    await enableRecords(d);
    const before = await d.factory.read.recordsModuleAddress([d.safeA]);

    const next = await viem.deployContract('MockRecordsImplementation', [
      d.factory.address,
      RECORDS_KIND,
      ERC1967_IMPLEMENTATION_SLOT,
    ]);
    await d.factory.write.setRecordsImplementation([next.address]);

    const after = await d.factory.read.recordsModuleAddress([d.safeA]);
    assert.notEqual(getAddress(after), getAddress(before));

    // The mock's initializer always reverts, so this call reverts
    // `InitializerFailed` — the point is that the failure leaves no record
    // behind and the prediction is stable.
    await assertRevertsNamed(
      d.factory.write.createRecordsModule([d.safeA]),
      'InitializerFailed',
    );
    same(await d.factory.read.recordsModule([d.safeA]), zeroAddress);
    same(await d.factory.read.recordsModuleAddress([d.safeA]), after);
  });
});
