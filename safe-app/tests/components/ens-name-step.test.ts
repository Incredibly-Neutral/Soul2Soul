import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountLit } from '../helpers/mount';
import '../../src/components/ens-name-step';
import type { S2SEnsStep } from '../../src/components/ens-name-step';
import type { EnsRegistrationState } from '../../src/lib/ens-registration';
import {
  buildRegisterSubdomainCall,
  computeSubnode,
  SOUL2SOUL_SUFFIX,
} from '../../src/lib/ens-registration';
import {
  ENS_L1_CHAIN_ID,
  ENS_REGISTRY_ADDRESS,
  ZERO_ADDRESS,
} from '../../src/lib/domain-validation';
import { hasEnsProposal, markEnsProposal, safeAppUrl } from '../../src/lib/ens-step';

const SAFE = '0x79dedb19353F7909CDc68504839EF88a7498aaf2';
const OTHER_OWNER = '0x000000000000000000000000000000000000dEaD';
const APP_URL = 'https://s2s.example.test/app';

function registrationState(overrides: Partial<EnsRegistrationState> = {}): EnsRegistrationState {
  const label = overrides.label ?? 'polyphony';
  const parentNode = '0x' + '2'.repeat(64);
  return {
    label,
    name: `${label}.${SOUL2SOUL_SUFFIX}`,
    registry: ENS_REGISTRY_ADDRESS,
    nameWrapper: '0x00000000000000000000000000000000000000aa',
    parentWrapped: true,
    node: computeSubnode(parentNode, label),
    owner: ZERO_ADDRESS,
    registered: false,
    ownedBySafe: false,
    needsRegistration: true,
    desynced: false,
    ...overrides,
  };
}

/** L1 reads for the poll: every answer derives from `owner`/`registered`. */
function l1Read(options: { owner: string; registered: boolean }) {
  return async (
    _chainId: number,
    _contract: string,
    _abi: unknown,
    method: string,
  ): Promise<unknown> => {
    switch (method) {
      case 'parentNode':
        return '0x' + '2'.repeat(64);
      case 'isParentWrapped':
        return true;
      case 'nameWrapper':
        return '0x00000000000000000000000000000000000000aa';
      case 'registeredSubdomains':
        return options.registered;
      case 'ownerOf':
        return options.owner;
      default:
        throw new Error(`unexpected L1 read: ${method}`);
    }
  };
}

function fakeSafeIntegration(overrides: Record<string, unknown> = {}) {
  return {
    proposeBatch: vi.fn(async () => 'https://app.safe.global/transactions/queue?safe=eth:0x'),
    evmRead: l1Read({ owner: ZERO_ADDRESS, registered: false }),
    contractCodeSize: vi.fn(async () => 1),
    ...overrides,
  };
}

const CARD = '#ens-step';

