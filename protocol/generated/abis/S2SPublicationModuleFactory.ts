export type Abi_S2SPublicationModuleFactory = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_implementation",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
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
        "internalType": "address",
        "name": "moduleProxy",
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
    "inputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "address[]",
        "name": "_authors",
        "type": "address[]"
      },
      {
        "internalType": "address[]",
        "name": "_devs",
        "type": "address[]"
      }
    ],
    "name": "createModule",
    "outputs": [
      {
        "internalType": "address",
        "name": "moduleProxy",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      }
    ],
    "name": "createModuleEmpty",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "latestImplementation",
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
        "name": "_implementation",
        "type": "address"
      }
    ],
    "name": "setImplementation",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];
export const Abi_S2SPublicationModuleFactory: Abi_S2SPublicationModuleFactory = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_implementation",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
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
        "internalType": "address",
        "name": "moduleProxy",
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
    "inputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "address[]",
        "name": "_authors",
        "type": "address[]"
      },
      {
        "internalType": "address[]",
        "name": "_devs",
        "type": "address[]"
      }
    ],
    "name": "createModule",
    "outputs": [
      {
        "internalType": "address",
        "name": "moduleProxy",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      }
    ],
    "name": "createModuleEmpty",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "latestImplementation",
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
        "name": "_implementation",
        "type": "address"
      }
    ],
    "name": "setImplementation",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];
