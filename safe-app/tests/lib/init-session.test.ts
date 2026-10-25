import { describe, it, expect } from 'vitest';
import {
  INIT_SESSION_KEY,
  INIT_STEPS,
  clearInitSession,
  currentStepIndex,
  loadInitSession,
  maxPhase,
  planNextAction,
  proposalProgress,
  saveInitSession,
  stepState,
  type InitSession,
  type ResumeAction,
} from '../../src/lib/init-session';

const SAFE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function makeSession(overrides: Partial<InitSession> = {}): InitSession {
  return {
    version: 3,
    chainId: 8453,
    safeAddress: SAFE,
    phase: 'detecting',
    name: 'my-publication',
    publicationName: 'my-publication.soul2soul.eth',
    repo: 'https://github.com/Joera/website-starter',
    branch: 'main',
    authors: ['0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'],
    proposals: ['https://app.safe.global/transactions/queue?safe=8453:0xAbC'],
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** In-memory stand-in for localStorage. */
function makeStorage(initial: Record<string, string> = {}): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    removeItem: (key: string) => {
      delete data[key];
    },
    data,
  };
}

const noop = (): void => undefined;

describe('init-session persistence', () => {
  it('round-trips a session through save -> load', () => {
    const storage = makeStorage();
    const session = makeSession({
      phase: 'awaiting-finalize',
      recordsModule: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      publicationModule: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
      proposals: ['url-1', 'url-2'],
    });

    saveInitSession(storage, INIT_SESSION_KEY, session);

    expect(loadInitSession(storage, INIT_SESSION_KEY)).toEqual(session);
    expect(storage.data[INIT_SESSION_KEY]).toBe(JSON.stringify(session));
  });

  it('returns null when nothing is stored', () => {
    const storage = makeStorage();
    expect(loadInitSession(storage, INIT_SESSION_KEY)).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    const storage = makeStorage({ [INIT_SESSION_KEY]: '{not json' });
    expect(loadInitSession(storage, INIT_SESSION_KEY)).toBeNull();
  });

  it('returns null for a wrong-version or incomplete session', () => {
    // v1 sessions from the old 3-proposal flow are incompatible with the
    // merged direct sequence — they must be dropped, not resumed.
    const oldV1 = makeStorage({
      [INIT_SESSION_KEY]: JSON.stringify({ version: 1, phase: 'awaiting-name' }),
    });
    expect(loadInitSession(oldV1, INIT_SESSION_KEY)).toBeNull();

    // A future version is not ours either.
    const future = makeStorage({
      [INIT_SESSION_KEY]: JSON.stringify({ version: 4, phase: 'detecting' }),
    });
    expect(loadInitSession(future, INIT_SESSION_KEY)).toBeNull();

    const missingName = makeStorage({
      [INIT_SESSION_KEY]: JSON.stringify({ version: 3, phase: 'detecting' }),
    });
    expect(loadInitSession(missingName, INIT_SESSION_KEY)).toBeNull();

    // An unknown phase is fatal for the planner (proposalProgress has no
    // default branch), so it is rejected at the door rather than at plan time.
    const unknownPhase = makeStorage({
      [INIT_SESSION_KEY]: JSON.stringify({
        version: 3,
        chainId: 8453,
        safeAddress: SAFE,
        phase: 'awaiting-name',
        publicationName: 'my-publication.soul2soul.eth',
      }),
    });
    expect(loadInitSession(unknownPhase, INIT_SESSION_KEY)).toBeNull();
  });

  it('migrates a v2 session from the legacy key, keeping every field', () => {
    // A v2 session is NOT dropped: its phases and fields are a subset of v3
    // (v3 only prepends the ENS step), and its create batch may already be
    // queued — dropping it strands a flow whose modules are deployed but not
    // yet enabled (invisible to hasRecordsModule()).
    const v2 = {
      version: 2,
      chainId: 8453,
      safeAddress: SAFE,
      phase: 'detecting',
      name: 'my-publication',
      publicationName: 'my-publication.soul2soul.eth',
      repo: 'https://github.com/Joera/website-starter',
      branch: 'main',
      authors: ['0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'],
      proposals: ['url-1'],
      recordsModule: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      publicationModule: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
      updatedAt: 1_700_000_000_000,
    };
    const storage = makeStorage({ 's2s.publication-init.v2': JSON.stringify(v2) });

    const loaded = loadInitSession(storage, INIT_SESSION_KEY);

    expect(loaded).toEqual({ ...v2, version: 3 });
    // Written back under the current key and dropped from the legacy one, so the
    // same v2 flow can never be resumed twice.
    expect(storage.data[INIT_SESSION_KEY]).toBe(JSON.stringify({ ...v2, version: 3 }));
    expect(storage.data['s2s.publication-init.v2']).toBeUndefined();
  });

  it('leaves a v2 session that needs step 1 pointing at the ENS step', () => {
    // The migrated session never had the ENS step, so `ensResolved` is absent
    // and the plan prepends it — even though its phase says "modules pending".
    const storage = makeStorage({
      's2s.publication-init.v2': JSON.stringify({
        version: 2,
        chainId: 8453,
        safeAddress: SAFE,
        phase: 'detecting',
        publicationName: 'my-publication.soul2soul.eth',
      }),
    });
    const loaded = loadInitSession(storage, INIT_SESSION_KEY)!;

    expect(loaded.ensResolved).toBeUndefined();
    expect(loaded.ensProposed).toBeUndefined();
    expect(
      planNextAction(loaded, {
        ensResolved: false,
        recordsKnown: false,
        publicationKnown: false,
        recordsEnabled: false,
        publicationEnabled: false,
        nameRecorded: false,
      }),
    ).toEqual({ type: 'ens' });
  });

  it('tolerates malformed optional fields and drops non-string members', () => {
    const storage = makeStorage({
      [INIT_SESSION_KEY]: JSON.stringify({
        version: 3,
        chainId: 8453,
        safeAddress: SAFE,
        phase: 'awaiting-finalize',
        name: null,
        publicationName: 'x.soul2soul.eth',
        repo: 42,
        branch: 'main',
        authors: ['ok', 7, 'still-ok'],
        proposals: ['p1', null],
      }),
    });

    const loaded = loadInitSession(storage, INIT_SESSION_KEY)!;
    expect(loaded.phase).toBe('awaiting-finalize');
    expect(loaded.name).toBe('');
    expect(loaded.repo).toBe('');
    expect(loaded.branch).toBe('main');
    expect(loaded.authors).toEqual(['ok', 'still-ok']);
    expect(loaded.proposals).toEqual(['p1']);
  });

  it('clear removes the stored session', () => {
    const storage = makeStorage();
    saveInitSession(storage, INIT_SESSION_KEY, makeSession());
    expect(loadInitSession(storage, INIT_SESSION_KEY)).not.toBeNull();

    clearInitSession(storage, INIT_SESSION_KEY);
    expect(loadInitSession(storage, INIT_SESSION_KEY)).toBeNull();
    noop();
  });
});

