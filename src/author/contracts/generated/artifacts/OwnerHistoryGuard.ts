export const Artifact_OwnerHistoryGuard: {
  "contractName": "OwnerHistoryGuard",
  "sourceName": "src/OwnerHistoryGuard.sol",
  "abi": [
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "_safe",
          "type": "address"
        },
        {
          "internalType": "address",
          "name": "_module",
          "type": "address"
        }
      ],
      "stateMutability": "nonpayable",
      "type": "constructor"
    },
    {
      "inputs": [],
      "name": "ZeroAddress",
      "type": "error"
    },
    {
      "inputs": [
        {
          "internalType": "bytes32",
          "name": "",
          "type": "bytes32"
        },
        {
          "internalType": "bool",
          "name": "",
          "type": "bool"
        }
      ],
      "name": "checkAfterExecution",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        },
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        },
        {
          "internalType": "bytes",
          "name": "",
          "type": "bytes"
        },
        {
          "internalType": "enum OwnerHistoryGuard.Operation",
          "name": "",
          "type": "uint8"
        },
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        },
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        },
        {
          "internalType": "address payable",
          "name": "",
          "type": "address"
        },
        {
          "internalType": "bytes",
          "name": "",
          "type": "bytes"
        },
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "name": "checkTransaction",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "module",
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
      "inputs": [],
      "name": "safe",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    }
  ],
  "bytecode": "0x60c0346100bd57601f6103f638819003918201601f19168301916001600160401b038311848410176100c15780849260409485528339810103126100bd57610052602061004b836100d5565b92016100d5565b906001600160a01b03808216159081156100b2575b506100a05760805260a05260405161030c90816100ea823960805181818161015b01526101c2015260a051818181605d015261022b0152f35b60405163d92e233d60e01b8152600490fd5b90508216155f610067565b5f80fd5b634e487b7160e01b5f52604160045260245ffd5b51906001600160a01b03821682036100bd5756fe6080806040526004361015610012575f80fd5b5f3560e01c908163186f0354146101495750806375f0bb52146100b657806393271368146100905763b86d529814610048575f80fd5b3461008c575f36600319011261008c576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b5f80fd5b3461008c57604036600319011261008c576024358015150361008c576100b46101b8565b005b3461008c5761016036600319011261008c576001600160a01b036004358181160361008c5767ffffffffffffffff60443581811161008c576100fc90369060040161018a565b50506002606435101561008c5760e4358281160361008c57610104358281160361008c576101243590811161008c5761013990369060040161018a565b5050610144359081160361008c57005b3461008c575f36600319011261008c577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b9181601f8401121561008c5782359167ffffffffffffffff831161008c576020838186019501011161008c57565b6001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000811633036102d3575a90613a988211156102cf57613a971982019182116102bb575f91602091620927c08083116102b2575b50600490604051948593849263fff6cae960e01b84527f00000000000000000000000000000000000000000000000000000000000000001690f16102545750565b60203d6020116102ab575b601f8101601f1916820167ffffffffffffffff8111838210176102975760209183916040528101031261008c57518015150361008c57565b634e487b7160e01b5f52604160045260245ffd5b503d61025f565b91506004610213565b634e487b7160e01b5f52601160045260245ffd5b5050565b5056fea2646970667358221220a84aa03fccf15c5a035207cb2baa402793b1a63e4ed2a318e88f95bd8cce83a964736f6c63430008180033",
  "deployedBytecode": "0x6080806040526004361015610012575f80fd5b5f3560e01c908163186f0354146101495750806375f0bb52146100b657806393271368146100905763b86d529814610048575f80fd5b3461008c575f36600319011261008c576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b5f80fd5b3461008c57604036600319011261008c576024358015150361008c576100b46101b8565b005b3461008c5761016036600319011261008c576001600160a01b036004358181160361008c5767ffffffffffffffff60443581811161008c576100fc90369060040161018a565b50506002606435101561008c5760e4358281160361008c57610104358281160361008c576101243590811161008c5761013990369060040161018a565b5050610144359081160361008c57005b3461008c575f36600319011261008c577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b9181601f8401121561008c5782359167ffffffffffffffff831161008c576020838186019501011161008c57565b6001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000811633036102d3575a90613a988211156102cf57613a971982019182116102bb575f91602091620927c08083116102b2575b50600490604051948593849263fff6cae960e01b84527f00000000000000000000000000000000000000000000000000000000000000001690f16102545750565b60203d6020116102ab575b601f8101601f1916820167ffffffffffffffff8111838210176102975760209183916040528101031261008c57518015150361008c57565b634e487b7160e01b5f52604160045260245ffd5b503d61025f565b91506004610213565b634e487b7160e01b5f52601160045260245ffd5b5050565b5056fea2646970667358221220a84aa03fccf15c5a035207cb2baa402793b1a63e4ed2a318e88f95bd8cce83a964736f6c63430008180033",
  "linkReferences": {},
  "deployedLinkReferences": {},
  "immutableReferences": {
    "2712": [
      {
        "length": 32,
        "start": 347
      },
      {
        "length": 32,
        "start": 450
      }
    ],
    "2715": [
      {
        "length": 32,
        "start": 93
      },
      {
        "length": 32,
        "start": 555
      }
    ]
  },
  "inputSourceName": "project/src/OwnerHistoryGuard.sol",
  "devdoc": {
    "kind": "dev",
    "methods": {
      "checkAfterExecution(bytes32,bool)": {
        "details": "Called by the Safe after every execution. A no-op unless a genuine      Safe is calling, and even then a module failure is swallowed."
      },
      "checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)": {
        "details": "Intentionally empty. Named parameters are omitted so nothing here      can even tempt a future edit into reading calldata."
      }
    },
    "stateVariables": {
      "SYNC_GAS": {
        "details": "See \"Gas bound\" above: measured ceiling for a rotation, and the      slice of the remaining gas kept back for the catch and the Safe."
      }
    },
    "title": "OwnerHistoryGuard",
    "version": 1
  },
  "evm": {
    "bytecode": {
      "linkReferences": {},
      "object": "60c0346100bd57601f6103f638819003918201601f19168301916001600160401b038311848410176100c15780849260409485528339810103126100bd57610052602061004b836100d5565b92016100d5565b906001600160a01b03808216159081156100b2575b506100a05760805260a05260405161030c90816100ea823960805181818161015b01526101c2015260a051818181605d015261022b0152f35b60405163d92e233d60e01b8152600490fd5b90508216155f610067565b5f80fd5b634e487b7160e01b5f52604160045260245ffd5b51906001600160a01b03821682036100bd5756fe6080806040526004361015610012575f80fd5b5f3560e01c908163186f0354146101495750806375f0bb52146100b657806393271368146100905763b86d529814610048575f80fd5b3461008c575f36600319011261008c576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b5f80fd5b3461008c57604036600319011261008c576024358015150361008c576100b46101b8565b005b3461008c5761016036600319011261008c576001600160a01b036004358181160361008c5767ffffffffffffffff60443581811161008c576100fc90369060040161018a565b50506002606435101561008c5760e4358281160361008c57610104358281160361008c576101243590811161008c5761013990369060040161018a565b5050610144359081160361008c57005b3461008c575f36600319011261008c577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b9181601f8401121561008c5782359167ffffffffffffffff831161008c576020838186019501011161008c57565b6001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000811633036102d3575a90613a988211156102cf57613a971982019182116102bb575f91602091620927c08083116102b2575b50600490604051948593849263fff6cae960e01b84527f00000000000000000000000000000000000000000000000000000000000000001690f16102545750565b60203d6020116102ab575b601f8101601f1916820167ffffffffffffffff8111838210176102975760209183916040528101031261008c57518015150361008c57565b634e487b7160e01b5f52604160045260245ffd5b503d61025f565b91506004610213565b634e487b7160e01b5f52601160045260245ffd5b5050565b5056fea2646970667358221220a84aa03fccf15c5a035207cb2baa402793b1a63e4ed2a318e88f95bd8cce83a964736f6c63430008180033",
      "opcodes": "PUSH1 0xC0 CALLVALUE PUSH2 0xBD JUMPI PUSH1 0x1F PUSH2 0x3F6 CODESIZE DUP2 SWAP1 SUB SWAP2 DUP3 ADD PUSH1 0x1F NOT AND DUP4 ADD SWAP2 PUSH1 0x1 PUSH1 0x1 PUSH1 0x40 SHL SUB DUP4 GT DUP5 DUP5 LT OR PUSH2 0xC1 JUMPI DUP1 DUP5 SWAP3 PUSH1 0x40 SWAP5 DUP6 MSTORE DUP4 CODECOPY DUP2 ADD SUB SLT PUSH2 0xBD JUMPI PUSH2 0x52 PUSH1 0x20 PUSH2 0x4B DUP4 PUSH2 0xD5 JUMP JUMPDEST SWAP3 ADD PUSH2 0xD5 JUMP JUMPDEST SWAP1 PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB DUP1 DUP3 AND ISZERO SWAP1 DUP2 ISZERO PUSH2 0xB2 JUMPI JUMPDEST POP PUSH2 0xA0 JUMPI PUSH1 0x80 MSTORE PUSH1 0xA0 MSTORE PUSH1 0x40 MLOAD PUSH2 0x30C SWAP1 DUP2 PUSH2 0xEA DUP3 CODECOPY PUSH1 0x80 MLOAD DUP2 DUP2 DUP2 PUSH2 0x15B ADD MSTORE PUSH2 0x1C2 ADD MSTORE PUSH1 0xA0 MLOAD DUP2 DUP2 DUP2 PUSH1 0x5D ADD MSTORE PUSH2 0x22B ADD MSTORE RETURN JUMPDEST PUSH1 0x40 MLOAD PUSH4 0xD92E233D PUSH1 0xE0 SHL DUP2 MSTORE PUSH1 0x4 SWAP1 REVERT JUMPDEST SWAP1 POP DUP3 AND ISZERO PUSH0 PUSH2 0x67 JUMP JUMPDEST PUSH0 DUP1 REVERT JUMPDEST PUSH4 0x4E487B71 PUSH1 0xE0 SHL PUSH0 MSTORE PUSH1 0x41 PUSH1 0x4 MSTORE PUSH1 0x24 PUSH0 REVERT JUMPDEST MLOAD SWAP1 PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB DUP3 AND DUP3 SUB PUSH2 0xBD JUMPI JUMP INVALID PUSH1 0x80 DUP1 PUSH1 0x40 MSTORE PUSH1 0x4 CALLDATASIZE LT ISZERO PUSH2 0x12 JUMPI PUSH0 DUP1 REVERT JUMPDEST PUSH0 CALLDATALOAD PUSH1 0xE0 SHR SWAP1 DUP2 PUSH4 0x186F0354 EQ PUSH2 0x149 JUMPI POP DUP1 PUSH4 0x75F0BB52 EQ PUSH2 0xB6 JUMPI DUP1 PUSH4 0x93271368 EQ PUSH2 0x90 JUMPI PUSH4 0xB86D5298 EQ PUSH2 0x48 JUMPI PUSH0 DUP1 REVERT JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH0 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH1 0x40 MLOAD PUSH32 0x0 PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB AND DUP2 MSTORE PUSH1 0x20 SWAP1 RETURN JUMPDEST PUSH0 DUP1 REVERT JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH1 0x40 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH1 0x24 CALLDATALOAD DUP1 ISZERO ISZERO SUB PUSH2 0x8C JUMPI PUSH2 0xB4 PUSH2 0x1B8 JUMP JUMPDEST STOP JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH2 0x160 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB PUSH1 0x4 CALLDATALOAD DUP2 DUP2 AND SUB PUSH2 0x8C JUMPI PUSH8 0xFFFFFFFFFFFFFFFF PUSH1 0x44 CALLDATALOAD DUP2 DUP2 GT PUSH2 0x8C JUMPI PUSH2 0xFC SWAP1 CALLDATASIZE SWAP1 PUSH1 0x4 ADD PUSH2 0x18A JUMP JUMPDEST POP POP PUSH1 0x2 PUSH1 0x64 CALLDATALOAD LT ISZERO PUSH2 0x8C JUMPI PUSH1 0xE4 CALLDATALOAD DUP3 DUP2 AND SUB PUSH2 0x8C JUMPI PUSH2 0x104 CALLDATALOAD DUP3 DUP2 AND SUB PUSH2 0x8C JUMPI PUSH2 0x124 CALLDATALOAD SWAP1 DUP2 GT PUSH2 0x8C JUMPI PUSH2 0x139 SWAP1 CALLDATASIZE SWAP1 PUSH1 0x4 ADD PUSH2 0x18A JUMP JUMPDEST POP POP PUSH2 0x144 CALLDATALOAD SWAP1 DUP2 AND SUB PUSH2 0x8C JUMPI STOP JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH0 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH32 0x0 PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB AND DUP2 MSTORE PUSH1 0x20 SWAP1 RETURN JUMPDEST SWAP2 DUP2 PUSH1 0x1F DUP5 ADD SLT ISZERO PUSH2 0x8C JUMPI DUP3 CALLDATALOAD SWAP2 PUSH8 0xFFFFFFFFFFFFFFFF DUP4 GT PUSH2 0x8C JUMPI PUSH1 0x20 DUP4 DUP2 DUP7 ADD SWAP6 ADD ADD GT PUSH2 0x8C JUMPI JUMP JUMPDEST PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB PUSH32 0x0 DUP2 AND CALLER SUB PUSH2 0x2D3 JUMPI GAS SWAP1 PUSH2 0x3A98 DUP3 GT ISZERO PUSH2 0x2CF JUMPI PUSH2 0x3A97 NOT DUP3 ADD SWAP2 DUP3 GT PUSH2 0x2BB JUMPI PUSH0 SWAP2 PUSH1 0x20 SWAP2 PUSH3 0x927C0 DUP1 DUP4 GT PUSH2 0x2B2 JUMPI JUMPDEST POP PUSH1 0x4 SWAP1 PUSH1 0x40 MLOAD SWAP5 DUP6 SWAP4 DUP5 SWAP3 PUSH4 0xFFF6CAE9 PUSH1 0xE0 SHL DUP5 MSTORE PUSH32 0x0 AND SWAP1 CALL PUSH2 0x254 JUMPI POP JUMP JUMPDEST PUSH1 0x20 RETURNDATASIZE PUSH1 0x20 GT PUSH2 0x2AB JUMPI JUMPDEST PUSH1 0x1F DUP2 ADD PUSH1 0x1F NOT AND DUP3 ADD PUSH8 0xFFFFFFFFFFFFFFFF DUP2 GT DUP4 DUP3 LT OR PUSH2 0x297 JUMPI PUSH1 0x20 SWAP2 DUP4 SWAP2 PUSH1 0x40 MSTORE DUP2 ADD SUB SLT PUSH2 0x8C JUMPI MLOAD DUP1 ISZERO ISZERO SUB PUSH2 0x8C JUMPI JUMP JUMPDEST PUSH4 0x4E487B71 PUSH1 0xE0 SHL PUSH0 MSTORE PUSH1 0x41 PUSH1 0x4 MSTORE PUSH1 0x24 PUSH0 REVERT JUMPDEST POP RETURNDATASIZE PUSH2 0x25F JUMP JUMPDEST SWAP2 POP PUSH1 0x4 PUSH2 0x213 JUMP JUMPDEST PUSH4 0x4E487B71 PUSH1 0xE0 SHL PUSH0 MSTORE PUSH1 0x11 PUSH1 0x4 MSTORE PUSH1 0x24 PUSH0 REVERT JUMPDEST POP POP JUMP JUMPDEST POP JUMP INVALID LOG2 PUSH5 0x6970667358 0x22 SLT KECCAK256 0xA8 BLOBBASEFEE LOG0 EXTCODEHASH 0xCC CALL TLOAD GAS SUB MSTORE SMOD 0xCB 0x2B 0xAA BLOCKHASH 0x27 SWAP4 0xB1 0xA6 RETURNDATACOPY 0x4E 0xD2 LOG3 XOR 0xE8 DUP16 SWAP6 0xBD DUP13 0xCE DUP4 0xA9 PUSH5 0x736F6C6343 STOP ADDMOD XOR STOP CALLER ",
      "sourceMap": "4826:2207:18:-:0;;;;;;;;;;;;;-1:-1:-1;;4826:2207:18;;;;-1:-1:-1;;;;;4826:2207:18;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;;:::i;:::-;;-1:-1:-1;;;;;4826:2207:18;;;5501:19;;:44;;;;-1:-1:-1;5497:70:18;;;5577:12;;5599:16;;4826:2207;;;;;;;;5577:12;4826:2207;;;;;;;;;;5599:16;4826:2207;;;;;;;;;;;5497:70;4826:2207;;-1:-1:-1;;;5554:13:18;;;;;5501:44;4826:2207;;;;5524:21;5501:44;;;4826:2207;-1:-1:-1;4826:2207:18;;;;;;-1:-1:-1;4826:2207:18;;;;;-1:-1:-1;4826:2207:18;;;;-1:-1:-1;;;;;4826:2207:18;;;;;;:::o"
    },
    "deployedBytecode": {
      "immutableReferences": {
        "2712": [
          {
            "length": 32,
            "start": 347
          },
          {
            "length": 32,
            "start": 450
          }
        ],
        "2715": [
          {
            "length": 32,
            "start": 93
          },
          {
            "length": 32,
            "start": 555
          }
        ]
      },
      "linkReferences": {},
      "object": "6080806040526004361015610012575f80fd5b5f3560e01c908163186f0354146101495750806375f0bb52146100b657806393271368146100905763b86d529814610048575f80fd5b3461008c575f36600319011261008c576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b5f80fd5b3461008c57604036600319011261008c576024358015150361008c576100b46101b8565b005b3461008c5761016036600319011261008c576001600160a01b036004358181160361008c5767ffffffffffffffff60443581811161008c576100fc90369060040161018a565b50506002606435101561008c5760e4358281160361008c57610104358281160361008c576101243590811161008c5761013990369060040161018a565b5050610144359081160361008c57005b3461008c575f36600319011261008c577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b9181601f8401121561008c5782359167ffffffffffffffff831161008c576020838186019501011161008c57565b6001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000811633036102d3575a90613a988211156102cf57613a971982019182116102bb575f91602091620927c08083116102b2575b50600490604051948593849263fff6cae960e01b84527f00000000000000000000000000000000000000000000000000000000000000001690f16102545750565b60203d6020116102ab575b601f8101601f1916820167ffffffffffffffff8111838210176102975760209183916040528101031261008c57518015150361008c57565b634e487b7160e01b5f52604160045260245ffd5b503d61025f565b91506004610213565b634e487b7160e01b5f52601160045260245ffd5b5050565b5056fea2646970667358221220a84aa03fccf15c5a035207cb2baa402793b1a63e4ed2a318e88f95bd8cce83a964736f6c63430008180033",
      "opcodes": "PUSH1 0x80 DUP1 PUSH1 0x40 MSTORE PUSH1 0x4 CALLDATASIZE LT ISZERO PUSH2 0x12 JUMPI PUSH0 DUP1 REVERT JUMPDEST PUSH0 CALLDATALOAD PUSH1 0xE0 SHR SWAP1 DUP2 PUSH4 0x186F0354 EQ PUSH2 0x149 JUMPI POP DUP1 PUSH4 0x75F0BB52 EQ PUSH2 0xB6 JUMPI DUP1 PUSH4 0x93271368 EQ PUSH2 0x90 JUMPI PUSH4 0xB86D5298 EQ PUSH2 0x48 JUMPI PUSH0 DUP1 REVERT JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH0 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH1 0x40 MLOAD PUSH32 0x0 PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB AND DUP2 MSTORE PUSH1 0x20 SWAP1 RETURN JUMPDEST PUSH0 DUP1 REVERT JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH1 0x40 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH1 0x24 CALLDATALOAD DUP1 ISZERO ISZERO SUB PUSH2 0x8C JUMPI PUSH2 0xB4 PUSH2 0x1B8 JUMP JUMPDEST STOP JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH2 0x160 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB PUSH1 0x4 CALLDATALOAD DUP2 DUP2 AND SUB PUSH2 0x8C JUMPI PUSH8 0xFFFFFFFFFFFFFFFF PUSH1 0x44 CALLDATALOAD DUP2 DUP2 GT PUSH2 0x8C JUMPI PUSH2 0xFC SWAP1 CALLDATASIZE SWAP1 PUSH1 0x4 ADD PUSH2 0x18A JUMP JUMPDEST POP POP PUSH1 0x2 PUSH1 0x64 CALLDATALOAD LT ISZERO PUSH2 0x8C JUMPI PUSH1 0xE4 CALLDATALOAD DUP3 DUP2 AND SUB PUSH2 0x8C JUMPI PUSH2 0x104 CALLDATALOAD DUP3 DUP2 AND SUB PUSH2 0x8C JUMPI PUSH2 0x124 CALLDATALOAD SWAP1 DUP2 GT PUSH2 0x8C JUMPI PUSH2 0x139 SWAP1 CALLDATASIZE SWAP1 PUSH1 0x4 ADD PUSH2 0x18A JUMP JUMPDEST POP POP PUSH2 0x144 CALLDATALOAD SWAP1 DUP2 AND SUB PUSH2 0x8C JUMPI STOP JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH0 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH32 0x0 PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB AND DUP2 MSTORE PUSH1 0x20 SWAP1 RETURN JUMPDEST SWAP2 DUP2 PUSH1 0x1F DUP5 ADD SLT ISZERO PUSH2 0x8C JUMPI DUP3 CALLDATALOAD SWAP2 PUSH8 0xFFFFFFFFFFFFFFFF DUP4 GT PUSH2 0x8C JUMPI PUSH1 0x20 DUP4 DUP2 DUP7 ADD SWAP6 ADD ADD GT PUSH2 0x8C JUMPI JUMP JUMPDEST PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB PUSH32 0x0 DUP2 AND CALLER SUB PUSH2 0x2D3 JUMPI GAS SWAP1 PUSH2 0x3A98 DUP3 GT ISZERO PUSH2 0x2CF JUMPI PUSH2 0x3A97 NOT DUP3 ADD SWAP2 DUP3 GT PUSH2 0x2BB JUMPI PUSH0 SWAP2 PUSH1 0x20 SWAP2 PUSH3 0x927C0 DUP1 DUP4 GT PUSH2 0x2B2 JUMPI JUMPDEST POP PUSH1 0x4 SWAP1 PUSH1 0x40 MLOAD SWAP5 DUP6 SWAP4 DUP5 SWAP3 PUSH4 0xFFF6CAE9 PUSH1 0xE0 SHL DUP5 MSTORE PUSH32 0x0 AND SWAP1 CALL PUSH2 0x254 JUMPI POP JUMP JUMPDEST PUSH1 0x20 RETURNDATASIZE PUSH1 0x20 GT PUSH2 0x2AB JUMPI JUMPDEST PUSH1 0x1F DUP2 ADD PUSH1 0x1F NOT AND DUP3 ADD PUSH8 0xFFFFFFFFFFFFFFFF DUP2 GT DUP4 DUP3 LT OR PUSH2 0x297 JUMPI PUSH1 0x20 SWAP2 DUP4 SWAP2 PUSH1 0x40 MSTORE DUP2 ADD SUB SLT PUSH2 0x8C JUMPI MLOAD DUP1 ISZERO ISZERO SUB PUSH2 0x8C JUMPI JUMP JUMPDEST PUSH4 0x4E487B71 PUSH1 0xE0 SHL PUSH0 MSTORE PUSH1 0x41 PUSH1 0x4 MSTORE PUSH1 0x24 PUSH0 REVERT JUMPDEST POP RETURNDATASIZE PUSH2 0x25F JUMP JUMPDEST SWAP2 POP PUSH1 0x4 PUSH2 0x213 JUMP JUMPDEST PUSH4 0x4E487B71 PUSH1 0xE0 SHL PUSH0 MSTORE PUSH1 0x11 PUSH1 0x4 MSTORE PUSH1 0x24 PUSH0 REVERT JUMPDEST POP POP JUMP JUMPDEST POP JUMP INVALID LOG2 PUSH5 0x6970667358 0x22 SLT KECCAK256 0xA8 BLOBBASEFEE LOG0 EXTCODEHASH 0xCC CALL TLOAD GAS SUB MSTORE SMOD 0xCB 0x2B 0xAA BLOCKHASH 0x27 SWAP4 0xB1 0xA6 RETURNDATACOPY 0x4E 0xD2 LOG3 XOR 0xE8 DUP16 SWAP6 0xBD DUP13 0xCE DUP4 0xA9 PUSH5 0x736F6C6343 STOP ADDMOD XOR STOP CALLER ",
      "sourceMap": "4826:2207:18:-:0;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;-1:-1:-1;;4826:2207:18;;;;;;5120:31;-1:-1:-1;;;;;4826:2207:18;;;;;;;;;;;;;;;;-1:-1:-1;;4826:2207:18;;;;;;;;;;;;;;:::i;:::-;;;;;;;;-1:-1:-1;;4826:2207:18;;;;-1:-1:-1;;;;;4826:2207:18;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;;-1:-1:-1;;4826:2207:18;;;;5027:29;-1:-1:-1;;;;;4826:2207:18;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::o;6187:844::-;-1:-1:-1;;;;;6498:4:18;4826:2207;;6484:10;:18;6480:31;;6541:9;6564:25;5404:6;6564:25;;;6560:38;;-1:-1:-1;;5404:6:18;;;;;;;-1:-1:-1;;6713:41:18;;5350:7;6662:17;;;6658:40;;6187:844;4826:2207;6713:41;4826:2207;;;5350:7;;;;;;;;6713:41;;6727:6;4826:2207;6713:41;;;;6187:844;:::o;6713:41::-;;;;;;;;5350:7;;;-1:-1:-1;;5350:7:18;;;;;;;;;;;;6713:41;5350:7;;;4826:2207;5350:7;6713:41;;5350:7;;;;;4826:2207;;;;;;6187:844::o;5350:7::-;5404:6;;;-1:-1:-1;5350:7:18;;6713:41;5350:7;;-1:-1:-1;5350:7:18;6713:41;;;;;6658:40;;-1:-1:-1;6713:41:18;6658:40;;5404:6;;;;-1:-1:-1;5404:6:18;;;;;-1:-1:-1;5404:6:18;6560:38;6591:7;;:::o;6480:31::-;6504:7;:::o"
    },
    "gasEstimates": {
      "creation": {
        "codeDepositCost": "156000",
        "executionCost": "infinite",
        "totalCost": "infinite"
      },
      "external": {
        "checkAfterExecution(bytes32,bool)": "infinite",
        "checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)": "infinite",
        "module()": "infinite",
        "safe()": "infinite"
      }
    },
    "methodIdentifiers": {
      "checkAfterExecution(bytes32,bool)": "93271368",
      "checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)": "75f0bb52",
      "module()": "b86d5298",
      "safe()": "186f0354"
    }
  },
  "metadata": "{\"compiler\":{\"version\":\"0.8.24+commit.e11b9ed9\"},\"language\":\"Solidity\",\"output\":{\"abi\":[{\"inputs\":[{\"internalType\":\"address\",\"name\":\"_safe\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"_module\",\"type\":\"address\"}],\"stateMutability\":\"nonpayable\",\"type\":\"constructor\"},{\"inputs\":[],\"name\":\"ZeroAddress\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"},{\"internalType\":\"bool\",\"name\":\"\",\"type\":\"bool\"}],\"name\":\"checkAfterExecution\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"},{\"internalType\":\"bytes\",\"name\":\"\",\"type\":\"bytes\"},{\"internalType\":\"enum OwnerHistoryGuard.Operation\",\"name\":\"\",\"type\":\"uint8\"},{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"},{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"},{\"internalType\":\"address payable\",\"name\":\"\",\"type\":\"address\"},{\"internalType\":\"bytes\",\"name\":\"\",\"type\":\"bytes\"},{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"}],\"name\":\"checkTransaction\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"module\",\"outputs\":[{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"safe\",\"outputs\":[{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"}],\"stateMutability\":\"view\",\"type\":\"function\"}],\"devdoc\":{\"kind\":\"dev\",\"methods\":{\"checkAfterExecution(bytes32,bool)\":{\"details\":\"Called by the Safe after every execution. A no-op unless a genuine      Safe is calling, and even then a module failure is swallowed.\"},\"checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)\":{\"details\":\"Intentionally empty. Named parameters are omitted so nothing here      can even tempt a future edit into reading calldata.\"}},\"stateVariables\":{\"SYNC_GAS\":{\"details\":\"See \\\"Gas bound\\\" above: measured ceiling for a rotation, and the      slice of the remaining gas kept back for the catch and the Safe.\"}},\"title\":\"OwnerHistoryGuard\",\"version\":1},\"userdoc\":{\"kind\":\"user\",\"methods\":{\"module()\":{\"notice\":\"The owner-history module to keep current.\"},\"safe()\":{\"notice\":\"The Safe this guard is installed on; the only sender whose         post-execution call is honoured.\"}},\"notice\":\"Safe 1.4.1 transaction guard that keeps `OwnerHistoryModuleV1`         current. Installed with the Safe's own `setGuard` (which is         `onlySelf`, so a Safe transaction installs it). This is the hook, and the Safe has no other one. `execTransaction` calls `checkTransaction` before the execution and `checkAfterExecution` after it. Every owner mutation \\u2014 `addOwnerWithThreshold`, `removeOwner`, `swapOwner`, `changeThreshold` \\u2014 is `onlySelf`, i.e. it must go through `execTransaction`, so a guard sees all of them. There is deliberately no other tap: the Safe emits `AddedOwner`/`RemovedOwner` but emits nothing an off-chain or on-chain listener can *act* on, and 1.4.1 has no owner-rotation callback. Why this contract is separate from the module, and why it is this small:   A reverting guard **bricks the Safe permanently**. Removing it needs a Safe   transaction, and the broken guard would block that transaction. So the   guard holds no storage, has no owner, is not upgradeable, and every path   out of it is a no-op:     - `checkTransaction` has an empty body. It never reads, never reverts,       never can be made to. (A guard *can* veto; this one refuses to.)     - `checkAfterExecution` returns unless the caller is the Safe, and calls       the module inside `try/catch`, so a broken module is a skipped sync, not       a blocked Safe.   The module is where bugs are allowed to live, because a broken module is   repairable: `sync()` is permissionless and the Safe can upgrade or replace   the module without the guard's help. Gas bound on the module call:   `sync()` is cold-storage work: it closes an era, opens one, and opens or   closes a tenure pair per changed address. Measured on this build as the   execution gas of a direct `sync()` transaction (gas used minus the 21k   transaction base), on a Safe growing from 2 owners:     add one owner, era of 2 ............ 306k     add one owner, era of 3 ............ 337k     add one owner, era of 4 ............ 369k     swap one owner, 5 owners ........... 394k     remove one owner, 5 owners ......... 211k     no change at all ................... ~45k   ~32k per owner, because each era stores its owner array. So the ceiling is   600k: comfortably above a rotation on any realistic Safe (2-5 owners) and   below the point where a compromised module could drain a Safe transaction's   budget. A call's gas limit is a ceiling, not a cost \\u2014 a sync that needs   306k spends 306k \\u2014 so an over-generous bound would only widen the griefing   window. A rotation too large for 600k (a dozen owners gaining several at   once) misses its sync and is repaired by anyone calling `sync()`: stale for   one block beats a blocked Safe, which is the whole trade of this contract.   Correctness at the edge is defended separately:     - `SYNC_RESERVE` (15k) is kept back from what is available before the       call, so the `catch` and the Safe's own epilogue (emit `ExecutionSuccess`,       pay the refund, return true) always have gas. EIP-150's 63/64 rule alone       is not enough here: with little gas left it leaves a few hundred, and an       out-of-gas epilogue reverts `execTransaction` \\u2014 and a guard that makes       `execTransaction` revert is the one thing that bricks a Safe.     - Consequence, stated because a test pins it: a Safe transaction whose       gas limit is tight enough that the module cannot finish simply skips       the sync. The Safe's own call still succeeds. The proposer adding a       little headroom to the gas limit is what makes the hook fire.     - The guard is installed on every transaction, not only on owner       changes, and a no-op `sync()` still reads `getOwners()` and compares       the sets: ~45k gas. That is the standing price of a history with no       gaps, and it is paid by the Safe, not by the author's readers. The ABI, verified rather than assumed:   `Enum.Operation` from the Safe's `IGuard` cannot be imported (no Safe   dependency), and its ABI type is `uint8`, so a local two-member enum gives   the identical encoding. The selector the Safe calls is   `checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)`,   asserted in the test suite against the ABI this file compiles to.\",\"version\":1}},\"settings\":{\"compilationTarget\":{\"project/src/OwnerHistoryGuard.sol\":\"OwnerHistoryGuard\"},\"evmVersion\":\"shanghai\",\"libraries\":{},\"metadata\":{\"bytecodeHash\":\"ipfs\",\"useLiteralContent\":true},\"optimizer\":{\"enabled\":true,\"runs\":200},\"remappings\":[\"project/:@openzeppelin/contracts-upgradeable/=npm/@openzeppelin/contracts-upgradeable@4.9.6/\",\"project/:@openzeppelin/contracts/=npm/@openzeppelin/contracts@4.9.6/\"],\"viaIR\":true},\"sources\":{\"project/src/OwnerHistoryGuard.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\npragma solidity ^0.8.19;\\n\\n/// @dev The one call the guard makes, declared locally because the Safe package\\n///      is not a dependency of this repo. `sync` returns a bool; the guard does\\n///      not look at it.\\ninterface IOwnerHistory {\\n    function sync() external returns (bool);\\n}\\n\\n/**\\n * @title OwnerHistoryGuard\\n * @notice Safe 1.4.1 transaction guard that keeps `OwnerHistoryModuleV1`\\n *         current. Installed with the Safe's own `setGuard` (which is\\n *         `onlySelf`, so a Safe transaction installs it).\\n *\\n * This is the hook, and the Safe has no other one. `execTransaction` calls\\n * `checkTransaction` before the execution and `checkAfterExecution` after it.\\n * Every owner mutation \\u2014 `addOwnerWithThreshold`, `removeOwner`, `swapOwner`,\\n * `changeThreshold` \\u2014 is `onlySelf`, i.e. it must go through `execTransaction`,\\n * so a guard sees all of them. There is deliberately no other tap: the Safe\\n * emits `AddedOwner`/`RemovedOwner` but emits nothing an off-chain or on-chain\\n * listener can *act* on, and 1.4.1 has no owner-rotation callback.\\n *\\n * Why this contract is separate from the module, and why it is this small:\\n *   A reverting guard **bricks the Safe permanently**. Removing it needs a Safe\\n *   transaction, and the broken guard would block that transaction. So the\\n *   guard holds no storage, has no owner, is not upgradeable, and every path\\n *   out of it is a no-op:\\n *     - `checkTransaction` has an empty body. It never reads, never reverts,\\n *       never can be made to. (A guard *can* veto; this one refuses to.)\\n *     - `checkAfterExecution` returns unless the caller is the Safe, and calls\\n *       the module inside `try/catch`, so a broken module is a skipped sync, not\\n *       a blocked Safe.\\n *   The module is where bugs are allowed to live, because a broken module is\\n *   repairable: `sync()` is permissionless and the Safe can upgrade or replace\\n *   the module without the guard's help.\\n *\\n * Gas bound on the module call:\\n *   `sync()` is cold-storage work: it closes an era, opens one, and opens or\\n *   closes a tenure pair per changed address. Measured on this build as the\\n *   execution gas of a direct `sync()` transaction (gas used minus the 21k\\n *   transaction base), on a Safe growing from 2 owners:\\n *\\n *     add one owner, era of 2 ............ 306k\\n *     add one owner, era of 3 ............ 337k\\n *     add one owner, era of 4 ............ 369k\\n *     swap one owner, 5 owners ........... 394k\\n *     remove one owner, 5 owners ......... 211k\\n *     no change at all ................... ~45k\\n *\\n *   ~32k per owner, because each era stores its owner array. So the ceiling is\\n *   600k: comfortably above a rotation on any realistic Safe (2-5 owners) and\\n *   below the point where a compromised module could drain a Safe transaction's\\n *   budget. A call's gas limit is a ceiling, not a cost \\u2014 a sync that needs\\n *   306k spends 306k \\u2014 so an over-generous bound would only widen the griefing\\n *   window. A rotation too large for 600k (a dozen owners gaining several at\\n *   once) misses its sync and is repaired by anyone calling `sync()`: stale for\\n *   one block beats a blocked Safe, which is the whole trade of this contract.\\n *\\n *   Correctness at the edge is defended separately:\\n *     - `SYNC_RESERVE` (15k) is kept back from what is available before the\\n *       call, so the `catch` and the Safe's own epilogue (emit `ExecutionSuccess`,\\n *       pay the refund, return true) always have gas. EIP-150's 63/64 rule alone\\n *       is not enough here: with little gas left it leaves a few hundred, and an\\n *       out-of-gas epilogue reverts `execTransaction` \\u2014 and a guard that makes\\n *       `execTransaction` revert is the one thing that bricks a Safe.\\n *     - Consequence, stated because a test pins it: a Safe transaction whose\\n *       gas limit is tight enough that the module cannot finish simply skips\\n *       the sync. The Safe's own call still succeeds. The proposer adding a\\n *       little headroom to the gas limit is what makes the hook fire.\\n *     - The guard is installed on every transaction, not only on owner\\n *       changes, and a no-op `sync()` still reads `getOwners()` and compares\\n *       the sets: ~45k gas. That is the standing price of a history with no\\n *       gaps, and it is paid by the Safe, not by the author's readers.\\n *\\n * The ABI, verified rather than assumed:\\n *   `Enum.Operation` from the Safe's `IGuard` cannot be imported (no Safe\\n *   dependency), and its ABI type is `uint8`, so a local two-member enum gives\\n *   the identical encoding. The selector the Safe calls is\\n *   `checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)`,\\n *   asserted in the test suite against the ABI this file compiles to.\\n */\\ncontract OwnerHistoryGuard {\\n\\n    enum Operation { Call, DelegateCall }\\n\\n    /// @notice The Safe this guard is installed on; the only sender whose\\n    ///         post-execution call is honoured.\\n    address public immutable safe;\\n    /// @notice The owner-history module to keep current.\\n    address public immutable module;\\n\\n    /// @dev See \\\"Gas bound\\\" above: measured ceiling for a rotation, and the\\n    ///      slice of the remaining gas kept back for the catch and the Safe.\\n    uint256 internal constant SYNC_GAS = 600_000;\\n    uint256 internal constant SYNC_RESERVE = 15_000;\\n\\n    error ZeroAddress();\\n\\n    constructor(address _safe, address _module) {\\n        if (_safe == address(0) || _module == address(0)) revert ZeroAddress();\\n        safe = _safe;\\n        module = _module;\\n    }\\n\\n    /// @dev Intentionally empty. Named parameters are omitted so nothing here\\n    ///      can even tempt a future edit into reading calldata.\\n    function checkTransaction(\\n        address,\\n        uint256,\\n        bytes calldata,\\n        Operation,\\n        uint256,\\n        uint256,\\n        uint256,\\n        address,\\n        address payable,\\n        bytes calldata,\\n        address\\n    ) external {}\\n\\n    /// @dev Called by the Safe after every execution. A no-op unless a genuine\\n    ///      Safe is calling, and even then a module failure is swallowed.\\n    function checkAfterExecution(bytes32, bool) external {\\n        // Only the Safe's own `execTransaction` may drive the module: without\\n        // this gate anyone could call `sync` through the guard, and (worse) a\\n        // future module with side effects would be callable by anyone.\\n        if (msg.sender != safe) return;\\n\\n        uint256 available = gasleft();\\n        if (available <= SYNC_RESERVE) return;\\n        uint256 budget = available - SYNC_RESERVE;\\n        if (budget > SYNC_GAS) budget = SYNC_GAS;\\n\\n        try IOwnerHistory(module).sync{gas: budget}() returns (bool) {\\n            // The answer (changed / unchanged) is not the guard's business.\\n        } catch {\\n            // A missed sync is repaired by anyone calling `sync()` directly.\\n            // Never bubble: this frame has no right to fail the Safe.\\n        }\\n    }\\n}\\n\",\"keccak256\":\"0x3dfacbb8b4bfbb55c9725939fc12b179ae1557f23a237e781e356c13252815b2\",\"license\":\"MIT\"}},\"version\":1}",
  "storageLayout": {
    "storage": [],
    "types": null
  },
  "userdoc": {
    "kind": "user",
    "methods": {
      "module()": {
        "notice": "The owner-history module to keep current."
      },
      "safe()": {
        "notice": "The Safe this guard is installed on; the only sender whose         post-execution call is honoured."
      }
    },
    "notice": "Safe 1.4.1 transaction guard that keeps `OwnerHistoryModuleV1`         current. Installed with the Safe's own `setGuard` (which is         `onlySelf`, so a Safe transaction installs it). This is the hook, and the Safe has no other one. `execTransaction` calls `checkTransaction` before the execution and `checkAfterExecution` after it. Every owner mutation — `addOwnerWithThreshold`, `removeOwner`, `swapOwner`, `changeThreshold` — is `onlySelf`, i.e. it must go through `execTransaction`, so a guard sees all of them. There is deliberately no other tap: the Safe emits `AddedOwner`/`RemovedOwner` but emits nothing an off-chain or on-chain listener can *act* on, and 1.4.1 has no owner-rotation callback. Why this contract is separate from the module, and why it is this small:   A reverting guard **bricks the Safe permanently**. Removing it needs a Safe   transaction, and the broken guard would block that transaction. So the   guard holds no storage, has no owner, is not upgradeable, and every path   out of it is a no-op:     - `checkTransaction` has an empty body. It never reads, never reverts,       never can be made to. (A guard *can* veto; this one refuses to.)     - `checkAfterExecution` returns unless the caller is the Safe, and calls       the module inside `try/catch`, so a broken module is a skipped sync, not       a blocked Safe.   The module is where bugs are allowed to live, because a broken module is   repairable: `sync()` is permissionless and the Safe can upgrade or replace   the module without the guard's help. Gas bound on the module call:   `sync()` is cold-storage work: it closes an era, opens one, and opens or   closes a tenure pair per changed address. Measured on this build as the   execution gas of a direct `sync()` transaction (gas used minus the 21k   transaction base), on a Safe growing from 2 owners:     add one owner, era of 2 ............ 306k     add one owner, era of 3 ............ 337k     add one owner, era of 4 ............ 369k     swap one owner, 5 owners ........... 394k     remove one owner, 5 owners ......... 211k     no change at all ................... ~45k   ~32k per owner, because each era stores its owner array. So the ceiling is   600k: comfortably above a rotation on any realistic Safe (2-5 owners) and   below the point where a compromised module could drain a Safe transaction's   budget. A call's gas limit is a ceiling, not a cost — a sync that needs   306k spends 306k — so an over-generous bound would only widen the griefing   window. A rotation too large for 600k (a dozen owners gaining several at   once) misses its sync and is repaired by anyone calling `sync()`: stale for   one block beats a blocked Safe, which is the whole trade of this contract.   Correctness at the edge is defended separately:     - `SYNC_RESERVE` (15k) is kept back from what is available before the       call, so the `catch` and the Safe's own epilogue (emit `ExecutionSuccess`,       pay the refund, return true) always have gas. EIP-150's 63/64 rule alone       is not enough here: with little gas left it leaves a few hundred, and an       out-of-gas epilogue reverts `execTransaction` — and a guard that makes       `execTransaction` revert is the one thing that bricks a Safe.     - Consequence, stated because a test pins it: a Safe transaction whose       gas limit is tight enough that the module cannot finish simply skips       the sync. The Safe's own call still succeeds. The proposer adding a       little headroom to the gas limit is what makes the hook fire.     - The guard is installed on every transaction, not only on owner       changes, and a no-op `sync()` still reads `getOwners()` and compares       the sets: ~45k gas. That is the standing price of a history with no       gaps, and it is paid by the Safe, not by the author's readers. The ABI, verified rather than assumed:   `Enum.Operation` from the Safe's `IGuard` cannot be imported (no Safe   dependency), and its ABI type is `uint8`, so a local two-member enum gives   the identical encoding. The selector the Safe calls is   `checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)`,   asserted in the test suite against the ABI this file compiles to.",
    "version": 1
  }
} = {
  "contractName": "OwnerHistoryGuard",
  "sourceName": "src/OwnerHistoryGuard.sol",
  "abi": [
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "_safe",
          "type": "address"
        },
        {
          "internalType": "address",
          "name": "_module",
          "type": "address"
        }
      ],
      "stateMutability": "nonpayable",
      "type": "constructor"
    },
    {
      "inputs": [],
      "name": "ZeroAddress",
      "type": "error"
    },
    {
      "inputs": [
        {
          "internalType": "bytes32",
          "name": "",
          "type": "bytes32"
        },
        {
          "internalType": "bool",
          "name": "",
          "type": "bool"
        }
      ],
      "name": "checkAfterExecution",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        },
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        },
        {
          "internalType": "bytes",
          "name": "",
          "type": "bytes"
        },
        {
          "internalType": "enum OwnerHistoryGuard.Operation",
          "name": "",
          "type": "uint8"
        },
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        },
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        },
        {
          "internalType": "address payable",
          "name": "",
          "type": "address"
        },
        {
          "internalType": "bytes",
          "name": "",
          "type": "bytes"
        },
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "name": "checkTransaction",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "module",
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
      "inputs": [],
      "name": "safe",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    }
  ],
  "bytecode": "0x60c0346100bd57601f6103f638819003918201601f19168301916001600160401b038311848410176100c15780849260409485528339810103126100bd57610052602061004b836100d5565b92016100d5565b906001600160a01b03808216159081156100b2575b506100a05760805260a05260405161030c90816100ea823960805181818161015b01526101c2015260a051818181605d015261022b0152f35b60405163d92e233d60e01b8152600490fd5b90508216155f610067565b5f80fd5b634e487b7160e01b5f52604160045260245ffd5b51906001600160a01b03821682036100bd5756fe6080806040526004361015610012575f80fd5b5f3560e01c908163186f0354146101495750806375f0bb52146100b657806393271368146100905763b86d529814610048575f80fd5b3461008c575f36600319011261008c576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b5f80fd5b3461008c57604036600319011261008c576024358015150361008c576100b46101b8565b005b3461008c5761016036600319011261008c576001600160a01b036004358181160361008c5767ffffffffffffffff60443581811161008c576100fc90369060040161018a565b50506002606435101561008c5760e4358281160361008c57610104358281160361008c576101243590811161008c5761013990369060040161018a565b5050610144359081160361008c57005b3461008c575f36600319011261008c577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b9181601f8401121561008c5782359167ffffffffffffffff831161008c576020838186019501011161008c57565b6001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000811633036102d3575a90613a988211156102cf57613a971982019182116102bb575f91602091620927c08083116102b2575b50600490604051948593849263fff6cae960e01b84527f00000000000000000000000000000000000000000000000000000000000000001690f16102545750565b60203d6020116102ab575b601f8101601f1916820167ffffffffffffffff8111838210176102975760209183916040528101031261008c57518015150361008c57565b634e487b7160e01b5f52604160045260245ffd5b503d61025f565b91506004610213565b634e487b7160e01b5f52601160045260245ffd5b5050565b5056fea2646970667358221220a84aa03fccf15c5a035207cb2baa402793b1a63e4ed2a318e88f95bd8cce83a964736f6c63430008180033",
  "deployedBytecode": "0x6080806040526004361015610012575f80fd5b5f3560e01c908163186f0354146101495750806375f0bb52146100b657806393271368146100905763b86d529814610048575f80fd5b3461008c575f36600319011261008c576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b5f80fd5b3461008c57604036600319011261008c576024358015150361008c576100b46101b8565b005b3461008c5761016036600319011261008c576001600160a01b036004358181160361008c5767ffffffffffffffff60443581811161008c576100fc90369060040161018a565b50506002606435101561008c5760e4358281160361008c57610104358281160361008c576101243590811161008c5761013990369060040161018a565b5050610144359081160361008c57005b3461008c575f36600319011261008c577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b9181601f8401121561008c5782359167ffffffffffffffff831161008c576020838186019501011161008c57565b6001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000811633036102d3575a90613a988211156102cf57613a971982019182116102bb575f91602091620927c08083116102b2575b50600490604051948593849263fff6cae960e01b84527f00000000000000000000000000000000000000000000000000000000000000001690f16102545750565b60203d6020116102ab575b601f8101601f1916820167ffffffffffffffff8111838210176102975760209183916040528101031261008c57518015150361008c57565b634e487b7160e01b5f52604160045260245ffd5b503d61025f565b91506004610213565b634e487b7160e01b5f52601160045260245ffd5b5050565b5056fea2646970667358221220a84aa03fccf15c5a035207cb2baa402793b1a63e4ed2a318e88f95bd8cce83a964736f6c63430008180033",
  "linkReferences": {},
  "deployedLinkReferences": {},
  "immutableReferences": {
    "2712": [
      {
        "length": 32,
        "start": 347
      },
      {
        "length": 32,
        "start": 450
      }
    ],
    "2715": [
      {
        "length": 32,
        "start": 93
      },
      {
        "length": 32,
        "start": 555
      }
    ]
  },
  "inputSourceName": "project/src/OwnerHistoryGuard.sol",
  "devdoc": {
    "kind": "dev",
    "methods": {
      "checkAfterExecution(bytes32,bool)": {
        "details": "Called by the Safe after every execution. A no-op unless a genuine      Safe is calling, and even then a module failure is swallowed."
      },
      "checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)": {
        "details": "Intentionally empty. Named parameters are omitted so nothing here      can even tempt a future edit into reading calldata."
      }
    },
    "stateVariables": {
      "SYNC_GAS": {
        "details": "See \"Gas bound\" above: measured ceiling for a rotation, and the      slice of the remaining gas kept back for the catch and the Safe."
      }
    },
    "title": "OwnerHistoryGuard",
    "version": 1
  },
  "evm": {
    "bytecode": {
      "linkReferences": {},
      "object": "60c0346100bd57601f6103f638819003918201601f19168301916001600160401b038311848410176100c15780849260409485528339810103126100bd57610052602061004b836100d5565b92016100d5565b906001600160a01b03808216159081156100b2575b506100a05760805260a05260405161030c90816100ea823960805181818161015b01526101c2015260a051818181605d015261022b0152f35b60405163d92e233d60e01b8152600490fd5b90508216155f610067565b5f80fd5b634e487b7160e01b5f52604160045260245ffd5b51906001600160a01b03821682036100bd5756fe6080806040526004361015610012575f80fd5b5f3560e01c908163186f0354146101495750806375f0bb52146100b657806393271368146100905763b86d529814610048575f80fd5b3461008c575f36600319011261008c576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b5f80fd5b3461008c57604036600319011261008c576024358015150361008c576100b46101b8565b005b3461008c5761016036600319011261008c576001600160a01b036004358181160361008c5767ffffffffffffffff60443581811161008c576100fc90369060040161018a565b50506002606435101561008c5760e4358281160361008c57610104358281160361008c576101243590811161008c5761013990369060040161018a565b5050610144359081160361008c57005b3461008c575f36600319011261008c577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b9181601f8401121561008c5782359167ffffffffffffffff831161008c576020838186019501011161008c57565b6001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000811633036102d3575a90613a988211156102cf57613a971982019182116102bb575f91602091620927c08083116102b2575b50600490604051948593849263fff6cae960e01b84527f00000000000000000000000000000000000000000000000000000000000000001690f16102545750565b60203d6020116102ab575b601f8101601f1916820167ffffffffffffffff8111838210176102975760209183916040528101031261008c57518015150361008c57565b634e487b7160e01b5f52604160045260245ffd5b503d61025f565b91506004610213565b634e487b7160e01b5f52601160045260245ffd5b5050565b5056fea2646970667358221220a84aa03fccf15c5a035207cb2baa402793b1a63e4ed2a318e88f95bd8cce83a964736f6c63430008180033",
      "opcodes": "PUSH1 0xC0 CALLVALUE PUSH2 0xBD JUMPI PUSH1 0x1F PUSH2 0x3F6 CODESIZE DUP2 SWAP1 SUB SWAP2 DUP3 ADD PUSH1 0x1F NOT AND DUP4 ADD SWAP2 PUSH1 0x1 PUSH1 0x1 PUSH1 0x40 SHL SUB DUP4 GT DUP5 DUP5 LT OR PUSH2 0xC1 JUMPI DUP1 DUP5 SWAP3 PUSH1 0x40 SWAP5 DUP6 MSTORE DUP4 CODECOPY DUP2 ADD SUB SLT PUSH2 0xBD JUMPI PUSH2 0x52 PUSH1 0x20 PUSH2 0x4B DUP4 PUSH2 0xD5 JUMP JUMPDEST SWAP3 ADD PUSH2 0xD5 JUMP JUMPDEST SWAP1 PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB DUP1 DUP3 AND ISZERO SWAP1 DUP2 ISZERO PUSH2 0xB2 JUMPI JUMPDEST POP PUSH2 0xA0 JUMPI PUSH1 0x80 MSTORE PUSH1 0xA0 MSTORE PUSH1 0x40 MLOAD PUSH2 0x30C SWAP1 DUP2 PUSH2 0xEA DUP3 CODECOPY PUSH1 0x80 MLOAD DUP2 DUP2 DUP2 PUSH2 0x15B ADD MSTORE PUSH2 0x1C2 ADD MSTORE PUSH1 0xA0 MLOAD DUP2 DUP2 DUP2 PUSH1 0x5D ADD MSTORE PUSH2 0x22B ADD MSTORE RETURN JUMPDEST PUSH1 0x40 MLOAD PUSH4 0xD92E233D PUSH1 0xE0 SHL DUP2 MSTORE PUSH1 0x4 SWAP1 REVERT JUMPDEST SWAP1 POP DUP3 AND ISZERO PUSH0 PUSH2 0x67 JUMP JUMPDEST PUSH0 DUP1 REVERT JUMPDEST PUSH4 0x4E487B71 PUSH1 0xE0 SHL PUSH0 MSTORE PUSH1 0x41 PUSH1 0x4 MSTORE PUSH1 0x24 PUSH0 REVERT JUMPDEST MLOAD SWAP1 PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB DUP3 AND DUP3 SUB PUSH2 0xBD JUMPI JUMP INVALID PUSH1 0x80 DUP1 PUSH1 0x40 MSTORE PUSH1 0x4 CALLDATASIZE LT ISZERO PUSH2 0x12 JUMPI PUSH0 DUP1 REVERT JUMPDEST PUSH0 CALLDATALOAD PUSH1 0xE0 SHR SWAP1 DUP2 PUSH4 0x186F0354 EQ PUSH2 0x149 JUMPI POP DUP1 PUSH4 0x75F0BB52 EQ PUSH2 0xB6 JUMPI DUP1 PUSH4 0x93271368 EQ PUSH2 0x90 JUMPI PUSH4 0xB86D5298 EQ PUSH2 0x48 JUMPI PUSH0 DUP1 REVERT JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH0 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH1 0x40 MLOAD PUSH32 0x0 PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB AND DUP2 MSTORE PUSH1 0x20 SWAP1 RETURN JUMPDEST PUSH0 DUP1 REVERT JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH1 0x40 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH1 0x24 CALLDATALOAD DUP1 ISZERO ISZERO SUB PUSH2 0x8C JUMPI PUSH2 0xB4 PUSH2 0x1B8 JUMP JUMPDEST STOP JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH2 0x160 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB PUSH1 0x4 CALLDATALOAD DUP2 DUP2 AND SUB PUSH2 0x8C JUMPI PUSH8 0xFFFFFFFFFFFFFFFF PUSH1 0x44 CALLDATALOAD DUP2 DUP2 GT PUSH2 0x8C JUMPI PUSH2 0xFC SWAP1 CALLDATASIZE SWAP1 PUSH1 0x4 ADD PUSH2 0x18A JUMP JUMPDEST POP POP PUSH1 0x2 PUSH1 0x64 CALLDATALOAD LT ISZERO PUSH2 0x8C JUMPI PUSH1 0xE4 CALLDATALOAD DUP3 DUP2 AND SUB PUSH2 0x8C JUMPI PUSH2 0x104 CALLDATALOAD DUP3 DUP2 AND SUB PUSH2 0x8C JUMPI PUSH2 0x124 CALLDATALOAD SWAP1 DUP2 GT PUSH2 0x8C JUMPI PUSH2 0x139 SWAP1 CALLDATASIZE SWAP1 PUSH1 0x4 ADD PUSH2 0x18A JUMP JUMPDEST POP POP PUSH2 0x144 CALLDATALOAD SWAP1 DUP2 AND SUB PUSH2 0x8C JUMPI STOP JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH0 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH32 0x0 PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB AND DUP2 MSTORE PUSH1 0x20 SWAP1 RETURN JUMPDEST SWAP2 DUP2 PUSH1 0x1F DUP5 ADD SLT ISZERO PUSH2 0x8C JUMPI DUP3 CALLDATALOAD SWAP2 PUSH8 0xFFFFFFFFFFFFFFFF DUP4 GT PUSH2 0x8C JUMPI PUSH1 0x20 DUP4 DUP2 DUP7 ADD SWAP6 ADD ADD GT PUSH2 0x8C JUMPI JUMP JUMPDEST PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB PUSH32 0x0 DUP2 AND CALLER SUB PUSH2 0x2D3 JUMPI GAS SWAP1 PUSH2 0x3A98 DUP3 GT ISZERO PUSH2 0x2CF JUMPI PUSH2 0x3A97 NOT DUP3 ADD SWAP2 DUP3 GT PUSH2 0x2BB JUMPI PUSH0 SWAP2 PUSH1 0x20 SWAP2 PUSH3 0x927C0 DUP1 DUP4 GT PUSH2 0x2B2 JUMPI JUMPDEST POP PUSH1 0x4 SWAP1 PUSH1 0x40 MLOAD SWAP5 DUP6 SWAP4 DUP5 SWAP3 PUSH4 0xFFF6CAE9 PUSH1 0xE0 SHL DUP5 MSTORE PUSH32 0x0 AND SWAP1 CALL PUSH2 0x254 JUMPI POP JUMP JUMPDEST PUSH1 0x20 RETURNDATASIZE PUSH1 0x20 GT PUSH2 0x2AB JUMPI JUMPDEST PUSH1 0x1F DUP2 ADD PUSH1 0x1F NOT AND DUP3 ADD PUSH8 0xFFFFFFFFFFFFFFFF DUP2 GT DUP4 DUP3 LT OR PUSH2 0x297 JUMPI PUSH1 0x20 SWAP2 DUP4 SWAP2 PUSH1 0x40 MSTORE DUP2 ADD SUB SLT PUSH2 0x8C JUMPI MLOAD DUP1 ISZERO ISZERO SUB PUSH2 0x8C JUMPI JUMP JUMPDEST PUSH4 0x4E487B71 PUSH1 0xE0 SHL PUSH0 MSTORE PUSH1 0x41 PUSH1 0x4 MSTORE PUSH1 0x24 PUSH0 REVERT JUMPDEST POP RETURNDATASIZE PUSH2 0x25F JUMP JUMPDEST SWAP2 POP PUSH1 0x4 PUSH2 0x213 JUMP JUMPDEST PUSH4 0x4E487B71 PUSH1 0xE0 SHL PUSH0 MSTORE PUSH1 0x11 PUSH1 0x4 MSTORE PUSH1 0x24 PUSH0 REVERT JUMPDEST POP POP JUMP JUMPDEST POP JUMP INVALID LOG2 PUSH5 0x6970667358 0x22 SLT KECCAK256 0xA8 BLOBBASEFEE LOG0 EXTCODEHASH 0xCC CALL TLOAD GAS SUB MSTORE SMOD 0xCB 0x2B 0xAA BLOCKHASH 0x27 SWAP4 0xB1 0xA6 RETURNDATACOPY 0x4E 0xD2 LOG3 XOR 0xE8 DUP16 SWAP6 0xBD DUP13 0xCE DUP4 0xA9 PUSH5 0x736F6C6343 STOP ADDMOD XOR STOP CALLER ",
      "sourceMap": "4826:2207:18:-:0;;;;;;;;;;;;;-1:-1:-1;;4826:2207:18;;;;-1:-1:-1;;;;;4826:2207:18;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;;:::i;:::-;;-1:-1:-1;;;;;4826:2207:18;;;5501:19;;:44;;;;-1:-1:-1;5497:70:18;;;5577:12;;5599:16;;4826:2207;;;;;;;;5577:12;4826:2207;;;;;;;;;;5599:16;4826:2207;;;;;;;;;;;5497:70;4826:2207;;-1:-1:-1;;;5554:13:18;;;;;5501:44;4826:2207;;;;5524:21;5501:44;;;4826:2207;-1:-1:-1;4826:2207:18;;;;;;-1:-1:-1;4826:2207:18;;;;;-1:-1:-1;4826:2207:18;;;;-1:-1:-1;;;;;4826:2207:18;;;;;;:::o"
    },
    "deployedBytecode": {
      "immutableReferences": {
        "2712": [
          {
            "length": 32,
            "start": 347
          },
          {
            "length": 32,
            "start": 450
          }
        ],
        "2715": [
          {
            "length": 32,
            "start": 93
          },
          {
            "length": 32,
            "start": 555
          }
        ]
      },
      "linkReferences": {},
      "object": "6080806040526004361015610012575f80fd5b5f3560e01c908163186f0354146101495750806375f0bb52146100b657806393271368146100905763b86d529814610048575f80fd5b3461008c575f36600319011261008c576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b5f80fd5b3461008c57604036600319011261008c576024358015150361008c576100b46101b8565b005b3461008c5761016036600319011261008c576001600160a01b036004358181160361008c5767ffffffffffffffff60443581811161008c576100fc90369060040161018a565b50506002606435101561008c5760e4358281160361008c57610104358281160361008c576101243590811161008c5761013990369060040161018a565b5050610144359081160361008c57005b3461008c575f36600319011261008c577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b9181601f8401121561008c5782359167ffffffffffffffff831161008c576020838186019501011161008c57565b6001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000811633036102d3575a90613a988211156102cf57613a971982019182116102bb575f91602091620927c08083116102b2575b50600490604051948593849263fff6cae960e01b84527f00000000000000000000000000000000000000000000000000000000000000001690f16102545750565b60203d6020116102ab575b601f8101601f1916820167ffffffffffffffff8111838210176102975760209183916040528101031261008c57518015150361008c57565b634e487b7160e01b5f52604160045260245ffd5b503d61025f565b91506004610213565b634e487b7160e01b5f52601160045260245ffd5b5050565b5056fea2646970667358221220a84aa03fccf15c5a035207cb2baa402793b1a63e4ed2a318e88f95bd8cce83a964736f6c63430008180033",
      "opcodes": "PUSH1 0x80 DUP1 PUSH1 0x40 MSTORE PUSH1 0x4 CALLDATASIZE LT ISZERO PUSH2 0x12 JUMPI PUSH0 DUP1 REVERT JUMPDEST PUSH0 CALLDATALOAD PUSH1 0xE0 SHR SWAP1 DUP2 PUSH4 0x186F0354 EQ PUSH2 0x149 JUMPI POP DUP1 PUSH4 0x75F0BB52 EQ PUSH2 0xB6 JUMPI DUP1 PUSH4 0x93271368 EQ PUSH2 0x90 JUMPI PUSH4 0xB86D5298 EQ PUSH2 0x48 JUMPI PUSH0 DUP1 REVERT JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH0 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH1 0x40 MLOAD PUSH32 0x0 PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB AND DUP2 MSTORE PUSH1 0x20 SWAP1 RETURN JUMPDEST PUSH0 DUP1 REVERT JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH1 0x40 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH1 0x24 CALLDATALOAD DUP1 ISZERO ISZERO SUB PUSH2 0x8C JUMPI PUSH2 0xB4 PUSH2 0x1B8 JUMP JUMPDEST STOP JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH2 0x160 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB PUSH1 0x4 CALLDATALOAD DUP2 DUP2 AND SUB PUSH2 0x8C JUMPI PUSH8 0xFFFFFFFFFFFFFFFF PUSH1 0x44 CALLDATALOAD DUP2 DUP2 GT PUSH2 0x8C JUMPI PUSH2 0xFC SWAP1 CALLDATASIZE SWAP1 PUSH1 0x4 ADD PUSH2 0x18A JUMP JUMPDEST POP POP PUSH1 0x2 PUSH1 0x64 CALLDATALOAD LT ISZERO PUSH2 0x8C JUMPI PUSH1 0xE4 CALLDATALOAD DUP3 DUP2 AND SUB PUSH2 0x8C JUMPI PUSH2 0x104 CALLDATALOAD DUP3 DUP2 AND SUB PUSH2 0x8C JUMPI PUSH2 0x124 CALLDATALOAD SWAP1 DUP2 GT PUSH2 0x8C JUMPI PUSH2 0x139 SWAP1 CALLDATASIZE SWAP1 PUSH1 0x4 ADD PUSH2 0x18A JUMP JUMPDEST POP POP PUSH2 0x144 CALLDATALOAD SWAP1 DUP2 AND SUB PUSH2 0x8C JUMPI STOP JUMPDEST CALLVALUE PUSH2 0x8C JUMPI PUSH0 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH2 0x8C JUMPI PUSH32 0x0 PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB AND DUP2 MSTORE PUSH1 0x20 SWAP1 RETURN JUMPDEST SWAP2 DUP2 PUSH1 0x1F DUP5 ADD SLT ISZERO PUSH2 0x8C JUMPI DUP3 CALLDATALOAD SWAP2 PUSH8 0xFFFFFFFFFFFFFFFF DUP4 GT PUSH2 0x8C JUMPI PUSH1 0x20 DUP4 DUP2 DUP7 ADD SWAP6 ADD ADD GT PUSH2 0x8C JUMPI JUMP JUMPDEST PUSH1 0x1 PUSH1 0x1 PUSH1 0xA0 SHL SUB PUSH32 0x0 DUP2 AND CALLER SUB PUSH2 0x2D3 JUMPI GAS SWAP1 PUSH2 0x3A98 DUP3 GT ISZERO PUSH2 0x2CF JUMPI PUSH2 0x3A97 NOT DUP3 ADD SWAP2 DUP3 GT PUSH2 0x2BB JUMPI PUSH0 SWAP2 PUSH1 0x20 SWAP2 PUSH3 0x927C0 DUP1 DUP4 GT PUSH2 0x2B2 JUMPI JUMPDEST POP PUSH1 0x4 SWAP1 PUSH1 0x40 MLOAD SWAP5 DUP6 SWAP4 DUP5 SWAP3 PUSH4 0xFFF6CAE9 PUSH1 0xE0 SHL DUP5 MSTORE PUSH32 0x0 AND SWAP1 CALL PUSH2 0x254 JUMPI POP JUMP JUMPDEST PUSH1 0x20 RETURNDATASIZE PUSH1 0x20 GT PUSH2 0x2AB JUMPI JUMPDEST PUSH1 0x1F DUP2 ADD PUSH1 0x1F NOT AND DUP3 ADD PUSH8 0xFFFFFFFFFFFFFFFF DUP2 GT DUP4 DUP3 LT OR PUSH2 0x297 JUMPI PUSH1 0x20 SWAP2 DUP4 SWAP2 PUSH1 0x40 MSTORE DUP2 ADD SUB SLT PUSH2 0x8C JUMPI MLOAD DUP1 ISZERO ISZERO SUB PUSH2 0x8C JUMPI JUMP JUMPDEST PUSH4 0x4E487B71 PUSH1 0xE0 SHL PUSH0 MSTORE PUSH1 0x41 PUSH1 0x4 MSTORE PUSH1 0x24 PUSH0 REVERT JUMPDEST POP RETURNDATASIZE PUSH2 0x25F JUMP JUMPDEST SWAP2 POP PUSH1 0x4 PUSH2 0x213 JUMP JUMPDEST PUSH4 0x4E487B71 PUSH1 0xE0 SHL PUSH0 MSTORE PUSH1 0x11 PUSH1 0x4 MSTORE PUSH1 0x24 PUSH0 REVERT JUMPDEST POP POP JUMP JUMPDEST POP JUMP INVALID LOG2 PUSH5 0x6970667358 0x22 SLT KECCAK256 0xA8 BLOBBASEFEE LOG0 EXTCODEHASH 0xCC CALL TLOAD GAS SUB MSTORE SMOD 0xCB 0x2B 0xAA BLOCKHASH 0x27 SWAP4 0xB1 0xA6 RETURNDATACOPY 0x4E 0xD2 LOG3 XOR 0xE8 DUP16 SWAP6 0xBD DUP13 0xCE DUP4 0xA9 PUSH5 0x736F6C6343 STOP ADDMOD XOR STOP CALLER ",
      "sourceMap": "4826:2207:18:-:0;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;-1:-1:-1;;4826:2207:18;;;;;;5120:31;-1:-1:-1;;;;;4826:2207:18;;;;;;;;;;;;;;;;-1:-1:-1;;4826:2207:18;;;;;;;;;;;;;;:::i;:::-;;;;;;;;-1:-1:-1;;4826:2207:18;;;;-1:-1:-1;;;;;4826:2207:18;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;;-1:-1:-1;;4826:2207:18;;;;5027:29;-1:-1:-1;;;;;4826:2207:18;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::o;6187:844::-;-1:-1:-1;;;;;6498:4:18;4826:2207;;6484:10;:18;6480:31;;6541:9;6564:25;5404:6;6564:25;;;6560:38;;-1:-1:-1;;5404:6:18;;;;;;;-1:-1:-1;;6713:41:18;;5350:7;6662:17;;;6658:40;;6187:844;4826:2207;6713:41;4826:2207;;;5350:7;;;;;;;;6713:41;;6727:6;4826:2207;6713:41;;;;6187:844;:::o;6713:41::-;;;;;;;;5350:7;;;-1:-1:-1;;5350:7:18;;;;;;;;;;;;6713:41;5350:7;;;4826:2207;5350:7;6713:41;;5350:7;;;;;4826:2207;;;;;;6187:844::o;5350:7::-;5404:6;;;-1:-1:-1;5350:7:18;;6713:41;5350:7;;-1:-1:-1;5350:7:18;6713:41;;;;;6658:40;;-1:-1:-1;6713:41:18;6658:40;;5404:6;;;;-1:-1:-1;5404:6:18;;;;;-1:-1:-1;5404:6:18;6560:38;6591:7;;:::o;6480:31::-;6504:7;:::o"
    },
    "gasEstimates": {
      "creation": {
        "codeDepositCost": "156000",
        "executionCost": "infinite",
        "totalCost": "infinite"
      },
      "external": {
        "checkAfterExecution(bytes32,bool)": "infinite",
        "checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)": "infinite",
        "module()": "infinite",
        "safe()": "infinite"
      }
    },
    "methodIdentifiers": {
      "checkAfterExecution(bytes32,bool)": "93271368",
      "checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)": "75f0bb52",
      "module()": "b86d5298",
      "safe()": "186f0354"
    }
  },
  "metadata": "{\"compiler\":{\"version\":\"0.8.24+commit.e11b9ed9\"},\"language\":\"Solidity\",\"output\":{\"abi\":[{\"inputs\":[{\"internalType\":\"address\",\"name\":\"_safe\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"_module\",\"type\":\"address\"}],\"stateMutability\":\"nonpayable\",\"type\":\"constructor\"},{\"inputs\":[],\"name\":\"ZeroAddress\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"},{\"internalType\":\"bool\",\"name\":\"\",\"type\":\"bool\"}],\"name\":\"checkAfterExecution\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"},{\"internalType\":\"bytes\",\"name\":\"\",\"type\":\"bytes\"},{\"internalType\":\"enum OwnerHistoryGuard.Operation\",\"name\":\"\",\"type\":\"uint8\"},{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"},{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"},{\"internalType\":\"address payable\",\"name\":\"\",\"type\":\"address\"},{\"internalType\":\"bytes\",\"name\":\"\",\"type\":\"bytes\"},{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"}],\"name\":\"checkTransaction\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"module\",\"outputs\":[{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"safe\",\"outputs\":[{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"}],\"stateMutability\":\"view\",\"type\":\"function\"}],\"devdoc\":{\"kind\":\"dev\",\"methods\":{\"checkAfterExecution(bytes32,bool)\":{\"details\":\"Called by the Safe after every execution. A no-op unless a genuine      Safe is calling, and even then a module failure is swallowed.\"},\"checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)\":{\"details\":\"Intentionally empty. Named parameters are omitted so nothing here      can even tempt a future edit into reading calldata.\"}},\"stateVariables\":{\"SYNC_GAS\":{\"details\":\"See \\\"Gas bound\\\" above: measured ceiling for a rotation, and the      slice of the remaining gas kept back for the catch and the Safe.\"}},\"title\":\"OwnerHistoryGuard\",\"version\":1},\"userdoc\":{\"kind\":\"user\",\"methods\":{\"module()\":{\"notice\":\"The owner-history module to keep current.\"},\"safe()\":{\"notice\":\"The Safe this guard is installed on; the only sender whose         post-execution call is honoured.\"}},\"notice\":\"Safe 1.4.1 transaction guard that keeps `OwnerHistoryModuleV1`         current. Installed with the Safe's own `setGuard` (which is         `onlySelf`, so a Safe transaction installs it). This is the hook, and the Safe has no other one. `execTransaction` calls `checkTransaction` before the execution and `checkAfterExecution` after it. Every owner mutation \\u2014 `addOwnerWithThreshold`, `removeOwner`, `swapOwner`, `changeThreshold` \\u2014 is `onlySelf`, i.e. it must go through `execTransaction`, so a guard sees all of them. There is deliberately no other tap: the Safe emits `AddedOwner`/`RemovedOwner` but emits nothing an off-chain or on-chain listener can *act* on, and 1.4.1 has no owner-rotation callback. Why this contract is separate from the module, and why it is this small:   A reverting guard **bricks the Safe permanently**. Removing it needs a Safe   transaction, and the broken guard would block that transaction. So the   guard holds no storage, has no owner, is not upgradeable, and every path   out of it is a no-op:     - `checkTransaction` has an empty body. It never reads, never reverts,       never can be made to. (A guard *can* veto; this one refuses to.)     - `checkAfterExecution` returns unless the caller is the Safe, and calls       the module inside `try/catch`, so a broken module is a skipped sync, not       a blocked Safe.   The module is where bugs are allowed to live, because a broken module is   repairable: `sync()` is permissionless and the Safe can upgrade or replace   the module without the guard's help. Gas bound on the module call:   `sync()` is cold-storage work: it closes an era, opens one, and opens or   closes a tenure pair per changed address. Measured on this build as the   execution gas of a direct `sync()` transaction (gas used minus the 21k   transaction base), on a Safe growing from 2 owners:     add one owner, era of 2 ............ 306k     add one owner, era of 3 ............ 337k     add one owner, era of 4 ............ 369k     swap one owner, 5 owners ........... 394k     remove one owner, 5 owners ......... 211k     no change at all ................... ~45k   ~32k per owner, because each era stores its owner array. So the ceiling is   600k: comfortably above a rotation on any realistic Safe (2-5 owners) and   below the point where a compromised module could drain a Safe transaction's   budget. A call's gas limit is a ceiling, not a cost \\u2014 a sync that needs   306k spends 306k \\u2014 so an over-generous bound would only widen the griefing   window. A rotation too large for 600k (a dozen owners gaining several at   once) misses its sync and is repaired by anyone calling `sync()`: stale for   one block beats a blocked Safe, which is the whole trade of this contract.   Correctness at the edge is defended separately:     - `SYNC_RESERVE` (15k) is kept back from what is available before the       call, so the `catch` and the Safe's own epilogue (emit `ExecutionSuccess`,       pay the refund, return true) always have gas. EIP-150's 63/64 rule alone       is not enough here: with little gas left it leaves a few hundred, and an       out-of-gas epilogue reverts `execTransaction` \\u2014 and a guard that makes       `execTransaction` revert is the one thing that bricks a Safe.     - Consequence, stated because a test pins it: a Safe transaction whose       gas limit is tight enough that the module cannot finish simply skips       the sync. The Safe's own call still succeeds. The proposer adding a       little headroom to the gas limit is what makes the hook fire.     - The guard is installed on every transaction, not only on owner       changes, and a no-op `sync()` still reads `getOwners()` and compares       the sets: ~45k gas. That is the standing price of a history with no       gaps, and it is paid by the Safe, not by the author's readers. The ABI, verified rather than assumed:   `Enum.Operation` from the Safe's `IGuard` cannot be imported (no Safe   dependency), and its ABI type is `uint8`, so a local two-member enum gives   the identical encoding. The selector the Safe calls is   `checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)`,   asserted in the test suite against the ABI this file compiles to.\",\"version\":1}},\"settings\":{\"compilationTarget\":{\"project/src/OwnerHistoryGuard.sol\":\"OwnerHistoryGuard\"},\"evmVersion\":\"shanghai\",\"libraries\":{},\"metadata\":{\"bytecodeHash\":\"ipfs\",\"useLiteralContent\":true},\"optimizer\":{\"enabled\":true,\"runs\":200},\"remappings\":[\"project/:@openzeppelin/contracts-upgradeable/=npm/@openzeppelin/contracts-upgradeable@4.9.6/\",\"project/:@openzeppelin/contracts/=npm/@openzeppelin/contracts@4.9.6/\"],\"viaIR\":true},\"sources\":{\"project/src/OwnerHistoryGuard.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\npragma solidity ^0.8.19;\\n\\n/// @dev The one call the guard makes, declared locally because the Safe package\\n///      is not a dependency of this repo. `sync` returns a bool; the guard does\\n///      not look at it.\\ninterface IOwnerHistory {\\n    function sync() external returns (bool);\\n}\\n\\n/**\\n * @title OwnerHistoryGuard\\n * @notice Safe 1.4.1 transaction guard that keeps `OwnerHistoryModuleV1`\\n *         current. Installed with the Safe's own `setGuard` (which is\\n *         `onlySelf`, so a Safe transaction installs it).\\n *\\n * This is the hook, and the Safe has no other one. `execTransaction` calls\\n * `checkTransaction` before the execution and `checkAfterExecution` after it.\\n * Every owner mutation \\u2014 `addOwnerWithThreshold`, `removeOwner`, `swapOwner`,\\n * `changeThreshold` \\u2014 is `onlySelf`, i.e. it must go through `execTransaction`,\\n * so a guard sees all of them. There is deliberately no other tap: the Safe\\n * emits `AddedOwner`/`RemovedOwner` but emits nothing an off-chain or on-chain\\n * listener can *act* on, and 1.4.1 has no owner-rotation callback.\\n *\\n * Why this contract is separate from the module, and why it is this small:\\n *   A reverting guard **bricks the Safe permanently**. Removing it needs a Safe\\n *   transaction, and the broken guard would block that transaction. So the\\n *   guard holds no storage, has no owner, is not upgradeable, and every path\\n *   out of it is a no-op:\\n *     - `checkTransaction` has an empty body. It never reads, never reverts,\\n *       never can be made to. (A guard *can* veto; this one refuses to.)\\n *     - `checkAfterExecution` returns unless the caller is the Safe, and calls\\n *       the module inside `try/catch`, so a broken module is a skipped sync, not\\n *       a blocked Safe.\\n *   The module is where bugs are allowed to live, because a broken module is\\n *   repairable: `sync()` is permissionless and the Safe can upgrade or replace\\n *   the module without the guard's help.\\n *\\n * Gas bound on the module call:\\n *   `sync()` is cold-storage work: it closes an era, opens one, and opens or\\n *   closes a tenure pair per changed address. Measured on this build as the\\n *   execution gas of a direct `sync()` transaction (gas used minus the 21k\\n *   transaction base), on a Safe growing from 2 owners:\\n *\\n *     add one owner, era of 2 ............ 306k\\n *     add one owner, era of 3 ............ 337k\\n *     add one owner, era of 4 ............ 369k\\n *     swap one owner, 5 owners ........... 394k\\n *     remove one owner, 5 owners ......... 211k\\n *     no change at all ................... ~45k\\n *\\n *   ~32k per owner, because each era stores its owner array. So the ceiling is\\n *   600k: comfortably above a rotation on any realistic Safe (2-5 owners) and\\n *   below the point where a compromised module could drain a Safe transaction's\\n *   budget. A call's gas limit is a ceiling, not a cost \\u2014 a sync that needs\\n *   306k spends 306k \\u2014 so an over-generous bound would only widen the griefing\\n *   window. A rotation too large for 600k (a dozen owners gaining several at\\n *   once) misses its sync and is repaired by anyone calling `sync()`: stale for\\n *   one block beats a blocked Safe, which is the whole trade of this contract.\\n *\\n *   Correctness at the edge is defended separately:\\n *     - `SYNC_RESERVE` (15k) is kept back from what is available before the\\n *       call, so the `catch` and the Safe's own epilogue (emit `ExecutionSuccess`,\\n *       pay the refund, return true) always have gas. EIP-150's 63/64 rule alone\\n *       is not enough here: with little gas left it leaves a few hundred, and an\\n *       out-of-gas epilogue reverts `execTransaction` \\u2014 and a guard that makes\\n *       `execTransaction` revert is the one thing that bricks a Safe.\\n *     - Consequence, stated because a test pins it: a Safe transaction whose\\n *       gas limit is tight enough that the module cannot finish simply skips\\n *       the sync. The Safe's own call still succeeds. The proposer adding a\\n *       little headroom to the gas limit is what makes the hook fire.\\n *     - The guard is installed on every transaction, not only on owner\\n *       changes, and a no-op `sync()` still reads `getOwners()` and compares\\n *       the sets: ~45k gas. That is the standing price of a history with no\\n *       gaps, and it is paid by the Safe, not by the author's readers.\\n *\\n * The ABI, verified rather than assumed:\\n *   `Enum.Operation` from the Safe's `IGuard` cannot be imported (no Safe\\n *   dependency), and its ABI type is `uint8`, so a local two-member enum gives\\n *   the identical encoding. The selector the Safe calls is\\n *   `checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)`,\\n *   asserted in the test suite against the ABI this file compiles to.\\n */\\ncontract OwnerHistoryGuard {\\n\\n    enum Operation { Call, DelegateCall }\\n\\n    /// @notice The Safe this guard is installed on; the only sender whose\\n    ///         post-execution call is honoured.\\n    address public immutable safe;\\n    /// @notice The owner-history module to keep current.\\n    address public immutable module;\\n\\n    /// @dev See \\\"Gas bound\\\" above: measured ceiling for a rotation, and the\\n    ///      slice of the remaining gas kept back for the catch and the Safe.\\n    uint256 internal constant SYNC_GAS = 600_000;\\n    uint256 internal constant SYNC_RESERVE = 15_000;\\n\\n    error ZeroAddress();\\n\\n    constructor(address _safe, address _module) {\\n        if (_safe == address(0) || _module == address(0)) revert ZeroAddress();\\n        safe = _safe;\\n        module = _module;\\n    }\\n\\n    /// @dev Intentionally empty. Named parameters are omitted so nothing here\\n    ///      can even tempt a future edit into reading calldata.\\n    function checkTransaction(\\n        address,\\n        uint256,\\n        bytes calldata,\\n        Operation,\\n        uint256,\\n        uint256,\\n        uint256,\\n        address,\\n        address payable,\\n        bytes calldata,\\n        address\\n    ) external {}\\n\\n    /// @dev Called by the Safe after every execution. A no-op unless a genuine\\n    ///      Safe is calling, and even then a module failure is swallowed.\\n    function checkAfterExecution(bytes32, bool) external {\\n        // Only the Safe's own `execTransaction` may drive the module: without\\n        // this gate anyone could call `sync` through the guard, and (worse) a\\n        // future module with side effects would be callable by anyone.\\n        if (msg.sender != safe) return;\\n\\n        uint256 available = gasleft();\\n        if (available <= SYNC_RESERVE) return;\\n        uint256 budget = available - SYNC_RESERVE;\\n        if (budget > SYNC_GAS) budget = SYNC_GAS;\\n\\n        try IOwnerHistory(module).sync{gas: budget}() returns (bool) {\\n            // The answer (changed / unchanged) is not the guard's business.\\n        } catch {\\n            // A missed sync is repaired by anyone calling `sync()` directly.\\n            // Never bubble: this frame has no right to fail the Safe.\\n        }\\n    }\\n}\\n\",\"keccak256\":\"0x3dfacbb8b4bfbb55c9725939fc12b179ae1557f23a237e781e356c13252815b2\",\"license\":\"MIT\"}},\"version\":1}",
  "storageLayout": {
    "storage": [],
    "types": null
  },
  "userdoc": {
    "kind": "user",
    "methods": {
      "module()": {
        "notice": "The owner-history module to keep current."
      },
      "safe()": {
        "notice": "The Safe this guard is installed on; the only sender whose         post-execution call is honoured."
      }
    },
    "notice": "Safe 1.4.1 transaction guard that keeps `OwnerHistoryModuleV1`         current. Installed with the Safe's own `setGuard` (which is         `onlySelf`, so a Safe transaction installs it). This is the hook, and the Safe has no other one. `execTransaction` calls `checkTransaction` before the execution and `checkAfterExecution` after it. Every owner mutation — `addOwnerWithThreshold`, `removeOwner`, `swapOwner`, `changeThreshold` — is `onlySelf`, i.e. it must go through `execTransaction`, so a guard sees all of them. There is deliberately no other tap: the Safe emits `AddedOwner`/`RemovedOwner` but emits nothing an off-chain or on-chain listener can *act* on, and 1.4.1 has no owner-rotation callback. Why this contract is separate from the module, and why it is this small:   A reverting guard **bricks the Safe permanently**. Removing it needs a Safe   transaction, and the broken guard would block that transaction. So the   guard holds no storage, has no owner, is not upgradeable, and every path   out of it is a no-op:     - `checkTransaction` has an empty body. It never reads, never reverts,       never can be made to. (A guard *can* veto; this one refuses to.)     - `checkAfterExecution` returns unless the caller is the Safe, and calls       the module inside `try/catch`, so a broken module is a skipped sync, not       a blocked Safe.   The module is where bugs are allowed to live, because a broken module is   repairable: `sync()` is permissionless and the Safe can upgrade or replace   the module without the guard's help. Gas bound on the module call:   `sync()` is cold-storage work: it closes an era, opens one, and opens or   closes a tenure pair per changed address. Measured on this build as the   execution gas of a direct `sync()` transaction (gas used minus the 21k   transaction base), on a Safe growing from 2 owners:     add one owner, era of 2 ............ 306k     add one owner, era of 3 ............ 337k     add one owner, era of 4 ............ 369k     swap one owner, 5 owners ........... 394k     remove one owner, 5 owners ......... 211k     no change at all ................... ~45k   ~32k per owner, because each era stores its owner array. So the ceiling is   600k: comfortably above a rotation on any realistic Safe (2-5 owners) and   below the point where a compromised module could drain a Safe transaction's   budget. A call's gas limit is a ceiling, not a cost — a sync that needs   306k spends 306k — so an over-generous bound would only widen the griefing   window. A rotation too large for 600k (a dozen owners gaining several at   once) misses its sync and is repaired by anyone calling `sync()`: stale for   one block beats a blocked Safe, which is the whole trade of this contract.   Correctness at the edge is defended separately:     - `SYNC_RESERVE` (15k) is kept back from what is available before the       call, so the `catch` and the Safe's own epilogue (emit `ExecutionSuccess`,       pay the refund, return true) always have gas. EIP-150's 63/64 rule alone       is not enough here: with little gas left it leaves a few hundred, and an       out-of-gas epilogue reverts `execTransaction` — and a guard that makes       `execTransaction` revert is the one thing that bricks a Safe.     - Consequence, stated because a test pins it: a Safe transaction whose       gas limit is tight enough that the module cannot finish simply skips       the sync. The Safe's own call still succeeds. The proposer adding a       little headroom to the gas limit is what makes the hook fire.     - The guard is installed on every transaction, not only on owner       changes, and a no-op `sync()` still reads `getOwners()` and compares       the sets: ~45k gas. That is the standing price of a history with no       gaps, and it is paid by the Safe, not by the author's readers. The ABI, verified rather than assumed:   `Enum.Operation` from the Safe's `IGuard` cannot be imported (no Safe   dependency), and its ABI type is `uint8`, so a local two-member enum gives   the identical encoding. The selector the Safe calls is   `checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)`,   asserted in the test suite against the ABI this file compiles to.",
    "version": 1
  }
} as const;