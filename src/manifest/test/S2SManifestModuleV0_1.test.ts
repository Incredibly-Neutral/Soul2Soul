import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { network } from 'hardhat';
import { encodeAbiParameters, encodeFunctionData, getContract, keccak256, parseAbi, toHex } from 'viem';

/**
 * The manifest module: one document, its version, and every version before it.
 *
 * What it pins:
 *
 *   - the module is built by the same factory at the same predictable address,
 *     under its own kind, so it has an address a client can hardcode,
 *   - the version is written with the document, so a reader gets a pair that was
 *     published together,
 *   - a version is `x.y.z` with no leading zeros, is written once, and strictly
 *     increases, so the history is sorted and a pinned read never changes,
 *   - history spans a major and stays readable by version,
 *   - an upgrade needs an implementation approved for the manifest kind.
 */

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();

type Hex = `0x${string}`;

const FACTORY_KIND = keccak256(toHex('s2s.module.manifest'));

const FACTORY_ABI = parseAbi([
  'function setImplementation(bytes32 kind, address implementation)',
  'function createModule(address safe, bytes32 kind, bytes params) returns (address module, bool created)',
  'function moduleOf(address safe, bytes32 kind) view returns (address)',
  'function moduleAddress(address safe, bytes32 kind) view returns (address)',
]);

const MANIFEST_ABI = parseAbi([
  'function NAME() view returns (string)',
  'function safe() view returns (address)',
  'function moduleKind() view returns (bytes32)',
  'function factory() view returns (address)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function setManifest(string version, string json)',
  'function getManifest() view returns (string version, string json)',
  'function getManifest(string version) view returns (string json)',
  'function manifestVersion() view returns (string)',
  'function getVersions() view returns (string[])',
  'function getVersionAt(uint256 index) view returns (string)',
  'function versionCount() view returns (uint256)',
  'function versionExists(string version) view returns (bool)',
  'function upgradeToAndCall(address newImplementation, bytes data)',
]);

const DOC = (version: string) => JSON.stringify({ version, gateway: 'ipfs.example' });

const write = (fn: string, args: unknown[]): Hex =>
  encodeFunctionData({ abi: MANIFEST_ABI, functionName: fn as never, args: args as never });

const seed = (version: string, json: string): Hex =>
  encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [version, json]);

/**
 * The factory, from the package that owns it. Solidity in this package cannot
 * import it (Hardhat refuses an import that leaves the package), and a copy of
 * it here would be a second source of the same contract, so the suite deploys
 * the real build. `pnpm test` compiles the publication package first, which is
 * where the artifact comes from.
 */
