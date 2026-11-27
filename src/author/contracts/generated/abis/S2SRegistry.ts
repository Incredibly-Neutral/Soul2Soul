export type Abi_S2SRegistry = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_authorGate",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "_governance",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "AlreadyRegistered",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "until",
        "type": "uint64"
      }
    ],
    "name": "CoolingDown",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "index",
        "type": "uint256"
      }
    ],
    "name": "InvalidChar",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidHyphen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLength",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoHandle",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotAContract",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotAuthor",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotGovernance",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Reserved",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SkeletonTaken",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAddress",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "gate",
        "type": "address"
      }
    ],
    "name": "AuthorGateSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "governance",
        "type": "address"
      }
    ],
    "name": "GovernanceTransferred",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "handleHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "location",
        "type": "address"
      }
    ],
    "name": "RecordsLocationSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "handleHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "handle",
        "type": "string"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint32",
        "name": "version",
        "type": "uint32"
      }
    ],
    "name": "Registered",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "handleHash",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "safe",
        "type": "address"
      }
    ],
    "name": "Released",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "skeletonHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "reserved",
        "type": "bool"
      }
    ],
    "name": "ReservedSet",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "COOLDOWN",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_COOLING",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_FREE",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_INVALID_CHAR",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_INVALID_HYPHEN",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_INVALID_LENGTH",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_REGISTERED",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_RESERVED",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_SKELETON_TAKEN",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "handle",
        "type": "string"
      },
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "recordsLocation",
        "type": "address"
      }
    ],
    "name": "assignReserved",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "authorGate",
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
        "internalType": "string",
        "name": "handle",
        "type": "string"
      }
    ],
    "name": "check",
    "outputs": [
      {
        "internalType": "bool",
        "name": "available",
        "type": "bool"
      },
      {
        "internalType": "uint8",
        "name": "reason",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "handle",
        "type": "string"
      }
    ],
    "name": "entry",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "safe",
            "type": "address"
          },
          {
            "internalType": "string",
            "name": "handle",
            "type": "string"
          },
          {
            "internalType": "uint32",
            "name": "version",
            "type": "uint32"
          },
          {
            "internalType": "uint64",
            "name": "registeredAt",
            "type": "uint64"
          },
          {
            "internalType": "address",
            "name": "recordsLocation",
            "type": "address"
          }
        ],
        "internalType": "struct S2SRegistry.Entry",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "governance",
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
        "name": "who",
        "type": "address"
      }
    ],
    "name": "nameOf",
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
    "inputs": [
      {
        "internalType": "string",
        "name": "handle",
        "type": "string"
      },
      {
        "internalType": "address",
        "name": "recordsLocation",
        "type": "address"
      }
    ],
    "name": "register",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "release",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string[]",
        "name": "handles",
        "type": "string[]"
      }
    ],
    "name": "reserve",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "handle",
        "type": "string"
      }
    ],
    "name": "resolve",
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
        "name": "gate",
        "type": "address"
      }
    ],
    "name": "setAuthorGate",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "location",
        "type": "address"
      }
    ],
    "name": "setRecordsLocation",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "handle",
        "type": "string"
      }
    ],
    "name": "skeletonOf",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newGovernance",
        "type": "address"
      }
    ],
    "name": "transferGovernance",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string[]",
        "name": "handles",
        "type": "string[]"
      }
    ],
    "name": "unreserve",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "handle",
        "type": "string"
      }
    ],
    "name": "versionOf",
    "outputs": [
      {
        "internalType": "uint32",
        "name": "",
        "type": "uint32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];
export const Abi_S2SRegistry: Abi_S2SRegistry = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_authorGate",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "_governance",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "AlreadyRegistered",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "until",
        "type": "uint64"
      }
    ],
    "name": "CoolingDown",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "index",
        "type": "uint256"
      }
    ],
    "name": "InvalidChar",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidHyphen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLength",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoHandle",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotAContract",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotAuthor",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotGovernance",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Reserved",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SkeletonTaken",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAddress",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "gate",
        "type": "address"
      }
    ],
    "name": "AuthorGateSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "governance",
        "type": "address"
      }
    ],
    "name": "GovernanceTransferred",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "handleHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "location",
        "type": "address"
      }
    ],
    "name": "RecordsLocationSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "handleHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "handle",
        "type": "string"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint32",
        "name": "version",
        "type": "uint32"
      }
    ],
    "name": "Registered",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "handleHash",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "safe",
        "type": "address"
      }
    ],
    "name": "Released",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "skeletonHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "reserved",
        "type": "bool"
      }
    ],
    "name": "ReservedSet",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "COOLDOWN",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_COOLING",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_FREE",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_INVALID_CHAR",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_INVALID_HYPHEN",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_INVALID_LENGTH",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_REGISTERED",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_RESERVED",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "REASON_SKELETON_TAKEN",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "handle",
        "type": "string"
      },
      {
        "internalType": "address",
        "name": "safe",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "recordsLocation",
        "type": "address"
      }
    ],
    "name": "assignReserved",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "authorGate",
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
        "internalType": "string",
        "name": "handle",
        "type": "string"
      }
    ],
    "name": "check",
    "outputs": [
      {
        "internalType": "bool",
        "name": "available",
        "type": "bool"
      },
      {
        "internalType": "uint8",
        "name": "reason",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "handle",
        "type": "string"
      }
    ],
    "name": "entry",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "safe",
            "type": "address"
          },
          {
            "internalType": "string",
            "name": "handle",
            "type": "string"
          },
          {
            "internalType": "uint32",
            "name": "version",
            "type": "uint32"
          },
          {
            "internalType": "uint64",
            "name": "registeredAt",
            "type": "uint64"
          },
          {
            "internalType": "address",
            "name": "recordsLocation",
            "type": "address"
          }
        ],
        "internalType": "struct S2SRegistry.Entry",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "governance",
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
        "name": "who",
        "type": "address"
      }
    ],
    "name": "nameOf",
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
    "inputs": [
      {
        "internalType": "string",
        "name": "handle",
        "type": "string"
      },
      {
        "internalType": "address",
        "name": "recordsLocation",
        "type": "address"
      }
    ],
    "name": "register",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "release",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string[]",
        "name": "handles",
        "type": "string[]"
      }
    ],
    "name": "reserve",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "handle",
        "type": "string"
      }
    ],
    "name": "resolve",
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
        "name": "gate",
        "type": "address"
      }
    ],
    "name": "setAuthorGate",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "location",
        "type": "address"
      }
    ],
    "name": "setRecordsLocation",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "handle",
        "type": "string"
      }
    ],
    "name": "skeletonOf",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newGovernance",
        "type": "address"
      }
    ],
    "name": "transferGovernance",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string[]",
        "name": "handles",
        "type": "string[]"
      }
    ],
    "name": "unreserve",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "handle",
        "type": "string"
      }
    ],
    "name": "versionOf",
    "outputs": [
      {
        "internalType": "uint32",
        "name": "",
        "type": "uint32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];
