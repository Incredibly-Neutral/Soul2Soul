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
} from '@s2s/publication-contracts';

import { createSafeRunner } from '../adapters/tx-runner';
import { flagList, flagString, type ParsedArgs } from '../lib/args';
import { UsageError } from '../lib/errors';
import type { CommandSpec } from '../lib/command';
import type { CliContext } from '../core/context';
import { authorSafeState } from '../core/author-safe';
import { bundlerEndpoints } from '../core/config';

const ENS_SUFFIX = '.soul2soul.eth';

export const newPublication: CommandSpec = {
  name: 'new',
  summary: 'Create a new publication (twin L1+L2 Safes + ENS subdomain + modules).',
  params: '<name>',
  flags: {
    repo: {
      type: 'string',
      value: '<owner/repo>',
      summary: 'GitHub repo the publication renders from',
    },
    branch: { type: 'string', value: '<branch>', summary: 'branch to render from' },
    author: {
      type: 'string',
      value: '<addr>',
      repeatable: true,
      summary: 'author Safe address (repeatable, or comma-separated)',
    },
    owner: {
      type: 'string',
      value: '<addr>',
      repeatable: true,
      summary: 'publication Safe owner address (repeatable, or comma-separated)',
    },
  },
  async run(ctx, args) {
    const name = requireName(args);
    const repo = requireRepo(args);
    const branch = flagString(args.flags, 'branch');
    const authors = flagList(args.flags, 'author');
    const owners = flagList(args.flags, 'owner');
    // The EntryPoint version picks the Safe4337Module inside each Safe's
    // initializer — i.e. it is part of the Safe's address. 0.6 is only sane
    // for a bundler that cannot speak 0.7, and the plugin would then get a
    // different publication Safe, so say so out loud.
    if (ctx.config.entryPoint !== '0.7') {
      ctx.out.warn(
        `entryPoint ${ctx.config.entryPoint} — the publication Safes will not match the plugin (which pins 0.7)`,
      );
    }

    // Endpoints are per-chain: a Pimlico key yields one URL per chain id.
    const l1Endpoints = bundlerEndpoints(ctx.config, mainnet.id);
    const l2Endpoints = bundlerEndpoints(ctx.config, base.id);
    if (!l1Endpoints || !l2Endpoints) {
      throw new Error(
        '`new` needs an ERC-4337 bundler — set S2S_PIMLICO_KEY (or S2S_BUNDLER_URL).',
      );
    }

    const l1Rpc = ctx.rpcs.L1[0];
    const l2Rpc = ctx.rpcs.L2[0];
    if (!l1Rpc || !l2Rpc) throw new Error('missing L1/L2 RPC endpoints');

    // The author id is the author Safe (mirrors 0xobsidian's `user.safe`, which
    // neutralpress' new-publication modal pre-fills as the default author).
    const author = await authorSafeState(ctx);
    ctx.out.log(`creating publication ${name} (author ${author.address})…`);

    const safeVersion: '1.4.1' | '1.5.0' = '1.4.1';
    const l1Runner = await createSafeRunner({
      chain: mainnet,
      rpcUrl: l1Rpc,
      privateKey: requirePrivateKey(ctx),
      bundlerUrl: l1Endpoints.bundlerUrl,
      paymasterUrl: l1Endpoints.paymasterUrl,
      entryPointVersion: ctx.config.entryPoint,
      safeVersion,
    });
    const l2Runner = await createSafeRunner({
      chain: base,
      rpcUrl: l2Rpc,
      privateKey: requirePrivateKey(ctx),
      bundlerUrl: l2Endpoints.bundlerUrl,
      paymasterUrl: l2Endpoints.paymasterUrl,
      entryPointVersion: ctx.config.entryPoint,
      safeVersion,
    });

    const publication: S2SPublication = {
      name,
      owners,
      authors: authors.length > 0 ? authors : [author.address],
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
      githubToken: ctx.config.github.token ?? '',
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
