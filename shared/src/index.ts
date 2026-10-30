export * from './helpers';

export * from './rpc';

// authoring — pure, host-agnostic authoring logic (tags, note parse, links,
// revoke-path, publication resolution) shared by neutralpress + author-cli
// (SPEC-00 §0 single source). Not re-exported from ./lit-actions (INV-7).
export * from './authoring';

export * from './protocol';
export * from './contracts';
export * from './cid-view';
export * from './ipfs';
export * from './publication';

// rendering — includes the new content-item types (canonical)
export * from './rendering';

// lit — LitService + actions + types
export * from './lit';

// pin
export * from './pin';

// heal — pin a remote CID across providers
export * from './heal';

// metadata (provenance for rendered HTML, separate from content-item)
export type { S2SContentInfo } from './metadata';

// content — deprecated Lens-era types, re-exported under aliases to avoid clash with rendering
export type {
  S2SPublicContent as S2SLegacyPublicContent,
  S2SToEncrypt as S2SLegacyToEncrypt,
  S2SContentItem as S2SLegacyContentItem,
} from './content';


// manuscript — the authored thing: content-item types, canonical form, proof
export * from './manuscript';