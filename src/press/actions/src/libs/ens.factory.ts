import { evmRead } from './evm';

declare const ethers: any;

const ENS_REGISTRY_ADDRESS = '0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5';

// ============================================================================
// Role discovery — ERC-165, one probe per module per role.
//
// A Safe's enabled-module list is an address list and nothing more: anything the
// owners enabled sits on it. A module declares which role it fills by answering
// `supportsInterface(roleId)`, so discovery asks that instead of reading a
// string. A `NAME()` is copyable by any contract, and the S2S modules answer
// three different strings for one role; the interface id is a compile-time
// constant of the deployed bytecode and cannot be copied into a contract that
// does not implement the functions.
//
// REQUEST BUDGET. Lit caps a session at 50 HTTP requests, and every eth_call
// costs one request per RPC URL tried — so a call that reverts costs two and a
// call that answers `false` costs one. Counts for this file:
//
//   getProtocolControllerAndModules   ENS walk 4 + probes
//   getDomainOwnerAndModules          ENS walk 3 + probes
//   probes: at most two per module, one per role. Records is asked first and
//   stops at the first module that answers; publication is asked only of what
//   is left. The common Safe — 4337 module, records module, publication module
//   — costs 3 probes: records is asked of both probeable modules in one round
//   (only one can answer) and publication is asked of the one left over.
//
// A module that answers no S2S interface costs one request (a clean `false`) or
// two (no such function, so the call reverts), which is what the NAME() probe
// it replaces cost.
// ============================================================================

// `type(IS2SRecordsModule).interfaceId` — the XOR of the 14 selectors declared
// on the records interface in
// `src/publication/contracts/src/S2SRecordsModule.sol`: NAME, VERSION, safe,
// setRecord, setRecords, deleteRecord, getRecord, getRecords, recordExists,
// getAllKeys, getAllRecords, getRecordCount, getKeyAtIndex, supportsInterface.
// Verified against solc 0.8.28; the deployed module already answers it.
export const RECORDS_ROLE_ID = '0x19c3e04a';

// The publication role's minimum surface, shared unchanged by
// S2SPublicationModule (V1), V2 and V3 — NAME, safe, canPublish, and the
// author/dev whitelist with its caps:
//
//   NAME()  safe()  canPublish(address)
//   whitelistAuthor(address)  removeWhitelistedAuthor(address)  isWhitelistedAuthor(address)
//   whitelistDev(address)     removeWhitelistedDev(address)     isWhitelistedDev(address)
//   getWhitelistedAuthors()   getWhitelistedDevs()
//   MAX_WHITELISTED_AUTHORS() MAX_WHITELISTED_DEVS()
//
// `type(IPublicationModule).interfaceId` over exactly those 13 selectors, so
// every version answers one id. The deal verbs are deliberately outside it:
// V1 has none of them, and an id a live version cannot answer makes that
// publication undiscoverable for good. Adding to the surface means publishing a
// new id, not editing this one.
export const PUBLICATION_ROLE_ID = '0x342c5c11';

const SUPPORTS_INTERFACE_ABI = [
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
];

// Known enabled modules on the publication Safe that answer no S2S role, so
// probing them can never find one and only spends requests. With the ERC-165
// probe this is an optimisation, not a special case: the module below would be
// asked `supportsInterface` and would answer nothing, exactly like any other
// non-S2S module. Skipping it saves the one or two requests that answer costs.
//
// Provenance: the canonical Safe Account Abstraction (4337) Module at
// 0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226 — SAFE_4337_MODULE_ADDRESS per
// @safe-global/safe-modules-deployments safe-4337-module/v0.3.0 (and mirrored
// in permissionless's toSafeSmartAccount.ts). Safe 1.4.1 + EntryPoint 0.7 on
// Base 8453.
const KNOWN_NON_S2S_MODULES: string[] = ['0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226'];

// Compare addresses in canonical lowercase form so a lower/checksum-case
// mismatch can't defeat the KNOWN_NON_S2S_MODULES filter.
const isKnownNonS2SModule = (address: string): boolean =>
  KNOWN_NON_S2S_MODULES.some((known) => known.toLowerCase() === address.toLowerCase());

// Max simultaneous role probes. pageSize is 10 — keep the fan-out well under it
// so a single prep/render/update can't burst ~10-20 connections (a root cause of
// intermittent ECONNRESET / 'missing response' transport failures).
const MAX_CONCURRENT_ROLE_PROBES = 3;

