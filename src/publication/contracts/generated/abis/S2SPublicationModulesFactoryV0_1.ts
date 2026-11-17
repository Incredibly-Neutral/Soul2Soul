export type Abi_S2SPublicationModulesFactoryV0_1 = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_protocolSafe",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "declared",
        "type": "bytes32"
      }
    ],
    "name": "ImplementationKindMismatch",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "gate",
        "type": "address"
      }
    ],
    "name": "ImplementationNotGated",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "ImplementationRevoked",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      },
      {
        "internalType": "bytes",
        "name": "reason",
        "type": "bytes"
      }
    ],
    "name": "InitializerFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidVersion",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "name": "NoImplementation",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "NotAContract",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "NotApproved",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "caller",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      }
    ],
    "name": "NotSafeOrProtocolSafe",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "NotUUPS",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "caller",
        "type": "address"
      }
    ],
    "name": "OnlyProtocolSafe",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAddress",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroKind",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "version",
        "type": "uint256"
      }
    ],
    "name": "ImplementationSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "latest",
        "type": "address"
      }
    ],
    "name": "ImplementationWithdrawn",
    "type": "event"
  },
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
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "module",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "ModuleCreated",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "VERSION",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "bootstrapImplementation",
    "outputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "bytes",
        "name": "params",
        "type": "bytes"
      }
    ],
    "name": "createModule",
    "outputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      },
      {
        "internalType": "bool",
        "name": "created",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "version",
        "type": "uint256"
      }
    ],
    "name": "getImplementationByVersion",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "name": "implementationCount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "name": "implementationHistory",
    "outputs": [
      {
        "internalType": "address",
        "name": "implementations",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "implementationVersion",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "isApproved",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "isRevoked",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "name": "latestImplementation",
    "outputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "name": "moduleAddress",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "name": "moduleOf",
    "outputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "protocolSafe",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      }
    ],
    "name": "provenance",
    "outputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "proxyInitCodeHash",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      }
    ],
    "name": "recordOf",
    "outputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "revokeImplementation",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "setImplementation",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "versionOf",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];
export const Abi_S2SPublicationModulesFactoryV0_1: Abi_S2SPublicationModulesFactoryV0_1 = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_protocolSafe",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "declared",
        "type": "bytes32"
      }
    ],
    "name": "ImplementationKindMismatch",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "gate",
        "type": "address"
      }
    ],
    "name": "ImplementationNotGated",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "ImplementationRevoked",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      },
      {
        "internalType": "bytes",
        "name": "reason",
        "type": "bytes"
      }
    ],
    "name": "InitializerFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidVersion",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "name": "NoImplementation",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "NotAContract",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "NotApproved",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "caller",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      }
    ],
    "name": "NotSafeOrProtocolSafe",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "NotUUPS",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "caller",
        "type": "address"
      }
    ],
    "name": "OnlyProtocolSafe",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAddress",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroKind",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "version",
        "type": "uint256"
      }
    ],
    "name": "ImplementationSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "latest",
        "type": "address"
      }
    ],
    "name": "ImplementationWithdrawn",
    "type": "event"
  },
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
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "module",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "ModuleCreated",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "VERSION",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "bootstrapImplementation",
    "outputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "bytes",
        "name": "params",
        "type": "bytes"
      }
    ],
    "name": "createModule",
    "outputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      },
      {
        "internalType": "bool",
        "name": "created",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "version",
        "type": "uint256"
      }
    ],
    "name": "getImplementationByVersion",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "name": "implementationCount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "name": "implementationHistory",
    "outputs": [
      {
        "internalType": "address",
        "name": "implementations",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "implementationVersion",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "isApproved",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "isRevoked",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "name": "latestImplementation",
    "outputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "name": "moduleAddress",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "name": "moduleOf",
    "outputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "protocolSafe",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      }
    ],
    "name": "provenance",
    "outputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "proxyInitCodeHash",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      }
    ],
    "name": "recordOf",
    "outputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "revokeImplementation",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "setImplementation",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "kind",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "versionOf",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];
