// Narrow subpath entry for the rendering content-item schema.
//
// Lit-action bundles import this instead of the ROOT barrel
// ('@s2s/soul2soul-shared') so the render action pulls only zod + the
// content-item schema — never the full shared graph (helpers/protocol/
// contracts/ipfs/publication/lit/pin/identity). Importing the root barrel
// from a Lit action was the cause of the nginx 413 (2.6MB render bundle).
//
// NOTE: this module is zod-based by design — the render action validates
// archived content items against s2sContentItemSchema at runtime.
export { s2sContentItemSchema } from './action-io';
