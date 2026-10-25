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
// The flow is the DIRECT SEQUENCE (PR #158) plus the ENS step (4 steps):
//
//   1. Register ENS name   — proposable by anyone while the parent is wrapped,
//                            but the registry lives on L1 ONLY, so this is its
//                            OWN Safe tx, proposed from the L1 twin Safe and
//                            never batched with the Base module txs.
//   2. Create modules      — module addresses are unknowable until the create
//                            batch executes (the factories use plain CREATE).
//   3. Enable + record name — once the addresses are known these are merged
//                            into ONE atomic batch (setRecord is onlySafe on the
//                            records module and does not need it enabled, so
//                            there is no reason to split them).
//   4. Initialize configuration — host-owned (see below).
//
// The persisted phases therefore describe the proposal round-trips:
//
//   ens       → transient: proposing the L1 registerSubdomain tx
//   awaiting-ens → registration proposed, waiting for execution
//   creating  → transient: proposing the create batch
//   detecting → create proposed, waiting for execution
//   finalizing → transient: proposing the merged enable+name batch
//   awaiting-finalize → merged batch proposed, waiting for execution
//   configuring → transient: building + proposing the config record (host-owned)
//   awaiting-config → config record proposed, waiting for execution (host-owned)
//   done      → everything on-chain
//
// The driving decision lives in `planNextAction`: given the persisted phase
// (what has been *proposed*) and on-chain checks (what has *executed*), it
// returns the single next action. The component then just runs that loop:
// propose -> persist the waiting phase -> poll -> propose -> ... -> done.
//
// The config step ('configuring'/'awaiting-config') is NOT driven by
// s2s-publication-init: once the finalize batch executes the modules are live
// and the component unmounts, so the host (<s2s-app>) drives it instead
// (build + propose the config record via the records tab, then wait for its
// execution). Its phases live here so the step is persisted + surfaced in the
// progress modal exactly like the others.

/** Phases of the init flow, in execution order. 'ens'/'creating'/'finalizing'/
 * 'configuring' are the transient "proposing in progress" states;
 * 'awaiting-ens' / 'detecting' / 'awaiting-finalize' / 'awaiting-config' are
 * the "proposal sent, waiting for the human to execute it in the Safe app"
 * states. */
export type InitPhase =
  | 'ens'
  | 'awaiting-ens'
  | 'creating'
  | 'detecting'
  | 'finalizing'
  | 'awaiting-finalize'
  | 'configuring'
  | 'awaiting-config'
  | 'done';

/** True for the host-owned config step (modules live, s2s-init unmounted). */
export function isConfigPhase(
  phase: InitPhase,
): phase is Extract<InitPhase, 'configuring' | 'awaiting-config'> {
  return phase === 'configuring' || phase === 'awaiting-config';
}

