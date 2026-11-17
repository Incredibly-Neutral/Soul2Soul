export const ENS_NAMEWRAPPER = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';

// ---------------------------------------------------------------------------
// The manifest module — the protocol Safe's own module, holding one versioned
// JSON document: the addresses and action CIDs of this deployment.
//
// A constant, not something to discover: the address is fixed by the factory's
// CREATE2 salt, so a reader has it without a scan, an ENS walk or a record read.
// ---------------------------------------------------------------------------

/** `S2SManifestModuleV0_1`, the protocol Safe's own module. */
export const MANIFEST_MODULE_ADDRESS = '0x0CbCB9FbbEA0A8DE0547fDb5389b24edB447873F';

/** The record a publication keeps to name the manifest document it follows. */
export const MANIFEST_VERSION_KEY = 'manifest_version';
// ---------------------------------------------------------------------------
// Module kinds — the two kinds a publication's Safe installs.
//
// A module's kind is its identity in the factory: implementations are approved
// per kind, `latestImplementation` is per kind, and an implementation declares
// the kind it serves. One module per (safe, kind), for good.
// ---------------------------------------------------------------------------

/** `keccak256("s2s.module.publication")` — the publication module's kind. */
export const S2S_MODULE_KIND_PUBLICATION =
  '0x93cd3ffe1e9b7c92722da085a6b913d81fbc5e78f3580dc68ad71939359d0edc';

/** `keccak256("s2s.module.records")` — the records module's kind. */
export const S2S_MODULE_KIND_RECORDS =
  '0x32af023b4fa285854135acd8d8f76ae902589e07e53598d9ded061f3398448bf';
