import { evmRead } from './evm';
import { isPublicationModuleName } from '@s2s/soul2soul-shared/lit-actions';

declare const ethers: any;

const ENS_REGISTRY_ADDRESS = '0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5';

// ============================================================================
// Role discovery — ERC-165 first, and a NAME() fallback for publication only.
//
// A Safe's enabled-module list is an address list and nothing more: anything the
// owners enabled sits on it. A module declares which role it fills by answering
// `supportsInterface(roleId)`. The interface id is a compile-time constant of the
// deployed bytecode, so a contract that does not implement the functions cannot
// claim it; a `NAME()` is a string any contract can copy.
//
// The id is authoritative wherever it is answered, and `false` and a revert both
// mean "not this role". None of the three deployed publication implementations
// answers an id at all: S2SPublicationModule, V2 and V3 extend Initializable and
// UUPSUpgradeable and declare no `supportsInterface`, and they answer one NAME()
// each. So a publication Safe today answers nothing for the publication role.
// Publication discovery therefore keeps the NAME() comparison as a fallback, run
// only when no candidate answered the id, over the same candidates and against
// the same accepted-name set as before. Delete the fallback when a publication
// module that answers `supportsInterface(PUBLICATION_ROLE_ID)` is deployed and
// every live publication has been migrated to it.
//
// Records has no fallback: its module implements ERC-165 and always has.
//
// REQUEST BUDGET. Lit caps a session at 50 HTTP requests, and every eth_call
// costs one request per RPC URL tried — so a call that reverts costs two and a
// call that answers costs one. Counts for this file:
//
//   getProtocolControllerAndModules   ENS walk 4 + probes (records only)
//   getDomainOwnerAndModules          ENS walk 3 + probes (records, publication)
//
// Probes, for the common Safe (4337 module skipped, records module, publication
// module), records asked first and stopping at the first module that answers:
//
//   publication answers the id        3 calls — two records probes, one
//                                     publication probe
//   publication answers only its name 4 calls — the publication probe comes
//   (every publication on Base today) back empty, then one NAME() finds it
//   nothing answers                  one id probe per module per role, then one
//                                     NAME() per module; a module with no NAME()
//                                     reverts, so its NAME() costs two
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
// `type(IPublicationModule).interfaceId` over exactly those 13 selectors, which
// is the surface every version shares, so one id names the role at any version.
// The deal verbs are deliberately outside it: V1 has none of them, and an id a
// version cannot answer makes that publication undiscoverable for good. No
// deployed publication module answers it yet — the contracts must declare the
// interface and return its id, and until they do the NAME() fallback below is
// what finds a publication. Adding to the surface means publishing a new id,
// not editing this one.
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

const NAME_ABI = ['function NAME() view returns (string)'];

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

// A publication module's NAME(), accepted by the same predicate the pre-ERC-165
// discovery used: `S2S Publication Module`, optionally followed by ` V<digits>`.
// Kept identical on purpose — a narrower set would silently drop a publication.
const answersPublicationName = async (
  moduleAddress: string,
  rpcs?: { L1: string[]; L2: string[] },
): Promise<boolean> => {
  try {
    const name = await evmRead('L2', moduleAddress, NAME_ABI, 'NAME', [], rpcs?.L2);
    return isPublicationModuleName(name);
  } catch {
    return false;
  }
};

// The first candidate for which `matches` answers true, or null. Probes run
// `MAX_CONCURRENT_ROLE_PROBES` at a time and stop being issued as soon as one
// answers, so the cost is one probe per module reached before the hit and never
// more than one per module.
const findModule = async (
  candidates: string[],
  matches: (moduleAddress: string) => Promise<boolean>,
): Promise<string | null> => {
  let found: string | null = null;
  let nextIndex = 0;
  const worker = async () => {
    while (found === null && nextIndex < candidates.length) {
      const index = nextIndex++;
      if (await matches(candidates[index])) {
        if (found === null) found = candidates[index];
      }
    }
  };
  const workerCount = Math.max(0, Math.min(MAX_CONCURRENT_ROLE_PROBES, candidates.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return found;
};

/** The first module on `candidates` that answers `roleId`, or null. */
export const findModuleWithRole = (
  candidates: string[],
  roleId: string,
  rpcs?: { L1: string[]; L2: string[] },
): Promise<string | null> => findModule(candidates, (addr) => answersRole(addr, roleId, rpcs));

/**
 * The first module on `candidates` whose NAME() is a publication module's, or
 * null. Only used where no module answered the publication role id; see the
 * header for when it can be deleted.
 */
export const findModuleByPublicationName = (
  candidates: string[],
  rpcs?: { L1: string[]; L2: string[] },
): Promise<string | null> => findModule(candidates, (addr) => answersPublicationName(addr, rpcs));

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

  // Publication: the role id decides when it is answered, and the NAME()
  // fallback is consulted only when no candidate answered it.
  const rest = modules.filter((addr: string) => addr !== configModule);
  const publicationModule =
    (await findModuleWithRole(rest, PUBLICATION_ROLE_ID, rpcs)) ??
    (await findModuleByPublicationName(rest, rpcs));

  return {
    multisig,
    configModule,
    publicationModule,
  };
};
