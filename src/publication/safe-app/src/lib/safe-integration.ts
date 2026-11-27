// src/lib/safe-integration.ts
import { Abi_S2SRecordsModuleV0_1 } from '@s2s/publication-contracts/abis/S2SRecordsModuleV0_1';
import { Abi_S2SPublicationModuleV0_1 } from '@s2s/publication-contracts/abis/S2SPublicationModuleV0_1';

import { toBytes32Id } from '@s2s/soul2soul-shared';
import {
  S2S_MODULE_KIND_PUBLICATION,
  S2S_MODULE_KIND_RECORDS,
} from '@s2s/soul2soul-shared/safe-app';

import { moduleAddressFor, type FactoryRead } from './publication-init';

import type { SafeInfo, EthersContract } from '@/types';
import SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { SafeAppProvider } from '@safe-global/safe-apps-provider';
import { getRpcUrl } from './evm';

/**
 * The address a contract wrapper was constructed with (ethers v6 `target`).
 *
 * Tx payloads must take their `to:` from here, never from `safeInfo`: that
 * snapshot is exactly what went stale in the step-3 crash (`to: ''` →
 * `invalid address`), and `target` is the address the ABI was bound to, so a
 * payload can never be built for a different module than the one that encoded
 * it.
 */
function contractAddress(module: unknown): string {
  const target = (module as { target?: unknown } | null)?.target;
  return typeof target === 'string' ? target : '';
}

/**
 * The wrapper for the address the factory answered for one kind, given whatever
 * wrapper discovery already had.
 *
 * - The Safe lists the address: bind it. That is the module this Safe runs.
 * - The Safe used to list the address we had and no longer does: drop it. A
 *   reset removed the module, and a wrapper the Safe no longer runs makes
 *   `hasRecordsModule()` lie and every write revert.
 * - Otherwise keep what we had, including the address the factory answers
 *   before the enable lands: the create executed and the enable has not, which
 *   is exactly the state the init flow proposes both out of.
 */
function moduleWrapper(
  existing: EthersContract | null,
  address: string,
  abi: unknown,
  provider: unknown,
  isListed: (address: string) => boolean,
  wasListed: (address: string) => boolean,
): EthersContract | null {
  const known = contractAddress(existing);
  if (isListed(address)) {
    return new window.ethers.Contract(address, abi, provider) as EthersContract;
  }
  if (known && wasListed(known) && !isListed(known)) return null;
  return existing;
}

/**
 * The slice of the EIP-6963 `eip6963:announceProvider` detail this app reads.
 * The provider itself is opaque: it is handed to ethers, never inspected or
 * picked by wallet name.
 */
interface Eip6963AnnouncementDetail {
  provider?: unknown;
}

/** How long EIP-6963 discovery waits for an announcement before giving up. */
const EIP6963_DISCOVERY_MS = 400;

const NO_INJECTED_PROVIDER =
  'No injected EIP-1193 provider found: window.ethereum is undefined and no wallet answered ' +
  'EIP-6963 discovery. Open this app in a wallet that injects a provider or announces one over ' +
  'EIP-6963 (for example the Freedom browser), then reload.';

/**
 * Providers already resolved on this page, keyed by `window`. A reload gets a
 * fresh window and re-discovers; the first publish pays the discovery cost and
 * every later render reuses the answer.
 */
const signerProviderCache = new WeakMap<object, Promise<unknown>>();

function hasInjectedProvider(): boolean {
  // ethers' BrowserProvider rejects anything without `request`; a truthy
  // non-provider here would fail every publish and skip EIP-6963 for the page.
  return typeof window.ethereum?.request === 'function';
}

/**
 * Ask every EIP-6963 wallet to announce itself and take the first provider that
 * answers. Wallets announce on load, but the app may mount after that, so the
 * request event asks for a re-announcement. First announcement wins.
 */
function discoverEip6963Provider(): Promise<unknown> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;

    function settle(provider: unknown) {
      window.removeEventListener('eip6963:announceProvider', onAnnounce as EventListener);
      clearTimeout(timer);
      resolve(provider);
    }

    function onAnnounce(event: Event) {
      const provider = (event as CustomEvent<Eip6963AnnouncementDetail>).detail?.provider;
      if (provider !== null && provider !== undefined) settle(provider);
    }

    window.addEventListener('eip6963:announceProvider', onAnnounce as EventListener);
    timer = setTimeout(() => settle(null), EIP6963_DISCOVERY_MS);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  });
}

