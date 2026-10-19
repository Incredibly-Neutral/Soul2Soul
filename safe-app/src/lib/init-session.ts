// init-session.ts — persistent tracking of the "new publication" init flow.
//
// The init flow is human-in-the-loop: each step proposes a batch into the
// Safe queue and the human has to open the Safe app and execute it. If they
// navigate away (or the page reloads) mid-flow, the app previously lost all
// track of where it was. This module persists the flow's state to local
// storage so a reload can resume exactly where it left off — and, crucially,
// never re-proposes a batch that was already sent.
//
// Pure + injected-storage (the same AD-2 pattern as publication-init.ts):
// every function here takes a narrow `InitSessionStorage` duck type instead of
// touching `window`/`localStorage` directly, so it is unit-testable in node
// with a hand-rolled fake.
//
// The driving decision lives in `planNextAction`: given the persisted phase
// (what has been *proposed*) and on-chain checks (what has *executed*), it
// returns the single next action. The component then just runs that loop:
// propose -> persist the waiting phase -> poll -> propose -> ... -> done.

/** Phases of the init flow, in execution order. 'creating'/'enabling'/'naming'
 * are the transient "proposing in progress" states; 'detecting' /
 * 'awaiting-enable' / 'awaiting-name' are the "proposal sent, waiting for the
 * human to execute it in the Safe app" states. */
export type InitPhase =
  | 'creating'
  | 'detecting'
  | 'enabling'
  | 'awaiting-enable'
  | 'naming'
  | 'awaiting-name'
  | 'done';

/** Everything worth persisting to resume a flow after a reload. */
export interface InitSession {
  version: 1;
  chainId: number;
  safeAddress: string;
  /** The last phase the flow reached (what has been proposed so far). */
  phase: InitPhase;
  /** Publication name WITHOUT the .soul2soul.eth suffix (as entered). */
  name: string;
  /** Full publication name WITH the .soul2soul.eth suffix. */
  publicationName: string;
  repo: string;
  branch: string;
  authors: string[];
  /** Safe transaction-queue URLs, in proposal order. */
  proposals: string[];
  /** Learned on-chain module addresses (set once the create batch executed). */
  recordsModule?: string;
  publicationModule?: string;
  updatedAt: number;
}

/** The narrow storage surface the session lib needs (subset of Storage). */
export type InitSessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const INIT_SESSION_KEY = 's2s.publication-init.v1';

/** Human-friendly labels per phase — shared by the component + progress modal. */
export const INIT_PHASE_LABELS: Record<InitPhase, string> = {
  creating: 'Proposing module creation…',
  detecting: 'Waiting for proposal 1 (create modules) to be executed…',
  enabling: 'Proposing module enable…',
  'awaiting-enable': 'Waiting for proposal 2 (enable modules) to be executed…',
  naming: 'Proposing name record…',
  'awaiting-name': 'Waiting for proposal 3 (name record) to be executed…',
  done: 'Publication initialized',
};

/** The three checklist rows the progress modal renders. */
export interface InitStepRow {
  index: 1 | 2 | 3;
  title: string;
}
export const INIT_STEPS: InitStepRow[] = [
  { index: 1, title: 'Create modules' },
  { index: 2, title: 'Enable modules' },
  { index: 3, title: 'Record name' },
];

/** Which of the three batches have been PROPOSED at a given phase. */
export interface ProposalProgress {
  create: boolean;
  enable: boolean;
  name: boolean;
}

/** The proposal the flow is currently waiting on (0 = nothing, all done). */
export function currentStepIndex(phase: InitPhase): 0 | 1 | 2 | 3 {
  switch (phase) {
    case 'creating':
    case 'detecting':
      return 1;
    case 'enabling':
    case 'awaiting-enable':
      return 2;
    case 'naming':
    case 'awaiting-name':
      return 3;
    case 'done':
      return 0;
  }
}

/**
 * Checklist state for a given step row: 'done' (its proposal already sent),
 * 'current' (the flow is waiting on this proposal), or 'pending'.
 */
