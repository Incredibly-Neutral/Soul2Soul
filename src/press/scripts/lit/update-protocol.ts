import Safe from "@safe-global/protocol-kit";
import SafeApiKit from "@safe-global/api-kit";
import { createPublicClient, encodeFunctionData, getAddress, http, recoverMessageAddress } from "viem";
// @ts-ignore
import { OperationType } from "@safe-global/types-kit";

import * as dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root is four levels up from <root>/src/press/scripts/lit; resolve the
// env from __dirname so the CWD cannot decide whether it loads.
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') }); // <root>/src/press/.env

// ── ABIs ────────────────────────────────────────────────────────────────────

const recordsModuleAbi = [
  {
    name: "setRecord",
    type: "function",
    inputs: [
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
  },
] as const;

/**
 * Reads the batch needs before it is built: the manifest document already on
 * chain (`getRecord`) and the module's own version (`VERSION`).
 */
const recordsModuleReadAbi = [
  {
    name: "getRecord",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "key", type: "string" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "VERSION",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

/**
 * The one function that tells a gated factory from the superseded one. V2 has
 * no `protocolSafe()` at all, so the call reverting is the signal.
 */
const publicationFactoryAbi = [
  {
    name: "protocolSafe",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const ensRecordsAbi = [
  {
    name: "authorizeCaller",
    type: "function",
    inputs: [
      { name: "caller", type: "address" },
      { name: "authorized", type: "bool" },
    ],
  },
] as const;

// ── Addresses ───────────────────────────────────────────────────────────────

const RECORDS_MODULE_ADDRESS = "0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29";
const ENS_RECORDS_ADDRESS = "0x5D42f9b016B4251FC6407d5e8154DA887F394900";

/**
 * The record key the manifest document is published under, and the prefix of
 * its per-version mirror: `manifest` and `manifest@x.y.z`, the same JSON under
 * both. Readers read `manifest`; the mirror is the version history, so a client
 * pinned to a release still finds the document it was written for.
 */
const MANIFEST_KEY = "manifest";

// One name for this address: `PUBLICATION_FACTORY_ADDRESS`, which is what
// `src/publication/contracts/scripts/deploy-publication-factory.ts` prints and
// what `check-module.ts` and both verify scripts read. Following the deploy
// instructions therefore fills the key this line reads.
//
// No fallback to `PUBLICATION_FACTORY_V2_ADDRESS`. That factory's
// `setImplementation` is callable by anyone, and this record is what every
// client reads, so writing it here would put the hole back on chain and into
// every new publication. Missing key fails before the batch is built.
function requirePublicationFactory(): string {
  const address = process.env.PUBLICATION_FACTORY_ADDRESS;
  if (address) return address;

  throw new Error(
    'PUBLICATION_FACTORY_ADDRESS is not set. Deploy S2SPublicationModuleV4Create2Factory ' +
      '(cd src/publication/contracts && pnpm deploy:pubfac), put the printed ' +
      'PUBLICATION_FACTORY_ADDRESS in .env, and re-run. Not writing the superseded ' +
      'V2 factory to the publication_factory record: its setImplementation is ' +
      'ungated, so anyone could redirect future publications.'
  );
}



// ── Helpers ─────────────────────────────────────────────────────────────────

const setRecord = (key: string, value: string) => ({
  to: RECORDS_MODULE_ADDRESS,
  data: encodeFunctionData({
    abi: recordsModuleAbi,
    functionName: "setRecord",
    args: [key, value],
  }),
  value: "0",
  operation: OperationType.Call,
});

/** BASE_RPC_URL, or the DRPC endpoint built from the key. */
function protocolRpcUrl(): string {
  const rpcUrl =
    process.env.BASE_RPC_URL ||
    (process.env.VITE_DRPC_API_KEY
      ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
      : "");

  if (!rpcUrl) {
    throw new Error(
      "BASE_RPC_URL or VITE_DRPC_API_KEY is needed to check the publication factory " +
        "before writing it to the record."
    );
  }

  return rpcUrl;
}

const protocolClient = () => createPublicClient({ transport: http(protocolRpcUrl()) });

/**
 * The version the manifest document is published as, and the `x.y.z` its mirror
 * key is named after.
 *
 * A constant here, not an environment variable: the document's shape is decided
 * by this repo, so the version is a line in the diff a reviewer sees rather than
 * a value in someone's shell. Bump it here — patch for new action CIDs, minor for
 * a new optional field, major for a shape an older reader must refuse — and the
 * major has to equal `VERSION()` on the records module.
 */
const MANIFEST_VERSION = "1.0.0";

/**
 * Refuse a document the module on chain cannot be read alongside.
 *
 * `VERSION()` is the contract's own version and stays 2.0.0: the document moves
 * without a redeploy, so only the major segment has to agree. Read through the
 * same RPC the factory probe uses.
 */
const assertManifestVersion = async (documentVersion: string): Promise<void> => {
  const client = protocolClient();

  let onChainVersion: string;
  try {
    onChainVersion = await client.readContract({
      address: RECORDS_MODULE_ADDRESS as `0x${string}`,
      abi: recordsModuleReadAbi,
      functionName: "VERSION",
    });
  } catch (error) {
    throw new Error(
      `Could not read VERSION() on ${RECORDS_MODULE_ADDRESS}: ` +
        `${error instanceof Error ? error.message : String(error)}. The document's major ` +
        "segment has to match it, so the batch is not built without it."
    );
  }

  const documentMajor = documentVersion.split(".")[0];
  if (documentMajor !== onChainVersion) {
    throw new Error(
      `The manifest document is ${documentVersion}, whose major is ${documentMajor}, but ` +
        `${RECORDS_MODULE_ADDRESS} answers VERSION() ${onChainVersion}. Every action compares ` +
        "the two and refuses a document whose major differs, so nothing was proposed. Redeploy " +
        "the records module, or publish the document under the major it answers."
    );
  }
};

/**
 * The litActions of the document, in a fixed key order.
 *
 * An action with no CID is omitted, never written as the empty string: a reader
 * cannot tell an absent action from one it must run with no code. The caller's
 * "not deployed" value is whatever `config.json` did not have, i.e. undefined.
 */
const litActionsOf = (actions: {
  prep: string;
  render: string;
  update: string;
  maintainCache?: string;
  repointArchive?: string;
  encrypt?: string;
  decrypt?: string;
}): Record<string, string> => {
  const document: Record<string, string> = {
    prep: actions.prep,
    render: actions.render,
    update: actions.update,
  };

  if (actions.maintainCache) document.maintainCache = actions.maintainCache;
  if (actions.repointArchive) document.repointArchive = actions.repointArchive;
  if (actions.encrypt) document.encrypt = actions.encrypt;
  if (actions.decrypt) document.decrypt = actions.decrypt;

  return document;
};

/** Where each document address comes from, for the refusal message below. */
const MANIFEST_FIELD_SOURCE: Record<string, string> = {
  gateway: "IPFS_URL",
  ensRegistry: "ENS_OPEN_SUBDOMAIN_REGISTRY",
  ensRecords: "ENS_RECORDS_ADDRESS (constant in this file)",
  publicationFactory: "PUBLICATION_FACTORY_ADDRESS",
  recordsFactory: "RECORDS_FACTORY_ADDRESS",
  pkp: "the PKP in config.json",
};

/**
 * The manifest document, as one string: camelCase, no whitespace.
 *
 * Built from exactly the values the batch writes to the flat keys beside it, so
 * the document and the legacy records cannot say different things. Every address
 * is required non-empty: a flat key written empty is a stale record, but the
 * document is the only thing the actions read, and an empty address in it fails
 * every action at once.
 */
function buildManifestDocument(values: {
  version: string;
  gateway: string;
  ensRegistry: string;
  ensRecords: string;
  publicationFactory: string;
  recordsFactory: string;
  pkp: string;
  litActions: Record<string, string>;
}): string {
  for (const field of Object.keys(MANIFEST_FIELD_SOURCE)) {
    const value = (values as unknown as Record<string, string>)[field];
    if (!value) {
      throw new Error(
        `The manifest document cannot be published with an empty ${field} ` +
          `(${MANIFEST_FIELD_SOURCE[field]}). Set it and re-run: every action reads the ` +
          "document, so an empty address there fails all of them. Nothing was proposed."
      );
    }
  }

  return JSON.stringify({
    version: values.version,
    gateway: values.gateway,
    ensRegistry: values.ensRegistry,
    ensRecords: values.ensRecords,
    publicationFactory: values.publicationFactory,
    recordsFactory: values.recordsFactory,
    pkp: values.pkp,
    litActions: values.litActions,
  });
}

/** The `manifest` record as it stands on chain, or the empty string if unset. */
const readManifestRecord = async (): Promise<string> => {
  const client = protocolClient();

  return (await client.readContract({
    address: RECORDS_MODULE_ADDRESS as `0x${string}`,
    abi: recordsModuleReadAbi,
    functionName: "getRecord",
    args: [MANIFEST_KEY],
  })) as string;
};


/**
 * Refuse to write a factory that cannot answer `protocolSafe()`.
 *
 * The V2 factory has no such function and no gate on `setImplementation`, so
 * pasting its address into PUBLICATION_FACTORY_ADDRESS would otherwise be
 * written to the record with a full green run. Same probe `update-impl.ts` uses
 * before it sends an implementation change.
 */
const assertGatedFactory = async (address: string): Promise<void> => {
  const client = protocolClient();

  try {
    const protocolSafe = await client.readContract({
      address: getAddress(address),
      abi: publicationFactoryAbi,
      functionName: "protocolSafe",
    });
    console.log(`publication_factory ${address} is gated on ${protocolSafe}`);
  } catch {
    throw new Error(
      `PUBLICATION_FACTORY_ADDRESS ${address} does not answer protocolSafe(). ` +
        "That is the superseded V2 factory, or not a factory. Its setImplementation is " +
        "callable by anyone, so writing it to the record would re-open the hole for every " +
        "publication created from now on. Deploy S2SPublicationModuleV4Create2Factory " +
        "(cd src/publication/contracts && pnpm deploy:pubfac) and use the address it prints."
    );
  }
};

const proposeToSafe = async (account: any, transactions: any[]) => {
  const protocolKit = await Safe.init({
    provider: `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`,
    signer: process.env.PROTOCOL_PRIVATE_KEY!,
    safeAddress: process.env.PROTOCOL_SAFE_ADDRESS!,
  });

  const apiKit = new SafeApiKit({ chainId: 8453n });

  const safeTransaction = await protocolKit.createTransaction({ transactions });
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  const senderSignature = await protocolKit.signHash(safeTxHash);

  await apiKit.proposeTransaction({
    safeAddress: process.env.PROTOCOL_SAFE_ADDRESS!,
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress: account.address,
    senderSignature: senderSignature.data,
  });

  console.log("✅ Transaction proposed to Safe");
  console.log("Safe Tx Hash:", safeTxHash);
  return safeTxHash;
};

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Full protocol update: the manifest document, and the PKP re-authorized on the
 * ENS records contract. One Safe batch, so owners confirm once.
 *
 * The document is written twice, `manifest` and `manifest@x.y.z` (MANIFEST_VERSION
 * above): readers read the first, the second is the version history. Both carry
 * the same JSON. No flat key is written: the document replaced them, and nothing
 * reads them.
 */
export const updateProtocol = async (
  account: any,
  pkpInfo: { ethAddress: string },
  prepActionCid: string,
  renderActionCid: string,
  updateActionCid: string,
  encryptActionCid: string,
  decryptActionCid: string,
  maintainCacheActionCid?: string,
  repointArchiveActionCid?: string
) => {
  // Before the batch is built: an unset or stale factory address fails here
  // rather than being written to the record, which every client reads.
  const publicationFactory = requirePublicationFactory();
  await assertGatedFactory(publicationFactory);

  // Also before the batch: the module on chain has to answer the major this
  // document is published under, or every action would refuse it.
  await assertManifestVersion(MANIFEST_VERSION);

  const gateway = process.env.IPFS_URL || "";
  const ensRegistry = process.env.ENS_OPEN_SUBDOMAIN_REGISTRY || "";
  const recordsFactory = process.env.RECORDS_FACTORY_ADDRESS || "";

  const document = buildManifestDocument({
    version: MANIFEST_VERSION,
    gateway,
    ensRegistry,
    ensRecords: ENS_RECORDS_ADDRESS,
    publicationFactory,
    recordsFactory,
    pkp: pkpInfo.ethAddress,
    litActions: litActionsOf({
      prep: prepActionCid,
      render: renderActionCid,
      update: updateActionCid,
      maintainCache: maintainCacheActionCid,
      repointArchive: repointArchiveActionCid,
      encrypt: encryptActionCid,
      decrypt: decryptActionCid,
    }),
  });

  const transactions = [
    // The manifest document: the only thing any reader reads, and its
    // per-version mirror, which is the history.
    setRecord(MANIFEST_KEY, document),
    setRecord(`${MANIFEST_KEY}@${MANIFEST_VERSION}`, document),

    // Re-authorize the PKP on the ENS records contract (INV-12)
    {
      to: ENS_RECORDS_ADDRESS,
      data: encodeFunctionData({
        abi: ensRecordsAbi,
        functionName: "authorizeCaller",
        args: [getAddress(pkpInfo.ethAddress), true],
      }),
      value: "0",
      operation: OperationType.Call,
    },
  ];

  return proposeToSafe(account, transactions);
};

/**
 * Actions-only update: rotate CIDs without touching the PKP or ENS auth.
 * Use when re-deploying Lit actions between protocol key rotations.
 *
 * The document already on chain is patched rather than rebuilt: only
 * `litActions.prep/render/update` and the version, so the addresses and whatever
 * optional CIDs were published survive a rotation. The patched document goes out
 * under `manifest` and `manifest@x.y.z`.
 */
export const updateActions = async (
  account: any,
  prepActionCid: string,
  renderActionCid: string,
  updateActionCid: string,
) => {
  await assertManifestVersion(MANIFEST_VERSION);

  // There is nothing to patch if no document was ever published: an
  // actions-only rotation cannot invent the addresses, and writing a document
  // with them missing would fail every action.
  const current = await readManifestRecord();
  if (!current) {
    throw new Error(
      `No '${MANIFEST_KEY}' record on ${RECORDS_MODULE_ADDRESS}. Run pnpm update-protocol ` +
        "first: an actions-only rotation patches the published document, and there is none."
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(current);
  } catch (error) {
    throw new Error(
      `The '${MANIFEST_KEY}' record is not valid JSON: ` +
        `${error instanceof Error ? error.message : String(error)}. Fix it with a full ` +
        "pnpm update-protocol rather than patching it here."
    );
  }

  const document = buildManifestDocument({
    version: MANIFEST_VERSION,
    gateway: parsed?.gateway,
    ensRegistry: parsed?.ensRegistry,
    ensRecords: parsed?.ensRecords,
    publicationFactory: parsed?.publicationFactory,
    recordsFactory: parsed?.recordsFactory,
    pkp: parsed?.pkp,
    // The three rotating CIDs replace the published ones; every optional CID is
    // carried across as it stands.
    litActions: litActionsOf({
      ...(parsed?.litActions ?? {}),
      prep: prepActionCid,
      render: renderActionCid,
      update: updateActionCid,
    }),
  });

  const transactions = [
    setRecord(MANIFEST_KEY, document),
    setRecord(`${MANIFEST_KEY}@${MANIFEST_VERSION}`, document),
  ];

  return proposeToSafe(account, transactions);
};

// ── Entry point ──────────────────────────────────────────────────────────────

const main = async () => {
  const config = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8');
  const group = JSON.parse(config).groups.find((g: any) => g.name === 's2s');

  if (!group) throw new Error("Group 's2s' not found in config.json");

  const pkpInfo = { ethAddress: group.pkps[0] };
  console.log("PKP:", pkpInfo);

  const account = privateKeyToAccount(`0x${process.env.PROTOCOL_PRIVATE_KEY!}` as `0x${string}`);

  const encrypt = group.actions.find((a: any) => a.name === 'encrypt');
  const decrypt = group.actions.find((a: any) => a.name === 'decrypt');
  const prep    = group.actions.find((a: any) => a.name === 'prep');
  const render  = group.actions.find((a: any) => a.name === 'render');
  const update  = group.actions.find((a: any) => a.name === 'update');
  const maintainCache = group.actions.find((a: any) => a.name === 'maintain-cache');
  const repointArchive = group.actions.find((a: any) => a.name === 'repoint-archive');

  if (!prep || !render || !update) {
    throw new Error(`Missing action CIDs. Found: ${JSON.stringify(group.actions.map((a: any) => a.name))}`);
  }
  // Both draft actions must be registered before their record is written: a
  // record naming a CID that no swap produced would point every client at code
  // the enclave cannot run.
  if (!encrypt || !decrypt) {
    throw new Error(
      'Run pnpm actions:swap encrypt and pnpm actions:swap decrypt before this — ' +
        `config.json has: ${JSON.stringify(group.actions.map((a: any) => a.name))}`,
    );
  }

  console.log("Action CIDs:", {
    prep: prep.cid,
    render: render.cid,
    update: update.cid,
    encrypt: encrypt.cid,
    decrypt: decrypt.cid,
    maintainCache: maintainCache?.cid ?? '(not deployed)',
    repointArchive: repointArchive?.cid ?? '(not deployed)',
  });

  await updateProtocol(
    account,
    pkpInfo,
    prep.cid,
    render.cid,
    update.cid,
    encrypt.cid,
    decrypt.cid,
    maintainCache?.cid,
    repointArchive?.cid,
  );
};

main()
  .catch((error: any) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });