// ============================================================================
// s2s publication new <name> — create a twin L1+L2 publication Safe + ENS.
//
// Ports neutralpress' createPublication via shared's newPublicationSafe, with
// two blank-slate host differences:
//   1. The Safe is an ERC-4337 smart account (permissionless + Pimlico
//      bundler/paymaster, all HTTP) — AD-1.
//   2. createFeed is a stub returning a zero address (Lens is not wired into
//      the headless CLI; documented follow-up).
// Requires --repo <owner/repo> (the publication's dev repository) and a
// bundler URL (S2S_BUNDLER_URL).
// ============================================================================

import {
  buildNewPublicationDeps,
  newPublicationSafe,
  type S2SPublication,
} from '@s2s/soul2soul-shared';
import { mainnet, base } from 'viem/chains';
import type { Hex } from 'viem';

import {
  S2SRecordsModule,
  S2SRecordsModuleFactory,
  S2SPublicationModuleV2Factory,
} from '../../../protocol/contracts/generated/abis';

import { createSafeRunner } from '../adapters/tx-runner';
import { flagList, flagString, type ParsedArgs } from '../lib/args';
import { UsageError } from '../lib/errors';
import type { CommandSpec } from '../lib/command';
import type { CliContext } from '../core/context';

const ENS_SUFFIX = '.soul2soul.eth';

export const newPublication: CommandSpec = {
  name: 'new',
  summary: 'Create a new publication (twin L1+L2 Safes + ENS subdomain + modules).',
  usage:
    's2s publication new <name> --repo <owner/repo> [--branch <b>] [--author <addr>...] [--owner <addr>...] [--json]',
  async run(ctx, args) {
    const name = requireName(args);
    const repo = requireRepo(args);
    const branch = flagString(args.flags, 'branch');
    const authors = flagList(args.flags, 'author');
    const owners = flagList(args.flags, 'owner');
    const bundlerUrl = ctx.config.bundler.baseUrl;
    if (!bundlerUrl) {
      throw new Error(
        '`new` needs an ERC-4337 bundler URL — set S2S_BUNDLER_URL (e.g. a Pimlico bundler endpoint).',
      );
    }

    const l1Rpc = ctx.rpcs.L1[0];
    const l2Rpc = ctx.rpcs.L2[0];
    if (!l1Rpc || !l2Rpc) throw new Error('missing L1/L2 RPC endpoints');

    ctx.out.log(`creating publication ${name} (Safe: ${ctx.eoaAddress})…`);

    const safeVersion: '1.4.1' | '1.5.0' = '1.4.1';
    const l1Runner = await createSafeRunner({
      chain: mainnet,
      rpcUrl: l1Rpc,
      privateKey: requirePrivateKey(ctx),
      bundlerUrl,
      paymasterUrl: ctx.config.bundler.paymasterUrl,
      entryPointVersion: ctx.config.bundler.entryPoint,
      safeVersion,
    });
    const l2Runner = await createSafeRunner({
      chain: base,
      rpcUrl: l2Rpc,
      privateKey: requirePrivateKey(ctx),
      bundlerUrl,
      paymasterUrl: ctx.config.bundler.paymasterUrl,
      entryPointVersion: ctx.config.bundler.entryPoint,
      safeVersion,
    });

    const publication: S2SPublication = {
      name,
      owners,
      authors: authors.length > 0 ? authors : [ctx.eoaAddress],
      devRepository: repo,
      branch: branch ?? '',
    };

    const deps = buildNewPublicationDeps({
      runners: { l1: l1Runner, l2: l2Runner },
      privateKey: requirePrivateKey(ctx),
      protocolInfo: ctx.protocolInfo,
      recordsModuleFactoryAbi: S2SRecordsModuleFactory,
      publicationModuleFactoryAbi: S2SPublicationModuleV2Factory,
      recordsModuleAbi: S2SRecordsModule,
      ipfs: ctx.ipfs,
      githubToken: ctx.config.githubToken ?? '',
      createFeed: createFeedStub,
    });

    await newPublicationSafe(deps, publication);

    ctx.out.result(
      {
        action: 'new',
        name,
        safeAddress: publication.contract,
        configCid: publication.configCid,
        owners: publication.owners,
        authors: publication.authors,
        devRepository: publication.devRepository,
        branch: publication.branch,
        feed: publication.feed,
      },
      [
        `Created publication ${name}`,
        `  safe (L1=L2) : ${publication.contract ?? '(unset)'}`,
        `  config       : ${publication.configCid ?? '(built by render pipeline)'}`,
        `  feed         : ${publication.feed ?? '(Lens feed not wired — zero-address stub)'}`,
      ].join('\n'),
    );
  },
};

// ===========================================================================
// Helpers
// ===========================================================================

function requireName(args: ParsedArgs): string {
  const raw = args.positionals[0];
  if (!raw) throw new UsageError('missing required argument: <name> (publication name)');
  const name = raw.includes('.') ? raw : `${raw}${ENS_SUFFIX}`;
  if (!name.endsWith(ENS_SUFFIX)) {
    throw new UsageError(`publication name must be under ${ENS_SUFFIX}`);
  }
  return name;
}

function requireRepo(args: ParsedArgs): string {
  const repo = flagString(args.flags, 'repo');
  if (!repo) {
    throw new UsageError('missing required flag: --repo <owner/repo> (dev repository)');
  }
  return repo;
}

function requirePrivateKey(ctx: CliContext): Hex {
  if (!ctx.config.privateKey) {
    throw new Error('missing required setting S2S_PRIVATE_KEY');
  }
  return ctx.config.privateKey as Hex;
}

/**
 * Lens feed creation is not wired into the headless CLI (the browser/obsidian
 * hosts talk to a Lens-compatible API with the owner session). The Safe is
 * created without a feed record; the zero address marks it explicitly.
 */
async function createFeedStub(_name: string, _desc: string, _safeAddr: string): Promise<string> {
  return await Promise.resolve('0x0000000000000000000000000000000000000000');
}