function findSignerProvider(): Promise<unknown> {
  if (hasInjectedProvider()) return Promise.resolve(window.ethereum);

  return discoverEip6963Provider().then((provider) => {
    if (provider === null || provider === undefined) throw new Error(NO_INJECTED_PROVIDER);
    return provider;
  });
}

/**
 * The EIP-1193 provider that signs Lit Actions auth messages: the injected one
 * when present, otherwise the first EIP-6963 announcement.
 */
function signerProvider(): Promise<unknown> {
  if (typeof window === 'undefined') return Promise.reject(new Error(NO_INJECTED_PROVIDER));

  const key = window;
  const cached = signerProviderCache.get(key);
  if (cached) return cached;

  const pending = findSignerProvider();
  signerProviderCache.set(key, pending);
  // A failed discovery is not cached: the next publish may retry.
  pending.catch(() => signerProviderCache.delete(key));
  return pending;
}

export class SafeIntegration {
  private safeSdk: SafeAppsSDK | null = null;
  public recordsModule: EthersContract | null = null;
  public publicationModule: any | null = null;
  /**
   * `publication_factory` from the protocol record — the one factory every
   * module of every kind is created through, set once the record is read.
   *
   * It is the only source of a module address. While it is empty no module is
   * discovered at all: there is no scan of the Safe's module list, no NAME()
   * probe and no second factory to fall back to.
   */
  private moduleFactory = '';
  private safeInfo: SafeInfo = {
    safeAddress: '',
    s2sRecords: '',
    s2sPublication: '',
    chainId: 1,
    network: '',
    owners: [],
    threshold: 1,
    modules: [],
  };

  /**
   * Read the Safe, discover the S2S modules and publish the result.
   *
   * ATOMIC and NON-DESTRUCTIVE by construction: discovery accumulates into
   * LOCALS and `this.recordsModule` / `this.publicationModule` / `this.safeInfo`
   * are assigned once, at the end. Nothing on `this` is mutated in between.
   *
   * This is the fix for the step-3 crash: `initialize()` used to write
   * `safeInfo = { s2sRecords: '', s2sPublication: '', ... }` up front and fill
   * the addresses in inside the awaited discovery loop, so any read that landed
   * in that window (`setRecord`'s `to:`, a second overlapping `fetchFreshData`,
   * the page's very first records fetch) saw a known module with an empty
   * address and proposed a tx to `''`. Overlapping calls are now harmless: each
   * computes a complete snapshot and publishes it whole.
   *
   * DISCOVERY IS TWO READS. The factory derives a module's address from
   * (factory, safe, kind), so the address of each kind is asked for, not
   * searched for:
   *
   *   moduleAddress(safe, publicationKind)
   *   moduleAddress(safe, recordsKind)
   *
   * No module list scan, no NAME() probe, no factory log filter, no second
   * factory. A module is bound when the Safe LISTS the address it was given
   * (anything else would be a wrapper whose every write reverts). One case
   * keeps an existing wrapper: an address this factory answered before and the
   * Safe does not list yet — the create ran and the enable has not, which is
   * the init flow's own in-between state (see `adoptModules`).
   *
   * With no module factory known, nothing is discovered and nothing is cleared:
   * the record has not been read yet, or this deployment predates the factory.
   * Guessing here is what the deleted NAME() scan did.
   */
  async initialize(): Promise<SafeInfo> {
    try {
      if (typeof SafeAppsSDK === 'undefined') {
        throw new Error('SafeAppsSDK not available');
      }

      const opts = {
        allowedDomains: [/app\.safe\.global$/],
        debug: false,
      };

      this.safeSdk = new SafeAppsSDK(opts);
      const safeData: any = await this.safeSdk!.safe.getInfo();

      const modules: string[] = safeData.modules ?? [];
      const prevModules = this.safeInfo?.modules ?? [];
      const isListed = (address: string) =>
        modules.some((m) => (m ?? '').toLowerCase() === address.toLowerCase());
      const wasListed = (address: string) =>
        prevModules.some((m) => (m ?? '').toLowerCase() === address.toLowerCase());

      // Discovery locals — `this` is untouched until the end.
      let recordsModule: EthersContract | null = this.recordsModule;
      let publicationModule: any | null = this.publicationModule;

      const rpcUrl = getRpcUrl(safeData.chainId);
      const provider = new window.ethers.JsonRpcProvider(rpcUrl);

      if (this.moduleFactory && safeData.safeAddress) {
        const read = this.factoryRead(safeData.chainId);
        const [recordsAddress, publicationAddress] = await Promise.all([
          moduleAddressFor(
            { read },
            this.moduleFactory,
            safeData.safeAddress,
            S2S_MODULE_KIND_RECORDS,
          ),
          moduleAddressFor(
            { read },
            this.moduleFactory,
            safeData.safeAddress,
            S2S_MODULE_KIND_PUBLICATION,
          ),
        ]);

        recordsModule = moduleWrapper(
          recordsModule,
          recordsAddress,
          Abi_S2SRecordsModuleV0_1,
          provider,
          isListed,
          wasListed,
        );
        publicationModule = moduleWrapper(
          publicationModule,
          publicationAddress,
          Abi_S2SPublicationModuleV0_1,
          provider,
          isListed,
          wasListed,
        );
        console.log(
          `[si] modules by factory ${this.moduleFactory}: records ${recordsModule ? recordsAddress : 'none'}, publication ${publicationModule ? publicationAddress : 'none'}`,
        );
      } else {
        console.log('[si] no module factory known — no module discovered');
      }

      // Single, complete publication of the discovery result. The addresses in
      // safeInfo are DERIVED from the contracts, so "known module, empty
      // address" is not representable.
      this.recordsModule = recordsModule;
      this.publicationModule = publicationModule;
      this.safeInfo = {
        safeAddress: safeData.safeAddress,
        s2sRecords: contractAddress(recordsModule),
        s2sPublication: contractAddress(publicationModule),
        chainId: safeData.chainId,
        network: safeData.network,
        modules,
        owners: safeData.owners,
        threshold: safeData.threshold,
      };

      return this.safeInfo;
    } catch (error) {
      console.error('Failed to initialize Safe SDK:', error);
      return this.safeInfo;
    }
  }