describe('maxPhase', () => {
  it('keeps the later phase in flow order, whichever side it is on', () => {
    // Step 1 can re-enter from a later phase; the phase write must not go back.
    expect(maxPhase('detecting', 'awaiting-ens')).toBe('detecting');
    expect(maxPhase('awaiting-ens', 'detecting')).toBe('detecting');
    expect(maxPhase('ens', 'awaiting-ens')).toBe('awaiting-ens');
    expect(maxPhase('ens', 'creating')).toBe('creating');
    expect(maxPhase('awaiting-finalize', 'creating')).toBe('awaiting-finalize');
    expect(maxPhase('done', 'ens')).toBe('done');
    expect(maxPhase('detecting', 'detecting')).toBe('detecting');
  });
});

describe('proposalProgress', () => {
  it('tracks which batches/records have been proposed at each phase', () => {
    expect(proposalProgress('creating')).toEqual({
      create: false,
      finalize: false,
      config: false,
    });
    expect(proposalProgress('detecting')).toEqual({
      create: true,
      finalize: false,
      config: false,
    });
    expect(proposalProgress('finalizing')).toEqual({
      create: true,
      finalize: false,
      config: false,
    });
    expect(proposalProgress('awaiting-finalize')).toEqual({
      create: true,
      finalize: true,
      config: false,
    });
    // 'configuring' is the transient "sending the config proposal" phase, so —
    // like 'creating'/'finalizing' — it reports the batch as NOT yet proposed.
    expect(proposalProgress('configuring')).toEqual({
      create: true,
      finalize: true,
      config: false,
    });
    expect(proposalProgress('awaiting-config')).toEqual({
      create: true,
      finalize: true,
      config: true,
    });
    expect(proposalProgress('done')).toEqual({
      create: true,
      finalize: true,
      config: true,
    });
  });

  it('reports nothing proposed while the ENS step is pending', () => {
    // The ENS registration is its own L1 proposal, tracked by the phase +
    // `ResumeChecks.ensResolved` rather than by ProposalProgress.
    expect(proposalProgress('ens')).toEqual({ create: false, finalize: false, config: false });
    expect(proposalProgress('awaiting-ens')).toEqual({
      create: false,
      finalize: false,
      config: false,
    });
  });
});

