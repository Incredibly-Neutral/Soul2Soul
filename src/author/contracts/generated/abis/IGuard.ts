export type Abi_IGuard = [
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "txHash",
        "type": "bytes32"
      },
      {
        "internalType": "bool",
        "name": "success",
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
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      },
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      },
      {
        "internalType": "uint8",
        "name": "operation",
        "type": "uint8"
      },
      {
        "internalType": "uint256",
        "name": "safeTxGas",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "baseGas",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "gasPrice",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "gasToken",
        "type": "address"
      },
      {
        "internalType": "address payable",
        "name": "refundReceiver",
        "type": "address"
      },
      {
        "internalType": "bytes",
        "name": "signatures",
        "type": "bytes"
      },
      {
        "internalType": "address",
        "name": "msgSender",
        "type": "address"
      }
    ],
    "name": "checkTransaction",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];
export const Abi_IGuard: Abi_IGuard = [
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "txHash",
        "type": "bytes32"
      },
      {
        "internalType": "bool",
        "name": "success",
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
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      },
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      },
      {
        "internalType": "uint8",
        "name": "operation",
        "type": "uint8"
      },
      {
        "internalType": "uint256",
        "name": "safeTxGas",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "baseGas",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "gasPrice",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "gasToken",
        "type": "address"
      },
      {
        "internalType": "address payable",
        "name": "refundReceiver",
        "type": "address"
      },
      {
        "internalType": "bytes",
        "name": "signatures",
        "type": "bytes"
      },
      {
        "internalType": "address",
        "name": "msgSender",
        "type": "address"
      }
    ],
    "name": "checkTransaction",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];
