// ============================================================================
// PublicationService — the CLI port of neutralpress' PublicationService.
//
// Resolves a publication's Safe (L1 ENS NameWrapper) and its Records +
// Publication module addresses (L2 Safe module sniffing) via the shared pure
// resolvers, then exposes the two author flows: `makeOffer` (append) and
// `retract` (author's own, terminal withdrawal) — both sent by the AUTHOR SAFE
// through ERC-4337 (`options.author`), because that is the identity the module
// keys the whitelist and `genesisAuthor` on. The EOA runner stays for reads.
// ============================================================================

import {
  resolvePublicationModules,
  resolvePublicationSafe,
  subdomainOf,
  toBytes32Id,
  type S2SIPFSMethods,
} from '@s2s/soul2soul-shared';
import { S2SRecordsModule, S2SPublicationModuleV2 } from '@s2s/publication-contracts';
import { BaseError, type Address, type Hex } from 'viem';
import type { TxRunner } from '@s2s/soul2soul-shared';
import { CliError } from '../lib/errors';

/** The PublicClient type that shared's chain-bound resolvers consume. */
type SharedPublicClient = Parameters<typeof resolvePublicationSafe>[0];

/**
 * The identity an author write is sent as: the author Safe, never the EOA.
 * `S2SPublicationModuleV2` keys everything (whitelist, `genesisAuthor`) on the
 * Safe address, so `makeOffer`/`retract` must arrive with the Safe as
 * `msg.sender` — which is what the ERC-4337 runner does.
 */
export interface AuthorWriteIdentity {
  /** The author Safe — msg.sender of `makeOffer`/`retract`. */
  address: Address;
  /** ERC-4337 runner bound to that Safe (permissionless + bundler). */
  runner: TxRunner;
}

export interface PublicationServiceOptions {
  /** L1 public client (Ethereum) — ENS resolution. */
  l1: SharedPublicClient;
  /** L2 public client (Base) — module reads. */
  l2: SharedPublicClient;
  /** EOA runner — reads only. Never used to send an author write. */
  l2Runner: TxRunner;
  /** ENS OpenSubdomainRegistry address (protocolInfo.ensRegistry). */
  ensRegistry: Address;
  /** IPFS client used to read on-chain publication config (localePaths). */
  ipfs: S2SIPFSMethods;
  /**
   * Required by `makeOffer`/`retract`, ignored by every read. Leaving it out is
   * what keeps `upload`/`preview` bundler-free; omitting it and then writing is
   * a programming error, not a user error.
   */
  author?: AuthorWriteIdentity;
}

export class PublicationService {
  readonly subdomain: string;
  readonly options: PublicationServiceOptions;
  safeAddress: Address | undefined;
  configModule: Address | undefined;
  publicationModule: Address | undefined;

  private constructor(options: PublicationServiceOptions, subdomain: string) {
    this.options = options;
    this.subdomain = subdomain;
  }

  static async init(options: PublicationServiceOptions, publication: string): Promise<PublicationService> {
    const service = new PublicationService(options, subdomainOf(publication));
    await service.resolve();
    return service;
  }

  /** Resolve Safe + module addresses (mirrors neutralpress init()). */
  private async resolve(): Promise<void> {
    const { address } = await resolvePublicationSafe(this.options.l1, this.options.ensRegistry, this.subdomain);
    this.safeAddress = address;

    const { configModule, publicationModule } = await resolvePublicationModules(this.options.l2, address);
    this.configModule = configModule;
    this.publicationModule = publicationModule;

    if (!publicationModule) {
      throw new Error(
        `No S2S publication module found on Safe ${address} (${this.subdomain}). Is the publication created and its modules enabled?`,
      );
    }
  }

  getMultiSig(): Address {
    if (!this.safeAddress) {
      throw new Error('PublicationService not resolved — call init() first');
    }
    return this.safeAddress;
  }