export function stepState(phase: InitPhase, index: 1 | 2 | 3): 'done' | 'current' | 'pending' {
  const current = currentStepIndex(phase);
  if (current === 0) return 'done';
  if (index < current) return 'done';
  if (index === current) return 'current';
  return 'pending';
}

export function proposalProgress(phase: InitPhase): ProposalProgress {
  switch (phase) {
    case 'creating':
      return { create: false, enable: false, name: false };
    case 'detecting':
    case 'enabling':
      return { create: true, enable: false, name: false };
    case 'awaiting-enable':
    case 'naming':
      return { create: true, enable: true, name: false };
    case 'awaiting-name':
    case 'done':
      return { create: true, enable: true, name: true };
  }
}

/**
 * The on-chain truth a resume decision needs. `recordsKnown` /
 * `publicationKnown` tell us whether the module addresses have been learned
 * yet (create batch executed + detected); `recordsEnabled` /
 * `publicationEnabled` whether the modules are actually enabled (enable batch
 * executed); `nameRecorded` whether the name record is on-chain (name batch
 * executed).
 */
export interface ResumeChecks {
  recordsKnown: boolean;
  publicationKnown: boolean;
  recordsEnabled: boolean;
  publicationEnabled: boolean;
  nameRecorded: boolean;
}

/** The next action to take, given a persisted session + on-chain checks. */
export type ResumeAction =
  | { type: 'create' }
  | { type: 'detect' }
  | { type: 'enable' }
  | { type: 'await-enable' }
  | { type: 'name' }
  | { type: 'await-name' }
  | { type: 'done' };

/**
 * Plan the next step of the init flow. The persisted phase tells us what has
 * already been PROPOSED; the checks tell us what has EXECUTED on-chain. We
 * never re-propose a batch that was already proposed — if a step's proposal
 * was sent but hasn't executed, we return the *waiting* action instead.
 */
export function planNextAction(session: InitSession, checks: ResumeChecks): ResumeAction {
  const proposed = proposalProgress(session.phase);

  // 1. Module addresses not learned yet → the create batch is the pending step.
  if (!checks.recordsKnown || !checks.publicationKnown) {
    return proposed.create ? { type: 'detect' } : { type: 'create' };
  }

  // 2. Addresses known but modules not enabled → the enable batch is pending.
  if (!checks.recordsEnabled || !checks.publicationEnabled) {
    return proposed.enable ? { type: 'await-enable' } : { type: 'enable' };
  }

  // 3. Modules enabled but name not recorded → the name batch is pending.
  if (!checks.nameRecorded) {
    return proposed.name ? { type: 'await-name' } : { type: 'name' };
  }

  // 4. Everything is on-chain → done.
  return { type: 'done' };
}

/** Parse a persisted session, tolerating missing/corrupt entries. */
export function loadInitSession(storage: InitSessionStorage, key: string): InitSession | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<InitSession>;
    if (
      parsed.version !== 1 ||
      typeof parsed.chainId !== 'number' ||
      typeof parsed.safeAddress !== 'string' ||
      typeof parsed.phase !== 'string' ||
      typeof parsed.publicationName !== 'string'
    ) {
      return null;
    }
    return {
      version: 1,
      chainId: parsed.chainId,
      safeAddress: parsed.safeAddress,
      phase: parsed.phase,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      publicationName: parsed.publicationName,
      repo: typeof parsed.repo === 'string' ? parsed.repo : '',
      branch: typeof parsed.branch === 'string' ? parsed.branch : '',
      authors: Array.isArray(parsed.authors)
        ? parsed.authors.filter((a) => typeof a === 'string')
        : [],
      proposals: Array.isArray(parsed.proposals)
        ? parsed.proposals.filter((p) => typeof p === 'string')
        : [],
      recordsModule: typeof parsed.recordsModule === 'string' ? parsed.recordsModule : undefined,
      publicationModule:
        typeof parsed.publicationModule === 'string' ? parsed.publicationModule : undefined,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveInitSession(
  storage: InitSessionStorage,
  key: string,
  session: InitSession,
): void {
  storage.setItem(key, JSON.stringify(session));
}

export function clearInitSession(storage: InitSessionStorage, key: string): void {
  storage.removeItem(key);
}