  // ===== GENERIC SAFE PRIMITIVES (module-install / init flow, SPEC-author-hosts AD-3) =====
  // These are runtime-agnostic Safe-side building blocks. The orchestration
  // layer (publication-init) injects them as deps and never imports this file's
  // host internals.

  /**
   * Propose an arbitrary batch of txs to the Safe for owner confirmation.
   * Used to install the records + publication modules in a single proposal
   * (SPEC-author-hosts AD-3 step 3). Returns the Safe UI queue URL.
   */
  async proposeBatch(txs: Array<{ to: string; value: string; data: string }>): Promise<string> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }

    await this.safeSdk.txs.send({ txs });

    const safeUrl = `https://app.safe.global/transactions/queue?safe=${this.safeInfo.chainId}:${this.safeInfo.safeAddress}`;

    console.log('Transaction batch proposed. Execute at:', safeUrl);

    return safeUrl;
  }

  /** Fresh JSON-RPC provider for the Safe's chain (same pattern as initialize). */
  getProvider() {
    const rpcUrl = getRpcUrl(this.safeInfo.chainId);
    return new window.ethers.JsonRpcProvider(rpcUrl);
  }

  /**
   * Size in bytes of the code deployed at `address` on `chainId` (the Safe's
   * chain by default; pass 1 to check whether the same address is a Safe on
   * mainnet). 0 when the account has no contract.
   *
   * The init flow uses this to prove the module factories exist on the chain
   * the Safe lives on BEFORE proposing the create batch. A call to an address
   * with no code does not revert: the Safe tx SUCCEEDS as a no-op, nothing is
   * deployed, and no ModuleCreated log is ever emitted — so the flow would poll
   * for a deployment that can never happen. The factories are read from
   * on-chain protocol state through the Base provider (shared/src/protocol), so
   * pointing them at another chain (e.g. a mainnet Safe) is exactly that case.
   */
  async contractCodeSize(address: string, chainId?: number): Promise<number> {
    const provider =
      chainId === undefined ? this.getProvider() : this.evmSetup(address, [], chainId).provider;
    const code: string = await provider.getCode(address);
    // eth_getCode returns '0x' for an account without code: 2 hex chars per
    // byte once the 0x prefix is dropped.
    return Math.max(0, (code.length - 2) / 2);
  }

  /**
   * Record the module factory — `publication_factory` in the protocol record.
   * Called by the host as soon as the record is read. Before that point there
   * is no factory, so discovery finds nothing (it does not guess); every later
   * initialize() asks this factory.
   */
  setModuleFactory(factory: string): void {
    this.moduleFactory = factory ?? '';
  }

  /** The module factory discovery reads, or '' while the record is unread. */
  getModuleFactory(): string {
    return this.moduleFactory;
  }

  /** A view read on a contract on a given chain, in the shape the lib takes. */
  private factoryRead(chainId: number): FactoryRead {
    return (factory, abi, method, args) => this.evmRead(chainId, factory, abi, method, args);
  }

  /**
   * The module this factory has for (safe, kind): the deployed one, or the
   * address a create deploys at. One read of `moduleAddress`, no probing.
   *
   * `safeAddress` defaults to the initialized Safe and `chainId` to its chain,
   * because the init flow asks before `safeInfo` is published in some paths.
   */
  async moduleAddress(safeAddress?: string, kind?: string, chainId?: number): Promise<string> {
    const factory = this.moduleFactory;
    const safe = safeAddress ?? this.safeInfo.safeAddress;
    const chain = chainId ?? this.safeInfo.chainId;
    if (!factory) {
      throw new Error(
        'No module factory is known — the publication_factory record has not been read.',
      );
    }
    if (!safe) throw new Error('No Safe address to ask the module factory about.');
    if (!kind) throw new Error('A module kind is required to ask the module factory.');
    return moduleAddressFor({ read: this.factoryRead(chain) }, factory, safe, kind);
  }

  /**
   * Current enabled-module list from the Safe (list order, for computing
   * disableModule prevModule). Fresh read via the SDK — not the possibly-stale
   * snapshot captured at initialize time.
   */
  async fetchSafeModules(): Promise<string[]> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const info = await this.safeSdk.safe.getInfo();
    return info.modules ?? [];
  }

  /** Read whether a module is enabled on the Safe (standard Safe function). */
  async readIsModuleEnabled(moduleAddress: string): Promise<boolean> {
    const provider = this.getProvider();
    const contract = new window.ethers.Contract(
      this.safeInfo.safeAddress,
      ['function isModuleEnabled(address) view returns (bool)'],
      provider,
    );
    return await contract.isModuleEnabled(moduleAddress);
  }

  /**
   * Adopt freshly-created module addresses mid-flow. `initialize()` binds only
   * what the Safe lists; during a fresh init the modules are deployed AFTER
   * that snapshot, so recordsModule/publicationModule stay null on this page
   * and the live finish-poll's getRecord would keep throwing ("Records module
   * not initialized") until a reload. Once the init flow learns the addresses
   * (a resumed session, or the `moduleAddress` poll) it hands them back here:
   * the wrappers are re-created so getRecord and the live finish detection work
   * without a reload, and hasRecordsModule/hasPublicationModule flip so the app
   * switches to its normal UI.
   *
   * The ABI is the kind's ABI — publication or records — with no NAME() probe: a
   * module deployed by the factory over `kind` is that kind, and its kind is what
   * the factory was asked for.
   */
  async adoptModules(recordsModule?: string, publicationModule?: string): Promise<void> {
    console.log(
      `[si] adoptModules r=${recordsModule ?? 'null'} p=${publicationModule ?? 'null'} (had r=${String(!!this.recordsModule)} p=${String(!!this.publicationModule)})`,
    );
    if (recordsModule && !this.recordsModule) {
      this.recordsModule = new window.ethers.Contract(
        recordsModule,
        Abi_S2SRecordsModuleV0_1,
        this.getProvider(),
      );
      if (this.safeInfo) this.safeInfo.s2sRecords = recordsModule;
    }
    if (publicationModule && !this.publicationModule) {
      this.publicationModule = new window.ethers.Contract(
        publicationModule,
        Abi_S2SPublicationModuleV0_1,
        this.getProvider(),
      );
      if (this.safeInfo) this.safeInfo.s2sPublication = publicationModule;
    }
  }

  // ===== RECORDS MODULE METHODS =====

  async getAllRecords(): Promise<[string[], string[]]> {
    if (this.recordsModule) {
      return await this.recordsModule.getAllRecords();
    }
    throw new Error('Records module not initialized');
  }

  async getRecord(key: string): Promise<string> {
    if (!this.recordsModule) {
      throw new Error('Records module not initialized');
    }

    try {
      const value = await this.recordsModule.getRecord(key);
      console.log(`[si] getRecord('${key}') -> '${value}'`);
      return value;
    } catch (error) {
      console.error(`Error getting record for key "${key}":`, error);
      throw error;
    }
  }

  /**
   * The records module, or a clear error. Also enforces that the wrapper knows
   * its own address: `to:` comes from `target`, never from `safeInfo` (whose
   * s2sRecords could be '' while the module was known — the step-3 crash).
   */
  private requireRecordsModule(): EthersContract {
    const module = this.recordsModule;
    if (!module || !contractAddress(module)) {
      throw new Error('records module not found on this Safe');
    }
    return module;
  }

  /** Same contract for the publication module. */
  private requirePublicationModule(): any {
    const module = this.publicationModule;
    if (!module || !contractAddress(module)) {
      throw new Error('publication module not found on this Safe');
    }
    return module;
  }

  async setRecord(key: string, value: string): Promise<string> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const recordsModule = this.requireRecordsModule();

    const txData = recordsModule.interface.encodeFunctionData('setRecord', [key, value]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(recordsModule),
          value: '0',
          data: txData,
        },
      ],
    });

    const safeUrl = `https://app.safe.global/transactions/queue?safe=${this.safeInfo.chainId}:${this.safeInfo.safeAddress}`;

    console.log('Transaction proposed. Execute at:', safeUrl);

    return safeUrl;
  }

  async deleteRecord(key: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const recordsModule = this.requireRecordsModule();

    const txData = recordsModule.interface.encodeFunctionData('deleteRecord', [key]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(recordsModule),
          value: '0',
          data: txData,
        },
      ],
    });
  }

  // ===== PUBLICATION MODULE — AGREEMENTS & OFFERS =====

  async makeOffer(genesis: string, cid: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();
    const txData = publicationModule.interface.encodeFunctionData('makeOffer', [
      toBytes32Id(genesis),
      cid,
    ]);
    await this.safeSdk.txs.send({
      txs: [{ to: contractAddress(publicationModule), value: '0', data: txData }],
    });
  }

  /**
   * Admit a pending offer → agreement. `admit` is the publication module's own
   * verb; there is no second name for it to pick between.
   */
  async admit(genesis: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();
    const txData = publicationModule.interface.encodeFunctionData('admit', [toBytes32Id(genesis)]);
    await this.safeSdk.txs.send({
      txs: [{ to: contractAddress(publicationModule), value: '0', data: txData }],
    });
  }

  /**
   * Reject — the Safe's reversible takedown. An agreement returns to the
   * pending offer set and an offer is declined; either may be admitted again,
   * unless the genesis author has since ended the publication (`retract` is the
   * author's own verb and is terminal, and `admit` then reverts `Ended()`).
   */
  async reject(genesis: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();
    const txData = publicationModule.interface.encodeFunctionData('reject', [toBytes32Id(genesis)]);
    await this.safeSdk.txs.send({
      txs: [{ to: contractAddress(publicationModule), value: '0', data: txData }],
    });
  }

  /** Is `genesis` an agreement (not merely an offer)? `hasAgreement` says. */
  async hasAgreement(genesis: string): Promise<boolean> {
    if (!this.publicationModule) throw new Error('Publication module not initialized');
    return await this.publicationModule.hasAgreement(toBytes32Id(genesis));
  }

  async getDeals(
    offset = 0,
    limit = 50,
  ): Promise<
    Array<{
      genesis: string;
      author: string;
      cid: string;
      timestamp: bigint;
    }>
  > {
    if (!this.publicationModule) throw new Error('Publication module not initialized');
    return await this.publicationModule.getAgreements(offset, limit);
  }

  async getOffers(
    offset = 0,
    limit = 50,
  ): Promise<
    Array<{
      genesis: string;
      author: string;
      cid: string;
      timestamp: bigint;
    }>
  > {
    if (!this.publicationModule) throw new Error('Publication module not initialized');
    return await this.publicationModule.getOffers(offset, limit);
  }

  async getAllDealsAndOffers(): Promise<{
    deals: Array<{
      genesis: string;
      author: string;
      cid: string;
      timestamp: bigint;
      status: 'deal';
    }>;
    offers: Array<{
      genesis: string;
      author: string;
      cid: string;
      timestamp: bigint;
      status: 'offer';
    }>;
  }> {
    if (!this.publicationModule) throw new Error('Publication module not initialized');
    try {
      const [rawDeals, rawOffers] = await Promise.all([
        this.publicationModule.getAgreements(0, 200),
        this.publicationModule.getOffers(0, 200),
      ]);
      const deals = rawDeals.map((e: any) => ({
        genesis: e.genesis,
        author: e.author,
        cid: e.cid,
        timestamp: e.timestamp,
        status: 'deal' as const,
      }));
      const offers = rawOffers.map((e: any) => ({
        genesis: e.genesis,
        author: e.author,
        cid: e.cid,
        timestamp: e.timestamp,
        status: 'offer' as const,
      }));
      return { deals, offers };
    } catch (error) {
      console.error('Error getting deals and offers:', error);
      return { deals: [], offers: [] };
    }
  }

  // ===== PUBLICATION MODULE - WHITELISTS =====

  async whitelistAuthor(author: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();

    const txData = publicationModule.interface.encodeFunctionData('whitelistAuthor', [author]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(publicationModule),
          value: '0',
          data: txData,
        },
      ],
    });
  }

  async removeWhitelistedAuthor(author: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();

    const txData = publicationModule.interface.encodeFunctionData('removeWhitelistedAuthor', [
      author,
    ]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(publicationModule),
          value: '0',
          data: txData,
        },
      ],
    });
  }

  async whitelistDev(dev: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();

    const txData = publicationModule.interface.encodeFunctionData('whitelistDev', [dev]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(publicationModule),
          value: '0',
          data: txData,
        },
      ],
    });
  }

  async removeWhitelistedDev(dev: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();

    const txData = publicationModule.interface.encodeFunctionData('removeWhitelistedDev', [dev]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(publicationModule),
          value: '0',
          data: txData,
        },
      ],
    });
  }

  async addReviewer(reviewer: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();

    const txData = publicationModule.interface.encodeFunctionData('setReviewer', [reviewer, true]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(publicationModule),
          value: '0',
          data: txData,
        },
      ],
    });
  }

  async removeReviewer(reviewer: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();

    const txData = publicationModule.interface.encodeFunctionData('setReviewer', [reviewer, false]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(publicationModule),
          value: '0',
          data: txData,
        },
      ],
    });
  }

  async getWhitelistedAuthors(): Promise<string[]> {
    if (!this.publicationModule) {
      throw new Error('Publication module not initialized');
    }
    return await this.publicationModule.getWhitelistedAuthors();
  }

  async getWhitelistedDevs(): Promise<string[]> {
    if (!this.publicationModule) {
      throw new Error('Publication module not initialized');
    }
    return await this.publicationModule.getWhitelistedDevs();
  }

  async getReviewers(): Promise<string[]> {
    if (!this.publicationModule) {
      throw new Error('Publication module not initialized');
    }
    return await this.publicationModule.getReviewers();
  }

  async canPublish(address: string): Promise<boolean> {
    if (!this.publicationModule) {
      throw new Error('Publication module not initialized');
    }
    return await this.publicationModule.canPublish(address);
  }

  // ===== UTILITY =====

  getSafeInfo(): SafeInfo {
    return this.safeInfo;
  }

  isConnected(): boolean {
    return this.safeSdk !== null;
  }

  hasRecordsModule(): boolean {
    return this.recordsModule !== null;
  }

  hasPublicationModule(): boolean {
    return this.publicationModule !== null;
  }

  evmSetup(contractAddress: string, abi: any, chainId: number) {
    let provider;
    const url = getRpcUrl(chainId);

    switch (chainId) {
      case 1:
        provider = new window.ethers.JsonRpcProvider(url);
        break;

      case 8453:
        provider = new window.ethers.JsonRpcProvider(url);
        break;

      case 84532:
        provider = new window.ethers.JsonRpcProvider(url);
        break;
    }

    const contract = new window.ethers.Contract(contractAddress, abi, provider);

    return { provider, contract };
  }

  async evmRead(chainId: number, l2records: string, abi: any, method: string, args: any[]) {
    const { provider, contract } = this.evmSetup(l2records, abi, chainId);
    return await contract[method](...args);
  }

  async signWithSigner(message: string): Promise<string> {
    const provider = new window.ethers.BrowserProvider(await signerProvider());
    const signer = await provider.getSigner();
    console.log('signer address', await signer.getAddress());
    return await signer.signMessage(message);
  }
}
