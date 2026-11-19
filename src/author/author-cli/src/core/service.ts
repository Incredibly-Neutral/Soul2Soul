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
  MANIFEST_VERSION_KEY,
  resolvePublicationModules,
  resolvePublicationSafe,
  subdomainOf,
  toBytes32Id,
  type S2SManifest,
  type S2SIPFSMethods,
} from '@s2s/soul2soul-shared';
import { S2SRecordsModuleV0_1, S2SPublicationModuleV0_1 } from '@s2s/publication-contracts';
import { BaseError, type Address, type Hex } from 'viem';
import type { TxRunner } from '@s2s/soul2soul-shared';
import { CliError } from '../lib/errors';

/** The PublicClient type that shared's chain-bound resolvers consume. */
type SharedPublicClient = Parameters<typeof resolvePublicationSafe>[0];

/**
 * Whether an author Safe's append lands in the publication's agreements.
 *
 * `makeOffer` admits only two senders straight into the agreement set: the
 * publication Safe, and a whitelisted author. Everyone else's append is an
 * offer, which the site does not serve until the publication admits it.
 */
export type AuthorListing =
  | { listed: true; via: 'publication-safe' | 'whitelist' }
  | { listed: false };

/**
 * The identity an author write is sent as: the author Safe, never the EOA.
 * `S2SPublicationModuleV0_1` keys everything (whitelist, `genesisAuthor`) on the
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
  /**
   * The manifest version this publication pins (`manifest_version` on its
   * records module), or undefined when it pins none.
   *
   * The protocol's current document is not the publication's: a release goes
   * live for a publication when that publication's pin moves, and an action CID
   * is only what this publication runs if its pin names the version carrying it.
   */
  manifestVersion: string | undefined;

  /** The document `manifestVersion` names. Read once, by `manifestFor`. */
  pinnedManifest: S2SManifest | undefined;

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

    // A publication that pins no version runs the protocol's current document;
    // an unreadable record is the same answer, not a failure — nothing downstream
    // needs the pin to be readable.
    if (configModule) {
      try {
        const [pinned] = (await this.options.l2.readContract({
          address: configModule,
          abi: S2SRecordsModuleV0_1,
          functionName: 'getRecord',
          args: [MANIFEST_VERSION_KEY],
        } as never)) as unknown as [string];
        this.manifestVersion = pinned && pinned.trim() !== '' ? pinned.trim() : undefined;
      } catch {
        this.manifestVersion = undefined;
      }
    }
  }

  getMultiSig(): Address {
    if (!this.safeAddress) {
      throw new Error('PublicationService not resolved — call init() first');
    }
    return this.safeAddress;
  }

  /**
   * Whether an append from `author` becomes an agreement, mirroring the two
   * branches of the module's `makeOffer` — no more, because there is no other
   * way into the agreement set.
   *
   * An existing agreement does not help an author who is no longer
   * whitelisted: `makeOffer` suspends it, moves the document back to the offer
   * set, and the site stops serving it. So a document's current standing is not
   * asked, and the answer is `listed: false` for that author.
   *
   * Reads go through the EOA runner, never the author runner: this is a view,
   * and every bundler dependency would be paid for nothing. Errors propagate —
   * the caller decides whether an unreadable chain blocks the write.
   */
  async authorListing(author: Address): Promise<AuthorListing> {
    if (author.toLowerCase() === this.getMultiSig().toLowerCase()) {
      return { listed: true, via: 'publication-safe' };
    }

    const whitelisted = (await this.options.l2Runner.genericRead(
      this.requirePublicationModule(),
      JSON.stringify(S2SPublicationModuleV0_1),
      'isWhitelistedAuthor',
      [author],
    )) as boolean;

    return whitelisted ? { listed: true, via: 'whitelist' } : { listed: false };
  }

  /** Append a version (deal if the caller is a whitelisted author, else an offer). */
  async makeOffer(genesis: string, cid: string): Promise<string> {
    const module = this.requirePublicationModule();
    const author = this.requireAuthor();
    const id = toBytes32Id(genesis) as Hex;

    await this.simulateAuthorWrite(module, author, 'makeOffer', [id, cid]);
    return author.runner.genericTx(module, JSON.stringify(S2SPublicationModuleV0_1), 'makeOffer', [id, cid], false);
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
    return author.runner.genericTx(module, JSON.stringify(S2SPublicationModuleV0_1), 'retract', [id], false);
  }

  /**
   * Is this genesis already out of both sets on-chain?
   *
   * `retract` removes the agreement (or the offer) and nothing outside the
   * module can put it back, so both false means the retract already happened.
   * A revoke that stopped at the retract (site removal failed, process killed)
   * is re-runnable from the removal half: sending `retract` again reverts with
   * "not an agreement or offer", which is a dead end for the caller, not a
   * permission problem.
   */
  async isSpent(genesis: string): Promise<boolean> {
    const module = this.requirePublicationModule();
    const id = toBytes32Id(genesis) as Hex;
    const abi = JSON.stringify(S2SPublicationModuleV0_1);
    const [agreement, offer] = await Promise.all([
      this.options.l2Runner.genericRead(module, abi, 'hasAgreement', [id]) as Promise<boolean>,
      this.options.l2Runner.genericRead(module, abi, 'hasOffer', [id]) as Promise<boolean>,
    ]);
    return agreement === false && offer === false;
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
          abi: S2SPublicationModuleV0_1,
          functionName: 'makeOffer',
          args: args as [Hex, string],
          account: author.address,
        });
      } else {
        await this.options.l2.simulateContract({
          address: module,
          abi: S2SPublicationModuleV0_1,
          functionName: 'retract',
          args: args as [Hex],
          account: author.address,
        });
      }
    } catch (err) {
      const reason = err instanceof BaseError ? err.shortMessage : String(err);
      // `Ended()` is not a permissions problem and has one cause: the genesis
      // was retracted (the author's terminal verb). Saying "not whitelisted"
      // here would send the user to fix the wrong thing, after the upload.
      if (/\bEnded\b/.test(reason)) {
        throw new CliError(
          `${method} from the author Safe ${author.address} would revert with Ended(): this genesis is spent.\n` +
            '  It was retracted (revoke) or the publication ended it for good, and nothing re-opens it.\n' +
            '  Publish the content as a new note: a new note gets a new genesis.',
        );
      }
      throw new CliError(
        `${method} from the author Safe ${author.address} would revert — ${reason}\n` +
          '  The author identity is the Safe: it must be whitelisted on the publication (whitelistAuthor),\n' +
          '  and it must be the genesis author of anything it edits.',
      );
    }
  }
}