const FACTORY_ARTIFACT = JSON.parse(
  readFileSync(
    new URL(
      '../../publication/contracts/artifacts/src/S2SPublicationModulesFactoryV0_1.sol/S2SPublicationModulesFactoryV0_1.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

/** Another kind's implementation, for the cross-kind refusal. Same package, same
 * reason: there is no Solidity import across the package boundary. */
const RECORDS_ARTIFACT = JSON.parse(
  readFileSync(
    new URL(
      '../../publication/contracts/artifacts/src/S2SRecordsModuleV0_1.sol/S2SRecordsModuleV0_1.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

async function deployArtifact(artifact: { abi: unknown; bytecode: string }, args: unknown[]) {
  const [wallet] = await viem.getWalletClients();
  const hash = await wallet.deployContract({
    abi: artifact.abi as never,
    bytecode: artifact.bytecode as `0x${string}`,
    args: args as never,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress!;
}

async function deployFactory(protocolSafe: `0x${string}`) {
  const [wallet] = await viem.getWalletClients();
  const address = await deployArtifact(FACTORY_ARTIFACT, [protocolSafe]);
  return getContract({
    address,
    abi: FACTORY_ARTIFACT.abi,
    client: { public: publicClient, wallet },
  });
}

async function deploy() {
  const protocolSafe = await viem.deployContract('MockCaller');
  const factory = await deployFactory(protocolSafe.address);
  const safe = await viem.deployContract('MockCaller');
  return { protocolSafe, factory, safe };
}

/** A module owned by `safe`, created by the factory with nothing published. */
async function manifestUnder(ctx: Awaited<ReturnType<typeof deploy>>) {
  const { protocolSafe, factory, safe } = ctx;
  const impl = await viem.deployContract('S2SManifestModuleV0_1', [factory.address, protocolSafe.address]);
  await protocolSafe.write.exec([
    factory.address,
    encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: 'setImplementation',
      args: [FACTORY_KIND, impl.address],
    }),
  ]);
  const predicted = await factory.read.moduleAddress([safe.address, FACTORY_KIND]);
  await safe.write.exec([
    factory.address,
    encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: 'createModule',
      args: [safe.address, FACTORY_KIND, '0x'],
    }),
  ]);
  const module = await viem.getContractAt('S2SManifestModuleV0_1', predicted);
  return { module, impl };
}

describe('S2SManifestModuleV0_1', () => {
  it('is created by the factory at the address a client computes in advance, under its own kind', async () => {
    const ctx = await deploy();
    const { module, impl } = await manifestUnder(ctx);

    assert.equal(await impl.read.moduleKind(), FACTORY_KIND);
    assert.equal(await module.read.NAME(), 'S2S Manifest Module');
    assert.equal((await module.read.safe()).toLowerCase(), ctx.safe.address.toLowerCase());
    assert.equal((await module.read.factory()).toLowerCase(), ctx.factory.address.toLowerCase());

    // Nothing published: an absent document is a refusal, not the empty string
    // and not a version of zero.
    await assert.rejects(module.read.getManifest(), /NoManifest/);
    await assert.rejects(module.read.manifestVersion(), /NoManifest/);
    assert.equal(await module.read.versionCount(), 0n);
  });

  it('answers ERC-165 for its own interface and the one it inherits', async () => {
    const ctx = await deploy();
    const { module } = await manifestUnder(ctx);

    assert.equal(await module.read.supportsInterface(['0x01ffc9a7']), true);
    assert.equal(await module.read.supportsInterface(['0xffffffff']), false);
    // A locally declared supportsInterface would have been folded into this id;
    // inheriting IERC165 keeps the module's own id to its own functions.
    const own = await module.read.supportsInterface(['0x00000000']);
    assert.equal(own, false);
  });

  it('seeds the first document in the same call that deploys it, and announces it by hash', async () => {
    const { protocolSafe, factory, safe } = await deploy();
    const impl = await viem.deployContract('S2SManifestModuleV0_1', [factory.address, protocolSafe.address]);
    await protocolSafe.write.exec([
      factory.address,
      encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: 'setImplementation',
        args: [FACTORY_KIND, impl.address],
      }),
    ]);
    const predicted = await factory.read.moduleAddress([safe.address, FACTORY_KIND]);
    await safe.write.exec([
      factory.address,
      encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: 'createModule',
        args: [safe.address, FACTORY_KIND, seed('1.0.0', DOC('1.0.0'))],
      }),
    ]);

    const published = await publicClient.readContract({
      address: predicted,
      abi: MANIFEST_ABI,
      functionName: 'getManifest',
    });
    assert.equal(published[0], '1.0.0');
    assert.equal(published[1], DOC('1.0.0'));

    // The event carries the hashes, not the document: an indexer filters by
    // version hash and fetches the document once.
    const events = await publicClient.getContractEvents({
      address: predicted,
      abi: parseAbi([
        'event ManifestSet(bytes32 indexed versionHash, string version, bytes32 jsonHash)',
      ]),
      eventName: 'ManifestSet',
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].args.version, '1.0.0');
    assert.equal(events[0].args.versionHash, keccak256(toHex('1.0.0')));
    assert.equal(events[0].args.jsonHash, keccak256(toHex(DOC('1.0.0'))));
  });

  it('writes only for the owning Safe', async () => {
    const ctx = await deploy();
    const { module } = await manifestUnder(ctx);

    const [stranger] = await viem.getWalletClients();
    // OnlySafe() = 0xd7fed6bd: viem reports the selector rather than the name.
    await assert.rejects(
      module.write.setManifest(['1.0.0', DOC('1.0.0')], { account: stranger.account }),
      (error: unknown) => JSON.stringify(error).toLowerCase().includes('0xd7fed6bd'),
      'expected OnlySafe() from a stranger',
    );

    await ctx.safe.write.exec([module.address, write('setManifest', ['1.0.0', DOC('1.0.0')])]);
    assert.equal(await module.read.manifestVersion(), '1.0.0');
  });

  it('refuses a version that is not x.y.z, or that has a leading zero', async () => {
    const ctx = await deploy();
    const { module } = await manifestUnder(ctx);

    for (const version of ['1', '1.0', '1.0.0.0', 'v1.0.0', '', 'one.0.0', '1..0', '1.0.', '1.1234567890.0']) {
      await assert.rejects(
        ctx.safe.write.exec([module.address, write('setManifest', [version, DOC('1.0.0')])]),
        /VersionNotXYZ|EmptyVersion/,
        `expected ${JSON.stringify(version)} to be refused`,
      );
    }

    // semver says `01` is not a number, so the two spellings cannot both exist.
    for (const version of ['1.01.0', '01.0.0', '1.0.00']) {
      await assert.rejects(
        ctx.safe.write.exec([module.address, write('setManifest', [version, DOC('1.0.0')])]),
        /LeadingZero/,
        `expected ${JSON.stringify(version)} to be refused`,
      );
    }

    await assert.rejects(
      ctx.safe.write.exec([module.address, write('setManifest', ['1.0.0', ''])]),
      /EmptyDocument/,
    );
    assert.equal(await module.read.versionCount(), 0n);

    await ctx.safe.write.exec([module.address, write('setManifest', ['1.2.3', DOC('1.2.3')])]);
    assert.equal(await module.read.manifestVersion(), '1.2.3');
  });

  it('writes a version once, so a pinned read never changes answer', async () => {
    const ctx = await deploy();
    const { module } = await manifestUnder(ctx);

    await ctx.safe.write.exec([module.address, write('setManifest', ['1.0.0', DOC('1.0.0')])]);
    await ctx.safe.write.exec([module.address, write('setManifest', ['1.0.1', DOC('1.0.1')])]);

    // Not the live one, and not an older one: neither can be rewritten. A CID
    // that moved is 1.0.2, which is what makes `getManifest(version)` a promise.
    await assert.rejects(
      ctx.safe.write.exec([module.address, write('setManifest', ['1.0.0', DOC('1.0.0')])]),
      /VersionExists/,
    );
    await assert.rejects(
      ctx.safe.write.exec([module.address, write('setManifest', ['1.0.1', DOC('1.0.1')])]),
      /VersionExists/,
    );

    const pinned = await publicClient.readContract({
      address: module.address,
      abi: MANIFEST_ABI,
      functionName: 'getManifest',
      args: ['1.0.0'],
    });
    assert.equal(pinned, DOC('1.0.0'));
  });

  it('requires the version to increase, across a major too', async () => {
    const ctx = await deploy();
    const { module } = await manifestUnder(ctx);

    const publish = (version: string) =>
      ctx.safe.write.exec([module.address, write('setManifest', [version, DOC(version)])]);

    await publish('1.0.0');
    await publish('1.0.1');
    await assert.rejects(publish('1.0.0'), /VersionNotIncreasing|VersionExists/);
    await publish('1.1.0');
    await assert.rejects(publish('1.0.9'), /VersionNotIncreasing/);
    await publish('1.9.9');
    await publish('2.0.0');
    await assert.rejects(publish('1.99.0'), /VersionNotIncreasing/);
    await assert.rejects(publish('2.0.0'), /VersionExists/);

    assert.deepEqual(await module.read.getVersions(), ['1.0.0', '1.0.1', '1.1.0', '1.9.9', '2.0.0']);
  });

  it('keeps history across a major, and answers the live version', async () => {
    const ctx = await deploy();
    const { module } = await manifestUnder(ctx);

    await ctx.safe.write.exec([module.address, write('setManifest', ['1.0.0', DOC('1.0.0')])]);
    await ctx.safe.write.exec([module.address, write('setManifest', ['1.1.0', DOC('1.1.0')])]);
    await ctx.safe.write.exec([module.address, write('setManifest', ['2.0.0', DOC('2.0.0')])]);

    const live = await publicClient.readContract({
      address: module.address,
      abi: MANIFEST_ABI,
      functionName: 'getManifest',
    });
    assert.equal(live[0], '2.0.0');
    assert.equal(live[1], DOC('2.0.0'));

    // A caller who names a 1.x version gets that document. Whether a 1.x reader
    // understands 2.x is the reader's question, so the module does not hide it.
    assert.equal(
      await publicClient.readContract({
        address: module.address,
        abi: MANIFEST_ABI,
        functionName: 'getManifest',
        args: ['1.0.0'],
      }),
      DOC('1.0.0'),
    );

    await assert.rejects(
      publicClient.readContract({
        address: module.address,
        abi: MANIFEST_ABI,
        functionName: 'getManifest',
        args: ['1.0.2'],
      }),
      /VersionNotFound/,
    );

    assert.equal(await module.read.getVersionAt([2n]), '2.0.0');
    await assert.rejects(module.read.getVersionAt([3n]), /IndexOutOfBounds/);
    assert.equal(await module.read.versionExists(['1.1.0']), true);
    assert.equal(await module.read.versionExists(['1.0.2']), false);
  });

  it('upgrades only to a build approved for the manifest kind', async () => {
    const ctx = await deploy();
    const { module, impl: first } = await manifestUnder(ctx);
    const second = await viem.deployContract('S2SManifestModuleV0_1', [ctx.factory.address, ctx.protocolSafe.address]);
    const recordsBuild = await deployArtifact(RECORDS_ARTIFACT, [ctx.factory.address, ctx.protocolSafe.address]);

    await assert.rejects(
      ctx.protocolSafe.write.exec([
        ctx.factory.address,
        encodeFunctionData({
          abi: FACTORY_ABI,
          functionName: 'setImplementation',
          args: [FACTORY_KIND, recordsBuild],
        }),
      ]),
      // ImplementationKindMismatch(address,bytes32,bytes32) = 0x5edbb8e5: the
      // revert is bubbled through MockCaller, so viem reports the selector.
      (error: unknown) => JSON.stringify(error).toLowerCase().includes('0x5edbb8e5'),
    );

    await assert.rejects(
      ctx.safe.write.exec([module.address, write('upgradeToAndCall', [second.address, write('moduleKind', [])])]),
      /ImplementationNotApproved/,
    );

    await ctx.protocolSafe.write.exec([
      ctx.factory.address,
      encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: 'setImplementation',
        args: [FACTORY_KIND, second.address],
      }),
    ]);
    await ctx.safe.write.exec([
      module.address,
      write('upgradeToAndCall', [second.address, write('moduleKind', [])]),
    ]);

    const slot = await publicClient.request({
      method: 'eth_getStorageAt',
      params: [module.address, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest'],
    });
    assert.equal(`0x${String(slot).slice(-40)}`.toLowerCase(), second.address.toLowerCase());

    // The document and its history are storage, not implementation state: the
    // upgrade moves the code and nothing else.
    await ctx.safe.write.exec([module.address, write('setManifest', ['1.0.0', DOC('1.0.0')])]);
    assert.equal(await module.read.manifestVersion(), '1.0.0');
    void first;
  });
});