// One module, one role, one eth_call. A revert (no such function) and a `false`
// mean the same thing — not ours — so neither is an error here. A transport
// failure also reads as not ours: evmRead already tried each RPC URL once, and
// the action then fails on the missing role instead of spending more of the
// session's request budget on a retry (see evm.ts).
const answersRole = async (
  moduleAddress: string,
  roleId: string,
  rpcs?: { L1: string[]; L2: string[] },
): Promise<boolean> => {
  try {
    const supported = await evmRead(
      'L2',
      moduleAddress,
      SUPPORTS_INTERFACE_ABI,
      'supportsInterface',
      [roleId],
      rpcs?.L2,
    );
    return supported === true;
  } catch {
    return false;
  }
};

/**
 * The first module on `candidates` that answers `roleId`, or null. Probes run
 * `MAX_CONCURRENT_ROLE_PROBES` at a time and stop being issued as soon as one
 * answers, so the cost is the number of modules reached before the hit and
 * never more than one probe per module. A smaller list than the fan-out costs
 * one probe per module, which is why a three-module Safe with the 4337 module
 * skipped spends two probes here and one more for the second role.
 */
export const findModuleWithRole = async (
  candidates: string[],
  roleId: string,
  rpcs?: { L1: string[]; L2: string[] },
): Promise<string | null> => {
  let found: string | null = null;
  let nextIndex = 0;
  const worker = async () => {
    while (found === null && nextIndex < candidates.length) {
      const index = nextIndex++;
      if (await answersRole(candidates[index], roleId, rpcs)) {
        if (found === null) found = candidates[index];
      }
    }
  };
  const workerCount = Math.max(0, Math.min(MAX_CONCURRENT_ROLE_PROBES, candidates.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return found;
};

const getModuleList = async (safe: string, rpcs?: { L1: string[]; L2: string[] }) => {
  const [modules] = await evmRead(
    'L2',
    safe,
    [
      'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] memory array, address next)',
    ],
    'getModulesPaginated',
    ['0x0000000000000000000000000000000000000001', 10],
    rpcs?.L2,
  );
  return (modules as string[]).filter((addr: string) => !isKnownNonS2SModule(addr));
};

export const getProtocolControllerAndModules = async (rpcs?: { L1: string[]; L2: string[] }) => {
  try {
    const subdomainNode = ethers.utils.namehash('soul2soul.eth');
    const nameWrapperAddress = await evmRead(
      'L1',
      ENS_REGISTRY_ADDRESS,
      ['function nameWrapper() view returns (address)'],
      'nameWrapper',
      [],
      rpcs?.L1,
    );
    const customRegistry = await evmRead(
      'L1',
      nameWrapperAddress,
      ['function ownerOf(uint256 id) view returns (address)'],
      'ownerOf',
      [subdomainNode],
      rpcs?.L1,
    );
    const controller = await evmRead(
      'L1',
      customRegistry,
      ['function parentDomainController() view returns (address)'],
      'parentDomainController',
      [],
      rpcs?.L1,
    );

    const configModule = await findModuleWithRole(
      await getModuleList(controller, rpcs),
      RECORDS_ROLE_ID,
      rpcs,
    );

    return {
      multisig: controller,
      configModule,
    };
  } catch (error) {
    console.error('Error getting publication addresses:', error);
    return {
      multisig: null,
      configModule: null,
    };
  }
};

export const getDomainOwnerAndModules = async (
  publication: string,
  rpcs?: { L1: string[]; L2: string[] },
) => {
  const nameWrapperAddress = await evmRead(
    'L1',
    ENS_REGISTRY_ADDRESS,
    ['function nameWrapper() view returns (address)'],
    'nameWrapper',
    [],
    rpcs?.L1,
  );
  const subdomainNode = ethers.utils.namehash(publication);
  const multisig = await evmRead(
    'L1',
    nameWrapperAddress,
    ['function ownerOf(uint256 id) view returns (address)'],
    'ownerOf',
    [subdomainNode],
    rpcs?.L1,
  );

  const modules = await getModuleList(multisig, rpcs);

  const configModule = await findModuleWithRole(modules, RECORDS_ROLE_ID, rpcs);
  const publicationModule = await findModuleWithRole(
    modules.filter((addr: string) => addr !== configModule),
    PUBLICATION_ROLE_ID,
    rpcs,
  );

  return {
    multisig,
    configModule,
    publicationModule,
  };
};
