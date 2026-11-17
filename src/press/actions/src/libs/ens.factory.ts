import { evmGetCode, evmRead } from './evm';

declare const ethers: any;

const ENS_REGISTRY_ADDRESS = '0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5';

// ============================================================================
// Module discovery — the factory the `publication_factory` record names.
//
// Two kinds are resolved here: the publication module and the records module.
// The read targets the factory the protocol's `publication_factory` record
// names, not whichever factory deployed the Safe. It answers
// `moduleAddress(safe, bytes32 kind)`
// (S2SPublicationModulesFactoryV0_1.sol:299-304): the module it recorded for that
// Safe and kind, otherwise a fresh prediction computed from the init code hash
// and the salt, and `address(0)` when no implementation is set for the kind. A
// Safe this factory has no record of therefore still gets an answer. The answer
// counts only when code is deployed at it: a prediction with no code, and the
// zero answer, are both "no module".
//
// A revert happens when the `publication_factory` record itself names a factory
// older than the `moduleAddress` method: the call has no such function, so the
// read fails, the action fails loudly, and the publication is refused. Nothing
// here separates that revert from a transport failure, and nothing tries to:
// ethers v5 wraps a transport SERVER_ERROR as CALL_EXCEPTION with `data="0x"`,
// indistinguishable from a contract revert, which is why the
// transport-versus-revert distinction was attempted and reverted in evm.ts
// (GAP-15, SPEC-system-contract.md:251). So the rule is fail closed: a factory
// that does not answer refuses the publication, and that refusal is an error,
// never a null module. The caller turns both into one refusal: the same
// sentence, with the read's own message appended when the read failed.
//
// The author Safe's drafts and owner-history modules are a different authority,
// not a path with no factory. `shared/src/gates/modules.ts` asks a factory for
// `draftsModuleAddress` / `ownerHistoryModuleAddress` too (:46-60), but there
// those answers are only probe order: the Safe's `getModulesPaginated` list
// (:197) and `supportsInterface` (:149) decide. This change does not touch that
// path.
//
// `PROTOCOL_RECORDS_MODULE` is resolved neither way. It is the protocol's own
// records module (`configModule` for soul2soul.eth) and the bootstrap root: it
// holds the `publication_factory` record, so it is where the factory address
// comes from, and asking any factory for it would be circular. It is a
// plain-CREATE deployment held as a constant in protocol.factory.ts. Those two
// kinds above are the module addresses this package resolves, and the named
// factory is their only source.
//
// Request budget, one request per RPC URL tried and never retried in-session
// (see evm.ts; Lit caps a session at 50 HTTP requests):
//
//   getDomainOwnerAndModules   nameWrapper + ownerOf (2), then one
//                              moduleAddress per kind (2) and one evmGetCode
//                              per non-zero answer (at most 2)
//
// The bound is per URL list, because a failed request spends every URL in its
// chain's list: at most 6 requests with one URL per chain, at most 8 with two
// (the two ENS reads once, the two kind reads on both URLs, the two code reads
// once), and at most 10 if a code read fails over too, which throws.
// ============================================================================

// `keccak256("s2s.module.publication")` and `keccak256("s2s.module.records")`,
// the bytes32 kinds the factory records modules under. The app holds the same
// pair as S2S_MODULE_KIND_PUBLICATION / S2S_MODULE_KIND_RECORDS in
// `shared/src/protocol/constants.ts`. Computing them here is what makes the
// pairs comparable at all, but the derivation alone does not hold them
// together: the pairing is pinned by `module-kinds.test.ts`, which loads these
// exports with the real `ethers` installed and compares them against the shared
// constants and their hex. Exported for that test alone — no call site outside
// this module reads them. `ethers` is the bundle's runtime global.
export const PUBLICATION_KIND: string = ethers.utils.id('s2s.module.publication');
export const RECORDS_KIND: string = ethers.utils.id('s2s.module.records');

const MODULE_ADDRESS_ABI = [
  'function moduleAddress(address safe, bytes32 kind) view returns (address)',
];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * The module the factory names for (`safe`, `kind`), or null when it names the
 * zero address or an address with no code at it.
 *
 * No read here is caught. A factory that does not answer `moduleAddress` — an
 * older build that has none — makes `evmRead` throw, and that error propagates:
 * the caller turns it into a refusal, and the action fails. A failed read is
 * never returned as null, because null means the factory answered and named
 * nothing.
 */
const moduleAt = async (
  publicationFactory: string,
  safe: string,
  kind: string,
  rpcs?: { L1: string[]; L2: string[] },
): Promise<string | null> => {
  const answer = await evmRead(
    'L2',
    publicationFactory,
    MODULE_ADDRESS_ABI,
    'moduleAddress',
    [safe, kind],
    rpcs?.L2,
  );
  if (typeof answer !== 'string' || answer === ZERO_ADDRESS) return null;
  const code = await evmGetCode('L2', answer, rpcs?.L2);
  return typeof code === 'string' && code !== '0x' ? answer : null;
};

/**
 * The publication Safe's owner, its records module, and its publication module.
 *
 * `publicationFactory` is the factory the `publication_factory` record names,
 * and it is required: these two kinds are read from it and from nowhere else.
 * A module it cannot name with code at it is null; a factory that does not
 * answer throws. The caller refuses the publication either way.
 */
export const getDomainOwnerAndModules = async (
  publication: string,
  rpcs: { L1: string[]; L2: string[] } | undefined,
  publicationFactory: string,
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

  const configModule = await moduleAt(publicationFactory, multisig, RECORDS_KIND, rpcs);
  const publicationModule = await moduleAt(publicationFactory, multisig, PUBLICATION_KIND, rpcs);

  return {
    multisig,
    configModule,
    publicationModule,
  };
};
