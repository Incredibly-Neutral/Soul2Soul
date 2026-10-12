// Bundling entry — pulls shared's filecoin core + node CAR builder (and their
// deps: @filoz/synapse-sdk, @ipld/car, viem, filecoin-pin, multiformats) into
// one self-contained ESM file that plain `node` can import. esbuild falls back
// to `main` for no-exports packages that Node's strict ESM resolver rejects.
export { FilecoinStorage } from '../../shared/src/filecoin/index.js';
export { nodeFilecoinBuilder } from '../../shared/src/filecoin/car-builder/node.js';
