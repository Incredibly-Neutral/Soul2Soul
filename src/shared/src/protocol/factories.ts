// ============================================================================
// Publication factories — the addresses a module scan has to look at.
//
// The module addresses of a publication are not stored anywhere: the Safe only
// knows the modules are enabled, not which factory deployed them. Discovery
// therefore reads the factory's own `ModuleCreated` log, and a factory can only
// answer for the modules it deployed.
//
// `publication_factory` names one factory at a time. When it moves to a new
// implementation (V2 → V3), every publication created before the move has its
// log on the old factory only, so a scan of the record alone finds nothing and
// the flow proposes a second module pair for a publication that already has
// one. The factories below are the retired deployments still holding those
// logs; the scan unions them with the address from the record.
//
// This is a read list, not a migration: nothing is rewritten, no record field
// is added, and a scan that finds a module here adopts it exactly as if the
// record had pointed at that factory.
// ============================================================================

/**
 * Retired publication factories whose `ModuleCreated` logs still describe live
 * publications.
 *
 * `0xe948…d554` — the S2SPublicationModuleFactory deployment
 * (`Abi_S2SPublicationModuleV2Factory`: same `ModuleCreated(address indexed
 * safe, address indexed moduleProxy, address implementation)` signature, so one
 * topic0 matches logs from either generation). Every publication that exists
 * today was created by it.
 */
export const LEGACY_PUBLICATION_FACTORIES: readonly string[] = [
  '0xe948735151c43183accd8e85b992952b2711d554',
];
