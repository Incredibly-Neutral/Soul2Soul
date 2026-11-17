import type { HardhatUserConfig } from 'hardhat/config';
import HardhatNodeTestRunner from '@nomicfoundation/hardhat-node-test-runner';
import HardhatViem from '@nomicfoundation/hardhat-viem';

/**
 * The compiler settings are the publication package's, deliberately. The module
 * is deployed as a proxy over the same factory as every other kind, and the
 * factory judges an implementation by `proxiableUUID()` and by its own approved
 * set; matching settings keeps a build of this package comparable with a build of
 * that one. `metadata.bytecodeHash: 'none'` is global for the reason it is there:
 * a per-file override compiles a contract twice and the two disagree.
 *
 * No typed-artifact generation: nothing imports this package's ABIs. The manifest
 * reader lives in `src/shared` and `src/press/actions`, which carry their own ABI
 * fragments, and the scripts below read `artifacts/` directly.
 */
const config: HardhatUserConfig = {
  plugins: [HardhatNodeTestRunner, HardhatViem],
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'cancun',
      metadata: { bytecodeHash: 'none' },
    },
  },
  paths: {
    sources: 'src',
    tests: 'test',
    artifacts: 'artifacts',
    cache: 'cache',
  },
};

export default config;