  /** Append a version (deal if the caller is a whitelisted author, else an offer). */
  async makeOffer(genesis: string, cid: string): Promise<string> {
    const module = this.requirePublicationModule();
    const author = this.requireAuthor();
    const id = toBytes32Id(genesis) as Hex;

    await this.simulateAuthorWrite(module, author, 'makeOffer', [id, cid]);
    return author.runner.genericTx(module, JSON.stringify(S2SPublicationModuleV2), 'makeOffer', [id, cid], false);
  }

  /**
   * Retract — the AUTHOR's verb, and terminal. On an agreement it ends the
   * genesis (tombstones the latest version, drops the agreement) so a later
   * `makeOffer`/`admit` reverts `Ended()`; on a bare offer it withdraws the
   * offer. The publication's reversible takedown is `reject`, a different verb
   * the author Safe has no authority to send.
   */
  async retract(genesis: string): Promise<string> {
    const module = this.requirePublicationModule();
    const author = this.requireAuthor();
    const id = toBytes32Id(genesis) as Hex;

    await this.simulateAuthorWrite(module, author, 'retract', [id]);
    return author.runner.genericTx(module, JSON.stringify(S2SPublicationModuleV2), 'retract', [id], false);
  }

  private requirePublicationModule(): Address {
    if (!this.publicationModule) throw new Error('PublicationService not resolved');
    return this.publicationModule;
  }

  private requireAuthor(): AuthorWriteIdentity {
    if (!this.options.author) {
      throw new Error(
        'internal: author write attempted without an author identity — pass options.author (the author Safe)',
      );
    }
    return this.options.author;
  }

  /**
   * Simulate an author write as the author Safe before sending it.
   *
   * Two reasons this is not optional. (1) viem never decodes revert data for a
   * raw `sendTransaction`, so a reverted `makeOffer` surfaces as "Execution
   * reverted for an unknown reason" — the exact message that hid a plain
   * `OnlySafe()`. `simulateContract` is abi-aware here, so the custom error is
   * decoded and named. (2) The eth_call sets `from` = the author Safe, which is
   * precisely `msg.sender` of the deployed userOp, so a whitelist/genesisAuthor
   * mismatch fails before gas is spent instead of after.
   */
  private async simulateAuthorWrite(
    module: Address,
    author: AuthorWriteIdentity,
    method: 'makeOffer' | 'retract',
    args: [Hex, string] | [Hex],
  ): Promise<void> {
    try {
      if (method === 'makeOffer') {
        await this.options.l2.simulateContract({
          address: module,
          abi: S2SPublicationModuleV2,
          functionName: 'makeOffer',
          args: args as [Hex, string],
          account: author.address,
        });
      } else {
        await this.options.l2.simulateContract({
          address: module,
          abi: S2SPublicationModuleV2,
          functionName: 'retract',
          args: args as [Hex],
          account: author.address,
        });
      }
    } catch (err) {
      const reason = err instanceof BaseError ? err.shortMessage : String(err);
      throw new CliError(
        `${method} from the author Safe ${author.address} would revert — ${reason}\n` +
          '  The author identity is the Safe: it must be whitelisted on the publication (whitelistAuthor),\n' +
          '  and it must be the genesis author of anything it edits.',
      );
    }
  }

  /**
   * Read the publication's real on-chain `localePaths` (Records module
   * `getRecord('config')` → config CID → fetched mapping) so the revoke
   * remove-path reproduces the renderer's `createPath` prefix exactly.
   * Returns undefined when the config can't be resolved (caller falls back to
   * the legacy scheme + caveat rather than aborting the revoke).
   */
  async localePathsOf(): Promise<Record<string, string> | undefined> {
    if (!this.configModule) return undefined;
    try {
      const configCid = (await this.options.l2Runner.genericRead(
        this.configModule,
        JSON.stringify(S2SRecordsModule),
        'getRecord',
        ['config'],
      )) as string;
      if (!configCid) return undefined;

      const config = (await this.options.ipfs.fetchFromKubo(configCid)) as
        | { Type?: string; localePaths?: Record<string, string>; mapping?: { localePaths?: Record<string, string> } }
        | undefined;
      if (!config || config.Type === 'error') return undefined;

      return config.localePaths ?? config.mapping?.localePaths;
    } catch {
      return undefined;
    }
  }
}
