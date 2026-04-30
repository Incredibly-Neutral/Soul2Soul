// export const contractABI = [
//   "event NPublish(address indexed author, address indexed publication, string cid)",
// ];


// export const ensRegistryABI = [
//   {
//     inputs: [{ internalType: "bytes32", name: "node", type: "bytes32" }],
//     name: "resolver",
//     outputs: [{ internalType: "address", name: "", type: "address" }],
//     stateMutability: "view",
//     type: "function",
//   },
//   {
//     inputs: [{ internalType: "string", name: "name", type: "string" }],
//     name: "recordExists",
//     outputs: [{ internalType: "bool", name: "", type: "bool" }],
//     stateMutability: "view",
//     type: "function",
//   },
// ];

// export const resolverABI = [
//   {
//     inputs: [
//       { internalType: "bytes32", name: "node", type: "bytes32" },
//       { internalType: "address", name: "addr", type: "address" },
//     ],
//     name: "setAddr",
//     outputs: [],
//     stateMutability: "nonpayable",
//     type: "function",
//   },
//   {
//     inputs: [
//       { internalType: "bytes32", name: "node", type: "bytes32" },
//       { internalType: "string", name: "key", type: "string" },
//     ],
//     name: "text",
//     outputs: [{ internalType: "string", name: "", type: "string" }],
//     stateMutability: "view",
//     type: "function",
//   },
//   {
//     constant: false,
//     inputs: [
//       { name: "node", type: "bytes32" },
//       { name: "key", type: "string" },
//       { name: "value", type: "string" },
//     ],
//     name: "setText",
//     outputs: [],
//     payable: false,
//     stateMutability: "nonpayable",
//     type: "function",
//   },
//   {
//     inputs: [
//       {
//         internalType: "bytes[]",
//         name: "data",
//         type: "bytes[]",
//       },
//     ],
//     name: "multicall",
//     outputs: [
//       {
//         internalType: "bytes[]",
//         name: "results",
//         type: "bytes[]",
//       },
//     ],
//     stateMutability: "nonpayable",
//     type: "function",
//   },
// ];

// export const safeAbi = [
//   {
//     inputs: [
//       {
//         name: "owner",
//         type: "address",
//       },
//     ],
//     name: "isOwner",
//     outputs: [
//       {
//         name: "",
//         type: "bool",
//       },
//     ],
//     stateMutability: "view",
//     type: "function",
//   },
// ];

// export const publicationAbiStripped = [
//   {
//     inputs: [
//       {
//         name: "_author",
//         type: "address",
//       },
//     ],
//     name: "canPublish",
//     outputs: [
//       {
//         name: "",
//         type: "bool",
//       },
//     ],
//     stateMutability: "view",
//     type: "function",
//   },
//   {
//     inputs: [
//       {
//         name: "stream_id",
//         type: "string",
//       },
//     ],
//     name: "hasDeal",
//     outputs: [
//       {
//         name: "",
//         type: "bool",
//       },
//     ],
//     stateMutability: "view",
//     type: "function",
//   },
// ];