describe('INIT_STEPS', () => {
  it('is the 4-row checklist, ENS registration first', () => {
    expect(INIT_STEPS).toEqual([
      { index: 1, title: 'Register ENS name' },
      { index: 2, title: 'Create modules' },
      { index: 3, title: 'Enable + record name' },
      { index: 4, title: 'Initialize configuration' },
    ]);
  });
});

describe('currentStepIndex + stepState', () => {
  it('maps each phase to the proposal currently being waited on', () => {
    expect(currentStepIndex('ens')).toBe(1);
    expect(currentStepIndex('awaiting-ens')).toBe(1);
    expect(currentStepIndex('creating')).toBe(2);
    expect(currentStepIndex('detecting')).toBe(2);
    expect(currentStepIndex('finalizing')).toBe(3);
    expect(currentStepIndex('awaiting-finalize')).toBe(3);
    expect(currentStepIndex('configuring')).toBe(4);
    expect(currentStepIndex('awaiting-config')).toBe(4);
    expect(currentStepIndex('done')).toBe(0);
  });

  it('stepState marks past steps done, the current one active, later ones pending', () => {
    // Waiting on the ENS registration → nothing before it, everything after it
    // still pending (including the module work).
    expect(stepState('ens', 1)).toBe('current');
    expect(stepState('awaiting-ens', 1)).toBe('current');
    expect(stepState('awaiting-ens', 2)).toBe('pending');
    expect(stepState('awaiting-ens', 3)).toBe('pending');
    expect(stepState('awaiting-ens', 4)).toBe('pending');

    // Waiting on the merged finalize batch → ENS + create done, config pending.
    expect(stepState('awaiting-finalize', 1)).toBe('done');
    expect(stepState('awaiting-finalize', 2)).toBe('done');
    expect(stepState('awaiting-finalize', 3)).toBe('current');
    expect(stepState('awaiting-finalize', 4)).toBe('pending');
  });

  it('drives the 4-step checklist through the config phase', () => {
    // Step 4 (config) is what the host waits on while the config record is
    // being built/executed — steps 1–3 are already done by then.
    expect(stepState('configuring', 1)).toBe('done');
    expect(stepState('configuring', 2)).toBe('done');
    expect(stepState('configuring', 3)).toBe('done');
    expect(stepState('configuring', 4)).toBe('current');
    expect(stepState('awaiting-config', 4)).toBe('current');
  });

  it('when done, every step is marked done', () => {
    expect(stepState('done', 1)).toBe('done');
    expect(stepState('done', 2)).toBe('done');
    expect(stepState('done', 3)).toBe('done');
    expect(stepState('done', 4)).toBe('done');
  });
});

