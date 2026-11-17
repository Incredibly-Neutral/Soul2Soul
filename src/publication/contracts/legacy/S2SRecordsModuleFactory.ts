// The standalone records factory the earlier deployments answer, kept by hand:
// its source lived in S2SRecordsModule.sol, which this tree no longer has, so
// `hardhat compile` does not regenerate this file. The contract is still on
// chain and callers still read it, so the ABI stays.
export type Abi_S2SRecordsModuleFactory = [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "module",
        "type": "address"
      }
    ],
    "name": "ModuleCreated",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      }
    ],
    "name": "createModule",
    "outputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];
export const Abi_S2SRecordsModuleFactory: Abi_S2SRecordsModuleFactory = [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "module",
        "type": "address"
      }
    ],
    "name": "ModuleCreated",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      }
    ],
    "name": "createModule",
    "outputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];
