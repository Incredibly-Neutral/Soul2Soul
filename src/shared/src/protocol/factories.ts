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
 * The V2 publication factory: `S2SPublicationModuleFactory`, the deployment that
 * created every publication that exists today.
 *
 * Its `ModuleCreated(address indexed safe, address indexed moduleProxy, address
 * implementation)` signature is shared with the V3 factory, so one topic0
 * matches logs from either generation. This constant is the one home for the
 * address: the settings default that still points at it imports it rather than
 * repeating the literal.
 */
export const PUBLICATION_FACTORY_V2 = '0xe948735151c43183accd8e85b992952b2711d554';

/**
 * Retired publication factories whose `ModuleCreated` logs still describe live
 * publications — read together with the factory in the protocol record, because
 * a factory can only answer for the modules it deployed.
 */
export const LEGACY_PUBLICATION_FACTORIES: readonly string[] = [PUBLICATION_FACTORY_V2];