// export const s2sRecordsAbi = [
//     {
//       "inputs": [],
//       "name": "ArrayLengthMismatch",
//       "type": "error"
//     },
//     {
//       "inputs": [],
//       "name": "EmptyKey",
//       "type": "error"
//     },
//     {
//       "inputs": [],
//       "name": "KeyNotFound",
//       "type": "error"
//     },
//     {
//       "inputs": [],
//       "name": "OnlySafe",
//       "type": "error"
//     },
//     {
//       "anonymous": false,
//       "inputs": [
//         {
//           "indexed": true,
//           "internalType": "string",
//           "name": "key",
//           "type": "string"
//         }
//       ],
//       "name": "RecordDeleted",
//       "type": "event"
//     },
//     {
//       "anonymous": false,
//       "inputs": [
//         {
//           "indexed": true,
//           "internalType": "string",
//           "name": "key",
//           "type": "string"
//         },
//         {
//           "indexed": false,
//           "internalType": "string",
//           "name": "value",
//           "type": "string"
//         }
//       ],
//       "name": "RecordSet",
//       "type": "event"
//     },
//     {
//       "anonymous": false,
//       "inputs": [
//         {
//           "indexed": false,
//           "internalType": "string[]",
//           "name": "keys",
//           "type": "string[]"
//         },
//         {
//           "indexed": false,
//           "internalType": "string[]",
//           "name": "values",
//           "type": "string[]"
//         }
//       ],
//       "name": "RecordsSetBatch",
//       "type": "event"
//     },
//     {
//       "inputs": [],
//       "name": "NAME",
//       "outputs": [
//         {
//           "internalType": "string",
//           "name": "",
//           "type": "string"
//         }
//       ],
//       "stateMutability": "view",
//       "type": "function"
//     },
//     {
//       "inputs": [],
//       "name": "VERSION",
//       "outputs": [
//         {
//           "internalType": "string",
//           "name": "",
//           "type": "string"
//         }
//       ],
//       "stateMutability": "view",
//       "type": "function"
//     },
//     {
//       "inputs": [
//         {
//           "internalType": "string",
//           "name": "key",
//           "type": "string"
//         }
//       ],
//       "name": "deleteRecord",
//       "outputs": [],
//       "stateMutability": "nonpayable",
//       "type": "function"
//     },
//     {
//       "inputs": [],
//       "name": "getAllKeys",
//       "outputs": [
//         {
//           "internalType": "string[]",
//           "name": "",
//           "type": "string[]"
//         }
//       ],
//       "stateMutability": "view",
//       "type": "function"
//     },
//     {
//       "inputs": [],
//       "name": "getAllRecords",
//       "outputs": [
//         {
//           "internalType": "string[]",
//           "name": "keys",
//           "type": "string[]"
//         },
//         {
//           "internalType": "string[]",
//           "name": "values",
//           "type": "string[]"
//         }
//       ],
//       "stateMutability": "view",
//       "type": "function"
//     },
//     {
//       "inputs": [
//         {
//           "internalType": "uint256",
//           "name": "index",
//           "type": "uint256"
//         }
//       ],
//       "name": "getKeyAtIndex",
//       "outputs": [
//         {
//           "internalType": "string",
//           "name": "",
//           "type": "string"
//         }
//       ],
//       "stateMutability": "view",
//       "type": "function"
//     },
//     {
//       "inputs": [
//         {
//           "internalType": "string",
//           "name": "key",
//           "type": "string"
//         }
//       ],
//       "name": "getRecord",
//       "outputs": [
//         {
//           "internalType": "string",
//           "name": "value",
//           "type": "string"
//         }
//       ],
//       "stateMutability": "view",
//       "type": "function"
//     },
//     {
//       "inputs": [],
//       "name": "getRecordCount",
//       "outputs": [
//         {
//           "internalType": "uint256",
//           "name": "",
//           "type": "uint256"
//         }
//       ],
//       "stateMutability": "view",
//       "type": "function"
//     },
//     {
//       "inputs": [
//         {
//           "internalType": "string[]",
//           "name": "keys",
//           "type": "string[]"
//         }
//       ],
//       "name": "getRecords",
//       "outputs": [
//         {
//           "internalType": "string[]",
//           "name": "values",
//           "type": "string[]"
//         }
//       ],
//       "stateMutability": "view",
//       "type": "function"
//     },
//     {
//       "inputs": [
//         {
//           "internalType": "string",
//           "name": "key",
//           "type": "string"
//         }
//       ],
//       "name": "recordExists",
//       "outputs": [
//         {
//           "internalType": "bool",
//           "name": "exists",
//           "type": "bool"
//         }
//       ],
//       "stateMutability": "view",
//       "type": "function"
//     },
//     {
//       "inputs": [],
//       "name": "safe",
//       "outputs": [
//         {
//           "internalType": "address",
//           "name": "",
//           "type": "address"
//         }
//       ],
//       "stateMutability": "view",
//       "type": "function"
//     },
//     {
//       "inputs": [
//         {
//           "internalType": "string",
//           "name": "key",
//           "type": "string"
//         },
//         {
//           "internalType": "string",
//           "name": "value",
//           "type": "string"
//         }
//       ],
//       "name": "setRecord",
//       "outputs": [],
//       "stateMutability": "nonpayable",
//       "type": "function"
//     },
//     {
//       "inputs": [
//         {
//           "internalType": "string[]",
//           "name": "keys",
//           "type": "string[]"
//         },
//         {
//           "internalType": "string[]",
//           "name": "values",
//           "type": "string[]"
//         }
//       ],
//       "name": "setRecords",
//       "outputs": [],
//       "stateMutability": "nonpayable",
//       "type": "function"
//     },
//     {
//       "inputs": [
//         {
//           "internalType": "bytes4",
//           "name": "interfaceId",
//           "type": "bytes4"
//         }
//       ],
//       "name": "supportsInterface",
//       "outputs": [
//         {
//           "internalType": "bool",
//           "name": "",
//           "type": "bool"
//         }
//       ],
//       "stateMutability": "pure",
//       "type": "function"
//     }
//   ]