describe('planNextAction', () => {
  const known = {
    ensResolved: true,
    recordsKnown: true,
    publicationKnown: true,
    recordsEnabled: true,
    publicationEnabled: true,
    nameRecorded: true,
  };

  it('starts fresh with the ENS registration, before any module work', () => {
    const session = makeSession({ phase: 'ens' });
    expect(
      planNextAction(session, {
        ...known,
        ensResolved: false,
        recordsKnown: false,
        publicationKnown: false,
        recordsEnabled: false,
        publicationEnabled: false,
        nameRecorded: false,
      }),
    ).toEqual({ type: 'ens' });
  });

  it('ENS proposed but not registered yet -> await-ens (never re-propose)', () => {
    const session = makeSession({ phase: 'awaiting-ens' });
    expect(planNextAction(session, { ...known, ensResolved: false })).toEqual({
      type: 'await-ens',
    });
  });

  it('ENS registration gates every module step, even from a stale phase', () => {
    // The persisted phase lags (it thinks the finalize batch is pending) but the
    // name is still unregistered: the ENS step wins, because an unregistered
    // name resolves to 0x0 and nothing else would be reachable.
    const stale = makeSession({ phase: 'awaiting-finalize' });
    expect(planNextAction(stale, { ...known, ensResolved: false })).toEqual({ type: 'ens' });
  });

  it('a step-1 re-entry from a later phase keeps the phase, so no duplicate create', () => {
    // The name was released/transferred on L1 after the create batch went out.
    // `ensProposed` is its own bit precisely so the phase can keep saying
    // "detecting" (create already queued) while step 1 is pending — the plan
    // must wait for the neighbour to execute, never re-propose the create.
    const stale = makeSession({ phase: 'detecting', ensProposed: true });
    expect(planNextAction(stale, { ...known, ensResolved: false })).toEqual({
      type: 'await-ens',
    });
    // And once the name resolves, the very same session goes back to detect
    // (create:true from its phase) instead of proposing a second batch.
    expect(
      planNextAction(stale, {
        ...known,
        recordsKnown: false,
        publicationKnown: false,
      }),
    ).toEqual({ type: 'detect' });
  });

  it('once the ENS name is registered the module plan is unchanged', () => {
    const session = makeSession({ phase: 'creating' });
    expect(
      planNextAction(session, { ...known, recordsKnown: false, publicationKnown: false }),
    ).toEqual({ type: 'create' });
  });

  it('starts fresh: create', () => {
    const session = makeSession({ phase: 'creating' });
    expect(
      planNextAction(session, { ...known, recordsKnown: false, publicationKnown: false }),
    ).toEqual({ type: 'create' });
  });

  it('create proposed but addresses unknown -> detect (never re-propose)', () => {
    const session = makeSession({ phase: 'detecting' });
    expect(
      planNextAction(session, { ...known, recordsKnown: false, publicationKnown: false }),
    ).toEqual({ type: 'detect' });
  });

  it('addresses known, nothing executed, finalize not yet proposed -> finalize', () => {
    const session = makeSession({ phase: 'finalizing' });
    expect(
      planNextAction(session, { ...known, recordsEnabled: false, publicationEnabled: false }),
    ).toEqual({ type: 'finalize' });
  });

  it('finalize already proposed but not executed -> await-finalize', () => {
    const session = makeSession({ phase: 'awaiting-finalize' });
    expect(
      planNextAction(session, { ...known, recordsEnabled: false, publicationEnabled: false }),
    ).toEqual({ type: 'await-finalize' });
  });

  it('enabled but name missing -> proposes finalize again (enable is idempotent)', () => {
    const session = makeSession({ phase: 'finalizing' });
    expect(planNextAction(session, { ...known, nameRecorded: false })).toEqual({
      type: 'finalize',
    });
  });

  it('enabled but name missing and finalize already proposed -> await-finalize', () => {
    const session = makeSession({ phase: 'awaiting-finalize' });
    expect(planNextAction(session, { ...known, nameRecorded: false })).toEqual({
      type: 'await-finalize',
    });
  });

  it('everything executed -> done (skips re-proposing anything)', () => {
    const session = makeSession({ phase: 'awaiting-finalize' });
    expect(planNextAction(session, known)).toEqual({ type: 'done' });
  });

  it('skips straight to done when the whole flow already executed', () => {
    // Reloaded long after everything landed: the persisted phase may lag the
    // on-chain truth (e.g. stuck at 'detecting' because the page died there),
    // but modules are enabled and the name is recorded -> just finish.
    const session = makeSession({ phase: 'detecting' });
    expect(planNextAction(session, known)).toEqual({ type: 'done' });
  });

  it('enables only one module -> still not done', () => {
    const session = makeSession({ phase: 'awaiting-finalize' });
    const action = planNextAction(session, {
      ...known,
      recordsEnabled: false,
      nameRecorded: false,
    }) as ResumeAction;
    expect(action.type).toBe('await-finalize');
  });
});
