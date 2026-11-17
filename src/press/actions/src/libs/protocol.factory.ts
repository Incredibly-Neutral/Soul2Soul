import { evmRead } from "./evm";
import type { S2SManifest } from '@s2s/soul2soul-shared/lit-actions';
import { Abi_S2SRecordsModule } from '@s2s/publication-contracts/abis/S2SRecordsModule'

// The protocol's records module on Base: `configModule` for soul2soul.eth, the
// address update-protocol.ts and repoint-record.ts write to — and the module
// `getManifest` reads its records from.
//
// This is the bootstrap root, and no factory resolves it: it holds the
// `publication_factory` record, so this address is where the factory address
// comes from, and asking the factory for it would be circular. The deployment
// is a plain CREATE, which no factory made, so no factory knows it either. It
// is not one of the two kinds `ens.factory` reads from that factory, and it is
// not the author-side path either; it is this record's own module, held as a
// constant and read directly, for that reason — not as a request-budget
// shortcut.
//
// A redeploy of the records module makes this constant stale without error: the
// read answers empty on the old address, so getManifest throws for want of
// the `publication_factory` record rather than discovering a module it cannot
// identify. See SPEC-protocol-actions.md, Gotchas.
const PROTOCOL_RECORDS_MODULE = '0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29';

const RECORD_ABI = ['function getRecord(string key) view returns (string)'];

/**
 * The `publication_factory` record on its own: one eth_call, no ENS walk.
 *
 * Read before an action's authorization gate so module discovery can ask the
 * factory which modules this Safe owns, and cheap enough that a call the gate
 * then rejects has spent one request rather than the protocol walk. null when
 * the record is absent or unreadable, which every caller treats as a failure:
 * discovery has no other source.
 */
export const getPublicationFactory = async (rpcs?: { L1: string[]; L2: string[] }): Promise<string | null> => {
  try {
    const factory = await evmRead('L2', PROTOCOL_RECORDS_MODULE, RECORD_ABI, 'getRecord', ['publication_factory'], rpcs?.L2);
    return typeof factory === 'string' && factory.length > 0 ? factory : null;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log('publication_factory record unreadable:', errorMsg);
    return null;
  }
};

/**
 * Every record an action needs, plus the factory discovery was built from.
 *
 * Costs one `getRecord` (unless the caller passes the factory) plus one
 * `getRecords`: the records module is held as a constant, so no ENS walk is paid
 * to find it, and there is no walk output to null-check.
 *
 * The `publication_factory` record is read once: a call with no
 * `publicationFactory` argument spends one read here, a call that passes one
 * (the gating actions, which read it before their authorization gate so a
 * rejected call pays one request instead of the walk) spends none. A null
 * argument is a failure, not a skip: discovery has no other source.
 *
 * Two factory fields are returned because S2SManifest declares both and
 * both are the same record: `moduleFactory` is the value discovery actually
 * used, `publicationFactory` the copy `configModule` publishes in getRecords.
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

  const factoryForDiscovery = publicationFactory === undefined
    ? await getPublicationFactory(rpcs)
    : publicationFactory;
  if (!factoryForDiscovery) {
    throw new Error("Failed to read the publication_factory record; module discovery needs it");
  }

  // The records module is the protocol's root, held above as a constant: it is
  // the module the `publication_factory` record was read from, so it cannot be
  // discovered through the factory it bootstraps.
  const [dataGateway, ensRecords, ensRegistry, publicationFactoryRecord, recordsFactory, pkpEthAddress, litActionPrep, litActionRender, litActionUpdate ] = await evmRead("L2", PROTOCOL_RECORDS_MODULE, Abi_S2SRecordsModule, "getRecords", [["data_gateway","ens_records","ens_registry","publication_factory","records_factory","pkp_ethAddress", "lit_action_prep", "lit_action_render", "lit_action_update"]], rpcs?.L2);

    return {
      gateway: dataGateway,
      ensRegistry: ensRegistry,
      ensRecords,
      publicationFactory: publicationFactoryRecord,
      moduleFactory: factoryForDiscovery,
      recordsFactory,
      pkp: pkpEthAddress,
      litActions: {
        prep: litActionPrep,
        render: litActionRender,
        update: litActionUpdate,
      },
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log("Manifest fetch error:", errorMsg);
    throw error;
  }
};
