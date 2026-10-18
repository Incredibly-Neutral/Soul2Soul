// ============================================================================
// PublicationService — the CLI port of neutralpress' PublicationService.
//
// Resolves a publication's Safe (L1 ENS NameWrapper) and its Records +
// Publication module addresses (L2 Safe module sniffing) via the shared pure
// resolvers, then exposes the two author flows: `makeOffer` (append) and
// `retract` (author-caller full withdrawal) — both sent through the L2 EOA
// runner (the Safe is the actor only for `new`/module installs, INV-10).
// ============================================================================

import {
  resolvePublicationModules,
  resolvePublicationSafe,
  subdomainOf,
  toBytes32Id,
  type S2SIPFSMethods,
} from '@s2s/soul2soul-shared';
import { S2SRecordsModule, S2SPublicationModuleV2 } from '../../../protocol/contracts/generated/abis';
import type { Address } from 'viem';
import type { TxRunner } from '@s2s/soul2soul-shared';

/** The PublicClient type that shared's chain-bound resolvers consume. */
type SharedPublicClient = Parameters<typeof resolvePublicationSafe>[0];

export interface PublicationServiceOptions {
  /** L1 public client (Ethereum) — ENS resolution. */
  l1: SharedPublicClient;
  /** L2 public client (Base) — module reads. */
  l2: SharedPublicClient;
  /** EOA TxRunner for author flows (makeOffer / retract). */
  l2Runner: TxRunner;
  /** ENS OpenSubdomainRegistry address (protocolInfo.ensRegistry). */
  ensRegistry: Address;
  /** IPFS client used to read on-chain publication config (localePaths). */
  ipfs: S2SIPFSMethods;
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
    if (!this.publicationModule) throw new Error('PublicationService not resolved');
    return this.options.l2Runner.genericTx(
      this.publicationModule,
      JSON.stringify(S2SPublicationModuleV2),
      'makeOffer',
      [toBytes32Id(genesis), cid],
      false,
    );
  }

  /** Retract — author-caller path fully withdraws (removed from deals and/or offers). */
  async retract(genesis: string): Promise<string> {
    if (!this.publicationModule) throw new Error('PublicationService not resolved');
    return this.options.l2Runner.genericTx(
      this.publicationModule,
      JSON.stringify(S2SPublicationModuleV2),
      'retract',
      [toBytes32Id(genesis)],
      false,
    );
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
