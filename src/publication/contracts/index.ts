// The package entry point. Hand-written because the generated barrel
// (`generated/abis/index.ts`) is rewritten by `hardhat compile` from the
// artifacts the sources compile to, so an export added there is dropped on the
// next compile.
export * from './generated/abis/index.js';

// The standalone records factory the deployed protocol still answers. Its source
// was part of `S2SRecordsModule.sol`, which this tree no longer has, so there is
// nothing to regenerate it from: it lives in `legacy/`, which `pnpm clean` does
// not remove.
export {Abi_S2SRecordsModuleFactory as S2SRecordsModuleFactory} from './legacy/S2SRecordsModuleFactory.js';
