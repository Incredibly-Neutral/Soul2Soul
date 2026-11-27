export type Abi_S2SAuthorGate = [
  {
    "inputs": [
      {
        "internalType": "address[]",
        "name": "singletons",
        "type": "address[]"
      },
      {
        "internalType": "bytes32[]",
        "name": "proxyCodehashes",
        "type": "bytes32[]"
      },
      {
        "internalType": "address[]",
        "name": "authorFactories",
        "type": "address[]"
      },
      {
        "internalType": "bytes32",
        "name": "moduleProxyCodehash",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "RECORDS_KIND",
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
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "recordsModule",
        "type": "address"
      }
    ],
    "name": "isAuthor",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];
export const Abi_S2SAuthorGate: Abi_S2SAuthorGate = [
  {
    "inputs": [
      {
        "internalType": "address[]",
        "name": "singletons",
        "type": "address[]"
      },
      {
        "internalType": "bytes32[]",
        "name": "proxyCodehashes",
        "type": "bytes32[]"
      },
      {
        "internalType": "address[]",
        "name": "authorFactories",
        "type": "address[]"
      },
      {
        "internalType": "bytes32",
        "name": "moduleProxyCodehash",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "RECORDS_KIND",
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
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "recordsModule",
        "type": "address"
      }
    ],
    "name": "isAuthor",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];
