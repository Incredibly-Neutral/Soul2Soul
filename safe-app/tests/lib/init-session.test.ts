import { describe, it, expect } from 'vitest';
import {
  INIT_SESSION_KEY,
  clearInitSession,
  currentStepIndex,
  loadInitSession,
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
    version: 2,
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
    const bad = makeStorage({
      [INIT_SESSION_KEY]: JSON.stringify({ version: 3, phase: 'detecting' }),
    });
    expect(loadInitSession(bad, INIT_SESSION_KEY)).toBeNull();

    // v1 sessions from the old 3-proposal flow are incompatible with the
    // merged direct sequence — they must be dropped, not resumed.
    const oldV1 = makeStorage({
      [INIT_SESSION_KEY]: JSON.stringify({ version: 1, phase: 'awaiting-name' }),
    });
    expect(loadInitSession(oldV1, INIT_SESSION_KEY)).toBeNull();

    const missingName = makeStorage({
      [INIT_SESSION_KEY]: JSON.stringify({ version: 2, phase: 'detecting' }),
    });
    expect(loadInitSession(missingName, INIT_SESSION_KEY)).toBeNull();
  });

  it('tolerates malformed optional fields and drops non-string members', () => {
    const storage = makeStorage({
      [INIT_SESSION_KEY]: JSON.stringify({
        version: 2,
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

describe('proposalProgress', () => {
  it('tracks which batches have been proposed at each phase', () => {
    expect(proposalProgress('creating')).toEqual({ create: false, finalize: false });
    expect(proposalProgress('detecting')).toEqual({ create: true, finalize: false });
    expect(proposalProgress('finalizing')).toEqual({ create: true, finalize: false });
    expect(proposalProgress('awaiting-finalize')).toEqual({ create: true, finalize: true });
    expect(proposalProgress('done')).toEqual({ create: true, finalize: true });
  });
});

describe('currentStepIndex + stepState', () => {
  it('maps each phase to the proposal currently being waited on', () => {
    expect(currentStepIndex('creating')).toBe(1);
    expect(currentStepIndex('detecting')).toBe(1);
    expect(currentStepIndex('finalizing')).toBe(2);
    expect(currentStepIndex('awaiting-finalize')).toBe(2);
    expect(currentStepIndex('done')).toBe(0);
  });

  it('stepState marks past steps done, the current one active, later ones pending', () => {
    // Waiting on proposal 2 → step 1 done, step 2 current.
    expect(stepState('awaiting-finalize', 1)).toBe('done');
    expect(stepState('awaiting-finalize', 2)).toBe('current');
  });

  it('when done, every step is marked done', () => {
    expect(stepState('done', 1)).toBe('done');
    expect(stepState('done', 2)).toBe('done');
  });
});

describe('planNextAction', () => {
  const known = {
    recordsKnown: true,
    publicationKnown: true,
    recordsEnabled: true,
    publicationEnabled: true,
    nameRecorded: true,
  };

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
