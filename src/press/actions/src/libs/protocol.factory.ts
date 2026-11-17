import { evmRead } from "./evm";
import type { S2SManifest } from '@s2s/soul2soul-shared/lit-actions';

// The manifest module on Base: the protocol Safe's own module, holding the
// versioned JSON document every action reads. A constant, because the document
// is the root — it holds the factory, the gateway, the ENS registries and the
// action CIDs, so nothing above it can be asked for its address. The module's
// address is fixed by the factory's CREATE2 salt and does not move when a CID
// does; only the document's version moves.
const MANIFEST_MODULE = '0x0CbCB9FbbEA0A8DE0547fDb5389b24edB447873F';

// Two ABIs, not one with two `getManifest` entries: ethers tells the overloads
// apart by their arguments, and one ABI makes the no-argument call answer the
// versioned overload's shape.
const MANIFEST_CURRENT_ABI = [
  'function getManifest() view returns (string version, string json)',
];
const MANIFEST_VERSIONED_ABI = ['function getManifest(string version) view returns (string json)'];

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
 * The manifest: every address the action needs, and the action CIDs, as one
 * versioned document on the manifest module.
 *
 * One call, on the constant:
 *
 *   `getManifest()` — `(version, json)`, the current document. Every address and
 *   CID comes from it, including the factory discovery asks. A `version`
 *   argument reads `getManifest(version)` instead, the snapshot published under
 *   that version, which is history and never moves.
 *
 * No ENS walk, no records module, no `VERSION()` comparison: the document names
 * its own version, and the module carries no version of its own. The address is
 * the identity. A reader that had to discover the module would be asking the
 * document's own contents for the document.
 *
 * Validated by hand rather than with the shared zod schema: zod cannot enter an
 * action bundle. A missing document, unparsable JSON, a bad shape and an index
 * that disagrees with the document each throw an error naming the version read.
 *
 * Typed against the shared `S2SManifest` so the two readers cannot drift in
 * shape. Only the type crosses the package boundary: the shared reader itself
 * is viem and cannot enter an action bundle.
 */
export const getManifest = async (
  rpcs?: { L1: string[]; L2: string[] },
  version?: string,
): Promise<S2SManifest> => {

  try {

  let key: string | undefined;
  let document: unknown;
  try {
    if (version) {
      key = version;
      document = await evmRead(
        'L2',
        MANIFEST_MODULE,
        MANIFEST_VERSIONED_ABI,
        'getManifest',
        [version],
        rpcs?.L2,
      );
    } else {
      const answered = await evmRead(
        'L2',
        MANIFEST_MODULE,
        MANIFEST_CURRENT_ABI,
        'getManifest',
        [],
        rpcs?.L2,
      );
      key = answered.version;
      document = answered.json;
    }
  } catch (error) {
    fail(
      `cannot read ${version ? `version ${version}` : 'the current version'} on ` +
        `${MANIFEST_MODULE}: ${errMsg(error)}`,
    );
  }
  if (!isNonEmptyString(document)) {
    fail(`version ${key} is empty on ${MANIFEST_MODULE}`);
  }

  let raw: any;
  try {
    raw = JSON.parse(document as string);
  } catch (error) {
    fail(`version ${key} is not valid JSON: ${errMsg(error)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`version ${key} is not a JSON object`);
  }

  if (typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(raw.version)) {
    fail(`'version' is missing or not x.y.z (got ${JSON.stringify(raw.version)})`);
  }
  if (key && raw.version !== key) {
    fail(`version ${key} carries document version ${raw.version}, not ${key}`);
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

  // The index and the document are written together, so they cannot disagree.
  // Either one answering a different version is a bad write, not a fallback.
  if (key && raw.version !== key) {
    fail(`version ${key} carries document version ${raw.version}, not ${key}`);
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