//   export const l2RecordsAbi = [{"inputs":[{"internalType":"address","name":"initialOwner","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"node","type":"bytes32"},{"indexed":false,"internalType":"address","name":"newAddress","type":"address"}],"name":"AddressChanged","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"caller","type":"address"},{"indexed":false,"internalType":"bool","name":"authorized","type":"bool"}],"name":"CallerAuthorized","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"previousOwner","type":"address"},{"indexed":true,"internalType":"address","name":"newOwner","type":"address"}],"name":"OwnershipTransferred","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"newProtocolAddress","type":"address"}],"name":"ProtocolAddressChanged","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"node","type":"bytes32"},{"indexed":true,"internalType":"string","name":"key","type":"string"},{"indexed":false,"internalType":"string","name":"value","type":"string"}],"name":"TextChanged","type":"event"},{"inputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"name":"addresses","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"caller","type":"address"},{"internalType":"bool","name":"authorized","type":"bool"}],"name":"authorizeCaller","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"authorizedCallers","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32[]","name":"nodes","type":"bytes32[]"},{"internalType":"address[]","name":"addrs","type":"address[]"},{"internalType":"string[][]","name":"keys","type":"string[][]"},{"internalType":"string[][]","name":"values","type":"string[][]"}],"name":"batchSetRecords","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32[]","name":"nodes","type":"bytes32[]"},{"internalType":"string[]","name":"commonKeys","type":"string[]"}],"name":"exportState","outputs":[{"components":[{"internalType":"bytes32","name":"node","type":"bytes32"},{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"addr","type":"address"},{"internalType":"string[]","name":"keys","type":"string[]"},{"internalType":"string[]","name":"values","type":"string[]"}],"internalType":"struct ENSSubdomainRecordsContract.NodeData[]","name":"nodeData","type":"tuple[]"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"}],"name":"getAddress","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"},{"internalType":"string[]","name":"keys","type":"string[]"}],"name":"getRecords","outputs":[{"internalType":"address","name":"addr","type":"address"},{"internalType":"string[]","name":"values","type":"string[]"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"},{"internalType":"string","name":"key","type":"string"}],"name":"getText","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"},{"internalType":"string[]","name":"keysToCheck","type":"string[]"}],"name":"getTextRecordKeys","outputs":[{"internalType":"string[]","name":"existingKeys","type":"string[]"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"}],"name":"hasRecords","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"protocolAddress","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"renounceOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"},{"internalType":"address","name":"addr","type":"address"}],"name":"setAddress","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"newProtocolAddress","type":"address"}],"name":"setProtocolAddress","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"},{"internalType":"string","name":"key","type":"string"},{"internalType":"string","name":"value","type":"string"}],"name":"setText","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"","type":"bytes32"},{"internalType":"string","name":"","type":"string"}],"name":"textRecords","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"newOwner","type":"address"}],"name":"transferOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"}]