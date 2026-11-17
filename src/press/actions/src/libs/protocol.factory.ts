import { evmRead } from "./evm";
import type { S2SManifest } from '@s2s/soul2soul-shared/lit-actions';

// The protocol's records module on Base: `configModule` for soul2soul.eth, the
// address update-protocol.ts and repoint-record.ts write to — and the module
// `getManifest` reads the manifest document from.
//
// This is the bootstrap root, and no factory resolves it: it holds the
// manifest, so this address is where every address inside it comes from, and
// asking a factory for it would be circular. The deployment is a plain CREATE,
// which no factory made, so no factory knows it either. It is not one of the
// two kinds `ens.factory` reads from the factory, and it is not the author-side
// path either; it is this record's own module, held as a constant and read
// directly, for that reason — not as a request-budget shortcut.
//
// A redeploy of the records module makes this constant stale without error: the
// read answers empty on the old address, so getManifest throws for want of the
// `manifest` record rather than discovering a module it cannot identify. See
// SPEC-protocol-actions.md, Gotchas.
const PROTOCOL_RECORDS_MODULE = '0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29';

/** The record key the manifest document is published under. */
const MANIFEST_KEY = 'manifest';

const RECORD_ABI = ['function getRecord(string key) view returns (string)'];
const VERSION_ABI = ['function VERSION() view returns (string)'];

/** Document fields that must be non-empty strings: addresses and the gateway. */
const REQUIRED_STRINGS = [
  'gateway',
  'ensRegistry',
  'ensRecords',
  'publicationFactory',
  'recordsFactory',
  'pkp',
] as const;

/** Action CIDs the document must carry: an action with no CID cannot run. */
const REQUIRED_ACTIONS = ['prep', 'render', 'update'] as const;

/**
 * Action CIDs that are absent from the document until their record is written.
 * Absent, never the empty string: a document that carries the key at all must
 * carry something, or it is a shape this reader does not accept.
 */
const OPTIONAL_ACTIONS = ['maintainCache', 'repointArchive', 'encrypt', 'decrypt'] as const;

const errMsg = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const fail = (detail: string): never => {
  throw new Error(`manifest: ${detail}`);
};

/**
 * The manifest: every address the action needs, and the action CIDs, in one
 * record and one read.
 *
 * Two calls on the records module, held above as a constant:
 *
 *   1. `getRecord('manifest')` — the JSON document. Every address and CID comes
 *      from it, including the factory discovery asks. There is no key list: the
 *      flat record keys it replaced are gone, and no reader reads them.
 *   2. `VERSION()` — the module's own version, which is the document's major.
 *      The module is not redeployed when a CID changes, so the document names its
 *      own `x.y.z` and only its first segment has to equal `VERSION()`; anything
 *      else is a document this module cannot be read alongside.
 *
 * No ENS walk: the constant is the root, so there is nothing above it to ask.
 * This is also why every action starts here rather than with a single
 * `publication_factory` read — the document has that value, so a first call is
 * still two, and discovery gets its factory from the same answer.
 *
 * Validated by hand rather than with the shared zod schema: zod cannot enter an
 * action bundle. A missing record, unparsable JSON, a bad shape and a major
 * mismatch each throw an error naming `manifest`.
 *
 * Typed against the shared `S2SManifest` so the two readers cannot drift in
 * shape. Only the type crosses the package boundary: the shared reader itself
 * is viem and cannot enter an action bundle.
 */
export const getManifest = async (
  dev: boolean,
  rpcs?: { L1: string[]; L2: string[] },
): Promise<S2SManifest> => {

  try {

  // One record, the document, on the constant.
  let document: unknown;
  try {
    document = await evmRead('L2', PROTOCOL_RECORDS_MODULE, RECORD_ABI, 'getRecord', [MANIFEST_KEY], rpcs?.L2);
  } catch (error) {
    fail(`the '${MANIFEST_KEY}' record is unreadable on ${PROTOCOL_RECORDS_MODULE}: ${errMsg(error)}`);
  }
  if (!isNonEmptyString(document)) {
    fail(`no '${MANIFEST_KEY}' record on ${PROTOCOL_RECORDS_MODULE}`);
  }

  let raw: any;
  try {
    raw = JSON.parse(document as string);
  } catch (error) {
    fail(`the '${MANIFEST_KEY}' record is not valid JSON: ${errMsg(error)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`the '${MANIFEST_KEY}' record is not a JSON object`);
  }

  if (typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(raw.version)) {
    fail(`'version' is missing or not x.y.z (got ${JSON.stringify(raw.version)})`);
  }
  for (const field of REQUIRED_STRINGS) {
    if (!isNonEmptyString(raw[field])) {
      fail(`'${field}' is missing or not a non-empty string`);
    }
  }
  if (typeof raw.litActions !== 'object' || raw.litActions === null || Array.isArray(raw.litActions)) {
    fail(`'litActions' is missing or not a JSON object`);
  }
  for (const field of REQUIRED_ACTIONS) {
    if (typeof raw.litActions[field] !== 'string') {
      fail(`'litActions.${field}' is missing or not a string`);
    }
  }
  for (const field of OPTIONAL_ACTIONS) {
    if (field in raw.litActions && !isNonEmptyString(raw.litActions[field])) {
      fail(`'litActions.${field}' is present but not a non-empty string; leave it out when the action is not deployed`);
    }
  }

  // The contract's own version, on the same address. It is the document's
  // major and nothing else, so the comparison is against the whole string.
  let onChainVersion: unknown;
  try {
    onChainVersion = await evmRead('L2', PROTOCOL_RECORDS_MODULE, VERSION_ABI, 'VERSION', [], rpcs?.L2);
  } catch (error) {
    fail(`VERSION() is unreadable on ${PROTOCOL_RECORDS_MODULE}: ${errMsg(error)}`);
  }
  if (!isNonEmptyString(onChainVersion)) {
    fail(`VERSION() on ${PROTOCOL_RECORDS_MODULE} answered nothing`);
  }

  const documentMajor = (raw.version as string).split('.')[0];
  if (documentMajor !== onChainVersion) {
    fail(`document version ${raw.version} is not compatible with VERSION() ${onChainVersion}`);
  }

  const litActions: S2SManifest['litActions'] = {
    prep: raw.litActions.prep,
    render: raw.litActions.render,
    update: raw.litActions.update,
  };
  // Omitted entirely, not carried as undefined: a caller checking for
  // presence must see the same answer the document gives.
  for (const field of OPTIONAL_ACTIONS) {
    if (field in raw.litActions) {
      litActions[field] = raw.litActions[field];
    }
  }

  return {
    version: raw.version,
    gateway: raw.gateway,
    ensRegistry: raw.ensRegistry,
    ensRecords: raw.ensRecords,
    publicationFactory: raw.publicationFactory,
    // The same value, under the name discovery uses. One record, so the two
    // cannot disagree; the duplicate name is the type's, not a second read.
    moduleFactory: raw.publicationFactory,
    recordsFactory: raw.recordsFactory,
    pkp: raw.pkp,
    litActions,
  };

  } catch (error) {
    const errorMsg = errMsg(error);
    console.log("Manifest fetch error:", errorMsg);
    throw error;
  }
};