describe('s2s-ens-step', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders nothing until the host has a registration read', async () => {
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: null,
      safeInfo: { chainId: 8453, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration(),
    });
    expect(el.shadowRoot?.querySelector(CARD)).toBeNull();
  });

  it('shows the name, reason and call on Base, with the mainnet deep link (no Propose)', async () => {
    const state = registrationState();
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state,
      safeInfo: { chainId: 8453, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration(),
      appUrl: APP_URL,
    });

    expect(el.shadowRoot?.querySelector(CARD)).toBeTruthy();
    expect(el.shadowRoot?.querySelector('#ens-name')?.textContent).toBe(state.name);
    expect(el.shadowRoot?.textContent).toContain('no ENS registration yet');

    const expected = buildRegisterSubdomainCall(ENS_REGISTRY_ADDRESS, 'polyphony', SAFE);
    expect(el.shadowRoot?.querySelector('[data-call="to"]')?.textContent).toBe(expected.to);
    expect(el.shadowRoot?.querySelector('[data-call="data"]')?.textContent).toBe(expected.data);

    const link = el.shadowRoot?.querySelector('#ens-open-l1') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.href).toBe(
      safeAppUrl({ chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE, appUrl: APP_URL }),
    );
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(el.shadowRoot?.querySelector('#ens-propose')).toBeNull();
  });

  it('proposes once on chain 1 and flips to waiting', async () => {
    const integration = fakeSafeIntegration();
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: integration,
      pollIntervalMs: 100_000,
    });

    const button = el.shadowRoot?.querySelector('#ens-propose') as HTMLElement;
    expect(button).toBeTruthy();
    button.click();

    const expected = buildRegisterSubdomainCall(ENS_REGISTRY_ADDRESS, 'polyphony', SAFE);
    await vi.waitFor(() =>
      expect(integration.proposeBatch).toHaveBeenCalledWith([
        { to: expected.to, value: '0', data: expected.data },
      ]),
    );
    await el.updateComplete;

    expect(hasEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS)).toBe(true);
    expect(el.shadowRoot?.querySelector('#ens-propose')).toBeNull();
    expect(
      (el.shadowRoot?.querySelector('#ens-queue') as HTMLAnchorElement | null)?.href,
    ).toContain('/transactions/queue');
    expect(el.shadowRoot?.textContent).toContain('Waiting for the Safe transaction');
  });

  it('offers the mainnet hop while waiting on a non-L1 Safe', async () => {
    markEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS);
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: 8453, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration(),
      appUrl: APP_URL,
      pollIntervalMs: 100_000,
    });

    expect(el.shadowRoot?.textContent).toContain('Waiting for the Safe transaction');
    const link = el.shadowRoot?.querySelector('#ens-open-l1') as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
    expect(link?.href).toBe(
      safeAppUrl({ chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE, appUrl: APP_URL }),
    );
    expect(el.shadowRoot?.querySelector('#ens-retry')).toBeNull();
  });

  it('keeps the mainnet hop after the timeout on a non-L1 Safe', async () => {
    markEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS);
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: 8453, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration(),
      appUrl: APP_URL,
      pollIntervalMs: 5,
      pollTimeoutMs: 20,
    });

    await vi.waitFor(() =>
      expect(el.shadowRoot?.textContent).toContain('still pending in the Safe queue'),
    );
    expect(el.shadowRoot?.querySelector('#ens-open-l1')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('#ens-retry')).toBeNull();
  });

  it('re-reads the marker when the publication label changes', async () => {
    markEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS);
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration(),
      pollIntervalMs: 100_000,
    });
    expect(el.shadowRoot?.querySelector('#ens-propose')).toBeNull();

    el.state = registrationState({ label: 'polyphony2' });
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#ens-propose')).toBeTruthy());
    expect(el.shadowRoot?.textContent).not.toContain('Waiting for the Safe transaction');
  });

  it('clears the old label’s timeout, error and queue link on a scope change', async () => {
    markEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS);
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration(),
      pollIntervalMs: 5,
      pollTimeoutMs: 20,
    });
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#ens-retry')).toBeTruthy());

    el.state = registrationState({ label: 'polyphony2' });
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#ens-propose')).toBeTruthy());
    expect(el.shadowRoot?.querySelector('#ens-retry')).toBeNull();
    expect(el.shadowRoot?.querySelector('#ens-retry-warning')).toBeNull();
    expect(el.shadowRoot?.textContent).not.toContain('still pending in the Safe queue');
  });

  it('does not carry the old queue link into another waiting label', async () => {
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration(),
      pollIntervalMs: 5,
      pollTimeoutMs: 20,
    });

    (el.shadowRoot?.querySelector('#ens-propose') as HTMLElement).click();
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#ens-queue')).toBeTruthy());
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#ens-retry')).toBeTruthy());

    // The new label has its own marker (waiting), but its queue URL is unknown:
    // the previous label's link must not be shown for it.
    markEnsProposal(window.localStorage, SAFE, 'polyphony2', ENS_REGISTRY_ADDRESS);
    el.state = registrationState({ label: 'polyphony2' });
    await vi.waitFor(() =>
      expect(el.shadowRoot?.textContent).toContain('Waiting for the Safe transaction'),
    );
    expect(el.shadowRoot?.querySelector('#ens-queue')).toBeNull();
    expect(el.shadowRoot?.querySelector('#ens-retry')).toBeNull();
  });

  it('never proposes twice, even on a double click', async () => {
    let resolveProposal!: (url: string) => void;
    const proposeBatch = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveProposal = resolve;
        }),
    );
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration({ proposeBatch }),
      pollIntervalMs: 100_000,
    });

    const button = el.shadowRoot?.querySelector('#ens-propose') as HTMLElement;
    button.click();
    button.click();
    await vi.waitFor(() => expect(proposeBatch).toHaveBeenCalledTimes(1));

    resolveProposal('https://app.safe.global/transactions/queue?safe=eth:0x');
    await el.updateComplete;
    expect(proposeBatch).toHaveBeenCalledTimes(1);
  });

  it('does not offer Propose when a proposal is already persisted', async () => {
    markEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS);
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration(),
      pollIntervalMs: 100_000,
    });

    expect(el.shadowRoot?.querySelector('#ens-propose')).toBeNull();
    expect(el.shadowRoot?.textContent).toContain('Waiting for the Safe transaction');
  });

  it('hides itself and emits s2s-ens-done when the subnode becomes owned by the Safe', async () => {
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration(),
      pollIntervalMs: 100_000,
    });
    const done = vi.fn();
    el.addEventListener('s2s-ens-done', done);

    el.state = registrationState({
      registered: true,
      owner: SAFE.toLowerCase(),
      ownedBySafe: true,
      needsRegistration: false,
    });
    await el.updateComplete;

    expect(done).toHaveBeenCalledTimes(1);
    expect(el.shadowRoot?.querySelector(CARD)).toBeNull();
  });

  it('polls L1 and removes itself once the owner reads back as the Safe', async () => {
    markEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS);
    const evmRead = l1Read({ owner: SAFE.toLowerCase(), registered: true });

    const el = document.createElement('s2s-ens-step') as S2SEnsStep;
    Object.assign(el, {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration({ evmRead }),
      pollIntervalMs: 5,
    });
    const done = vi.fn();
    el.addEventListener('s2s-ens-done', done);
    document.body.appendChild(el);
    await el.updateComplete;

    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(el.shadowRoot?.querySelector(CARD)).toBeNull();
  });

  it('is dismissible without proposing anything', async () => {
    const integration = fakeSafeIntegration();
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: integration,
    });
    const dismissed = vi.fn();
    el.addEventListener('s2s-ens-dismiss', dismissed);

    (el.shadowRoot?.querySelector('#ens-dismiss') as HTMLElement).click();
    await el.updateComplete;

    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(el.shadowRoot?.querySelector(CARD)).toBeNull();
    expect(integration.proposeBatch).not.toHaveBeenCalled();
  });

  it('writes the marker before the send, so a second click cannot queue twice', async () => {
    let resolveProposal!: (url: string) => void;
    const proposeBatch = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveProposal = resolve;
        }),
    );
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration({ proposeBatch }),
      pollIntervalMs: 100_000,
    });

    (el.shadowRoot?.querySelector('#ens-propose') as HTMLElement).click();
    await vi.waitFor(() => expect(proposeBatch).toHaveBeenCalledTimes(1));

    // The send is still in flight, yet the marker is already visible.
    expect(hasEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS)).toBe(true);

    resolveProposal('https://app.safe.global/transactions/queue?safe=eth:0x');
    await el.updateComplete;
    (el.shadowRoot?.querySelector('#ens-dismiss') as HTMLElement).click();
  });

  it('reports a failed proposal, clears the marker and leaves Propose usable', async () => {
    const proposeBatch = vi.fn(async () => {
      throw new Error('user rejected');
    });
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration({ proposeBatch }),
      pollIntervalMs: 100_000,
    });

    (el.shadowRoot?.querySelector('#ens-propose') as HTMLElement).click();
    await vi.waitFor(() => expect(proposeBatch).toHaveBeenCalledTimes(1));
    await el.updateComplete;

    expect(el.shadowRoot?.textContent).toContain('user rejected');
    expect(hasEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS)).toBe(
      false,
    );
    const again = el.shadowRoot?.querySelector('#ens-propose') as HTMLElement | null;
    expect(again).toBeTruthy();
    again?.click();
    await vi.waitFor(() => expect(proposeBatch).toHaveBeenCalledTimes(2));
  });

  it('re-reads L1 before sending, so a name registered meanwhile is not proposed', async () => {
    const integration = fakeSafeIntegration({
      evmRead: l1Read({ owner: OTHER_OWNER.toLowerCase(), registered: true }),
    });
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: integration,
    });

    (el.shadowRoot?.querySelector('#ens-propose') as HTMLElement).click();
    await vi.waitFor(() => expect(el.shadowRoot?.textContent).toContain('not this Safe'));
    await el.updateComplete;

    expect(integration.proposeBatch).not.toHaveBeenCalled();
    expect(hasEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS)).toBe(
      false,
    );
  });

  it('stops polling at the deadline and offers an explicit Propose again', async () => {
    markEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS);
    const calls = { count: 0 };
    const base = l1Read({ owner: ZERO_ADDRESS, registered: false });
    const evmRead = vi.fn(
      async (chainId: number, contract: string, abi: unknown, method: string) => {
        calls.count += 1;
        return base(chainId, contract, abi, method);
      },
    );
    const integration = fakeSafeIntegration({ evmRead });
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: integration,
      pollIntervalMs: 5,
      pollTimeoutMs: 20,
    });

    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#ens-retry')).toBeTruthy(), {
      timeout: 2_000,
    });
    const atDeadline = calls.count;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls.count).toBe(atDeadline);

    // The first click only warns: a still-queued proposal looks identical to
    // no proposal, so re-sending must be a deliberate second click.
    (el.shadowRoot?.querySelector('#ens-retry') as HTMLElement).click();
    await el.updateComplete;
    expect(integration.proposeBatch).not.toHaveBeenCalled();
    expect(el.shadowRoot?.querySelector('#ens-retry-warning')).toBeTruthy();
    expect(el.shadowRoot?.textContent).toContain('duplicate transaction');

    (el.shadowRoot?.querySelector('#ens-retry') as HTMLElement).click();
    await vi.waitFor(() => expect(integration.proposeBatch).toHaveBeenCalledTimes(1));
  });

  it('finishes at the deadline even when the L1 read never settles', async () => {
    markEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS);
    const evmRead = vi.fn(() => new Promise<never>(() => {}));
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration({ evmRead }),
      pollIntervalMs: 5,
      pollTimeoutMs: 30,
    });

    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#ens-retry')).toBeTruthy(), {
      timeout: 2_000,
    });
    const atDeadline = evmRead.mock.calls.length;
    expect(atDeadline).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(evmRead).toHaveBeenCalledTimes(atDeadline);
    expect(el.shadowRoot?.textContent).toContain('still pending in the Safe queue');
  });

  it('hides the step when the Base Safe has no code on mainnet', async () => {
    const integration = fakeSafeIntegration({ contractCodeSize: vi.fn(async () => 0) });
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: 8453, safeAddress: SAFE },
      safeIntegration: integration,
      appUrl: APP_URL,
    });

    await vi.waitFor(() => expect(el.shadowRoot?.querySelector(CARD)).toBeNull());
    expect(integration.contractCodeSize).toHaveBeenCalledWith(SAFE, ENS_L1_CHAIN_ID);
    expect(el.shadowRoot?.querySelector('#ens-open-l1')).toBeNull();
  });

  it('hides Propose on chain 1 when that Safe has no code', async () => {
    const integration = fakeSafeIntegration({ contractCodeSize: vi.fn(async () => 0) });
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: integration,
    });

    await vi.waitFor(() => expect(el.shadowRoot?.querySelector(CARD)).toBeNull());
    expect(el.shadowRoot?.querySelector('#ens-propose')).toBeNull();
  });

  it('keeps the step when the mainnet Safe exists', async () => {
    const integration = fakeSafeIntegration({ contractCodeSize: vi.fn(async () => 4321) });
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: 8453, safeAddress: SAFE },
      safeIntegration: integration,
      appUrl: APP_URL,
    });

    await vi.waitFor(() => expect(el.shadowRoot?.querySelector(CARD)).toBeTruthy());
    expect(el.shadowRoot?.querySelector('#ens-open-l1')).toBeTruthy();
  });

  it('stops polling when the host removes the card from the DOM', async () => {
    markEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS);
    const calls = { count: 0 };
    const base = l1Read({ owner: ZERO_ADDRESS, registered: false });
    const evmRead = vi.fn(
      async (chainId: number, contract: string, abi: unknown, method: string) => {
        calls.count += 1;
        return base(chainId, contract, abi, method);
      },
    );
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration({ evmRead }),
      pollIntervalMs: 5,
      pollTimeoutMs: 10_000,
    });

    await vi.waitFor(() => expect(calls.count).toBeGreaterThan(0));
    el.remove();
    const afterRemove = calls.count;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls.count).toBe(afterRemove);
  });

  it('dismissing a waiting card stops its poll for good', async () => {
    markEnsProposal(window.localStorage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS);
    const calls = { count: 0 };
    const base = l1Read({ owner: ZERO_ADDRESS, registered: false });
    const evmRead = vi.fn(
      async (chainId: number, contract: string, abi: unknown, method: string) => {
        calls.count += 1;
        return base(chainId, contract, abi, method);
      },
    );
    const el = await mountLit<S2SEnsStep>('s2s-ens-step', {
      state: registrationState(),
      safeInfo: { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE },
      safeIntegration: fakeSafeIntegration({ evmRead }),
      pollIntervalMs: 5,
      pollTimeoutMs: 10_000,
    });

    await vi.waitFor(() => expect(calls.count).toBeGreaterThan(0));
    (el.shadowRoot?.querySelector('#ens-dismiss') as HTMLElement).click();
    await el.updateComplete;
    const afterDismiss = calls.count;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls.count).toBe(afterDismiss);
    expect(el.shadowRoot?.querySelector(CARD)).toBeNull();
  });
});