/** Everything worth persisting to resume a flow after a reload. */
export interface InitSession {
  version: 3;
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

export const INIT_SESSION_KEY = 's2s.publication-init.v3';

/** Bumped to 3 for the ENS step: a v2 session (3 steps, no ENS) carries stale
 *  step semantics, so `loadInitSession` drops it instead of resuming it. */
export const INIT_SESSION_VERSION = 3 as const;

/** The four checklist rows the progress modal renders. */
export interface InitStepRow {
  index: 1 | 2 | 3 | 4;
  title: string;
}
export const INIT_STEPS: InitStepRow[] = [
  { index: 1, title: 'Register ENS name' },
  { index: 2, title: 'Create modules' },
  { index: 3, title: 'Enable + record name' },
  { index: 4, title: 'Initialize configuration' },
];

/** Which of the proposals/records have been PROPOSED at a given phase. */
export interface ProposalProgress {
  create: boolean;
  finalize: boolean;
  config: boolean;
}

/** The proposal the flow is currently waiting on (0 = nothing, all done). */
export function currentStepIndex(phase: InitPhase): 0 | 1 | 2 | 3 | 4 {
  switch (phase) {
    case 'ens':
    case 'awaiting-ens':
      return 1;
    case 'creating':
    case 'detecting':
      return 2;
    case 'finalizing':
    case 'awaiting-finalize':
      return 3;
    case 'configuring':
    case 'awaiting-config':
      return 4;
    case 'done':
      return 0;
  }
}

/**
 * Checklist state for a given step row: 'done' (its proposal already sent),
 * 'current' (the flow is waiting on this proposal), or 'pending'.
 */
export function stepState(
  phase: InitPhase,
  index: 1 | 2 | 3 | 4,
): 'done' | 'current' | 'pending' {
  const current = currentStepIndex(phase);
  if (current === 0) return 'done';
  if (index < current) return 'done';
  if (index === current) return 'current';
  return 'pending';
}

export function proposalProgress(phase: InitPhase): ProposalProgress {
  switch (phase) {
    // The ENS registration is its own L1 proposal, tracked by the phase alone
    // (and gated by `ResumeChecks.ensResolved`), not by this record.
    case 'ens':
    case 'awaiting-ens':
      return { create: false, finalize: false, config: false };
    case 'creating':
      return { create: false, finalize: false, config: false };
    case 'detecting':
    case 'finalizing':
      return { create: true, finalize: false, config: false };
    case 'awaiting-finalize':
      return { create: true, finalize: true, config: false };
    // Same invariant as the other transient phases: the phase that is CURRENTLY
    // sending a batch reports false for it ('creating' → create:false,
    // 'finalizing' → finalize:false), so 'configuring' → config:false and only
    // the waiting phase reports it as proposed.
    case 'configuring':
      return { create: true, finalize: true, config: false };
    case 'awaiting-config':
      return { create: true, finalize: true, config: true };
    case 'done':
      return { create: true, finalize: true, config: true };
  }
}

/**
 * The on-chain truth a resume decision needs. `recordsKnown` /
 * `publicationKnown` tell us whether the module addresses have been learned
 * yet (create batch executed + detected); `recordsEnabled` /
 * `publicationEnabled` whether the modules are actually enabled (finalize
 * batch executed); `nameRecorded` whether the name record is on-chain (finalize
 * batch executed — enable + name are atomic).
 */
export interface ResumeChecks {
  /** The publication's ENS subnode is registered (L1 registry flag set) — step 1
   *  done. Checked FIRST: without it the name resolves to 0x0 and the modules
   *  are unreachable, so the module steps must not start. */
  ensResolved: boolean;
  recordsKnown: boolean;
  publicationKnown: boolean;
  recordsEnabled: boolean;
  publicationEnabled: boolean;
  nameRecorded: boolean;
}

/** The next action to take, given a persisted session + on-chain checks. */
export type ResumeAction =
  | { type: 'ens' }
  | { type: 'await-ens' }
  | { type: 'create' }
  | { type: 'detect' }
  | { type: 'finalize' }
  | { type: 'await-finalize' }
  | { type: 'done' };

/**
 * Plan the next step of the init flow. The persisted phase tells us what has
 * already been PROPOSED; the checks tell us what has EXECUTED on-chain. We
 * never re-propose a batch that was already proposed — if a step's proposal
 * was sent but hasn't executed, we return the *waiting* action instead.
 */
export function planNextAction(session: InitSession, checks: ResumeChecks): ResumeAction {
  const proposed = proposalProgress(session.phase);

  // 0. ENS name not registered yet → the L1 registerSubdomain tx is the pending
  //    step, before any Base module work (the name is what resolves to the Safe).
  if (!checks.ensResolved) {
    return session.phase === 'awaiting-ens' ? { type: 'await-ens' } : { type: 'ens' };
  }

  // 1. Module addresses not learned yet → the create batch is the pending step.
  if (!checks.recordsKnown || !checks.publicationKnown) {
    return proposed.create ? { type: 'detect' } : { type: 'create' };
  }

  // 2. Modules not enabled OR the name not recorded → the merged enable+name
  //    batch is the pending step. enableModule is idempotent on the Safe, so
  //    re-proposing it against an already-enabled module (a half-initialized
  //    legacy state) is harmless.
  if (!checks.recordsEnabled || !checks.publicationEnabled || !checks.nameRecorded) {
    return proposed.finalize ? { type: 'await-finalize' } : { type: 'finalize' };
  }

  // 3. Everything is on-chain → done.
  return { type: 'done' };
}

/** Parse a persisted session, tolerating missing/corrupt entries. A session of
 *  any other version is rejected (null) — never resumed across the ENS bump. */
export function loadInitSession(storage: InitSessionStorage, key: string): InitSession | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<InitSession>;
    if (
      parsed.version !== INIT_SESSION_VERSION ||
      typeof parsed.chainId !== 'number' ||
      typeof parsed.safeAddress !== 'string' ||
      typeof parsed.phase !== 'string' ||
      typeof parsed.publicationName !== 'string'
    ) {
      return null;
    }
    return {
      version: INIT_SESSION_VERSION,
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
