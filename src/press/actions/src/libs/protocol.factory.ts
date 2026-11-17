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
 * The `publication_factory` record on its own: one eth_call, no ENS walk.
 *
 * Read before an action's authorization gate so module discovery can ask the
 * factory which modules this Safe owns, and cheap enough that a call the gate
 * then rejects has spent one request rather than the manifest read plus
 * discovery. null when the record is absent or unreadable, which every caller
 * treats as a failure: discovery has no other source.
 */
export const getPublicationFactory = async (rpcs?: { L1: string[]; L2: string[] }): Promise<string | null> => {
  try {
    const factory = await evmRead('L2', PROTOCOL_RECORDS_MODULE, RECORD_ABI, 'getRecord', ['publication_factory'], rpcs?.L2);
    return typeof factory === 'string' && factory.length > 0 ? factory : null;
  } catch (error) {
    const errorMsg = errMsg(error);
    console.log('publication_factory record unreadable:', errorMsg);
    return null;
  }
};

/**
 * The manifest document, and the module version it is read alongside.
 *
 * Two reads, both on the records module held above as a constant:
 *
 *   1. `getRecord('manifest')` — the JSON document every address and action
 *      CID comes from. No key list: the flat keys it replaced are still
 *      written by update-protocol.ts for clients that predate the document,
 *      but this reader has no fallback to them.
 *   2. `VERSION()` — the contract's own version, compared on its first segment
 *      only. The module is not redeployed when the document moves: VERSION()
 *      stays 2.0.0 and the document carries 2.1.0, and only a different major
 *      is a document this module cannot be read alongside.
 *
 * No ENS walk and no configModule discovery: the constant is the root, so
 * there is nothing above it to ask.
 *
 * Validated by hand rather than with the shared zod schema: zod cannot enter an
 * action bundle. A missing record, unparsable JSON, a bad shape and a major
 * mismatch each throw an error naming `manifest`.
 *
 * `publicationFactory` is a caller that already read the record before its
 * authorization gate (the gating actions do, so a rejected call pays one
 * request instead of this read plus discovery). When it is given, discovery
 * uses it — `moduleFactory` is the value discovery actually used — while
 * `publicationFactory` in the result stays the copy the document publishes. A
 * null argument is a failure, not a skip: that read failed, and discovery has
 * no other source.
 *
 * Typed against the shared `S2SManifest` so the two readers cannot drift in
 * shape. Only the type crosses the package boundary: the shared reader itself
 * is viem and cannot enter an action bundle.
 */
export const getManifest = async (
  dev: boolean,
  rpcs?: { L1: string[]; L2: string[] },
  publicationFactory?: string | null,
): Promise<S2SManifest> => {

  try {

  if (publicationFactory === null) {
    throw new Error("Failed to read the publication_factory record; module discovery needs it");
  }

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

  // The contract's own version, on the same address, and only its major
  // segment constrains the document.
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
  const onChainMajor = (onChainVersion as string).split('.')[0];
  if (documentMajor !== onChainMajor) {
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
    // Discovery ran with the factory the caller paid for, or the document's
    // when the caller had not read one yet. Same record either way.
    moduleFactory: publicationFactory ?? raw.publicationFactory,
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
