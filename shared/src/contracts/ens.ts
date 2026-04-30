export const registrarABI = [
	{
		inputs: [
			{ internalType: "string", name: "label", type: "string" },
			{ internalType: "address", name: "owner", type: "address" },
		],
		name: "register",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [],
		name: "nameWrapper",
		outputs: [
			{
				internalType: "contract INameWrapper",
				name: "",
				type: "address",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [{ internalType: "string", name: "label", type: "string" }],
		name: "isRegistered",
		outputs: [{ internalType: "bool", name: "", type: "bool" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "parentNode",
		outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
		stateMutability: "view",
		type: "function",
	},
];

export const nameWrapperABI = [
	{
		inputs: [
			{ internalType: "bytes32", name: "node", type: "bytes32" },
			{ internalType: "address", name: "owner", type: "address" },
			{ internalType: "address", name: "resolver", type: "address" },
			{ internalType: "uint64", name: "ttl", type: "uint64" },
		],
		name: "setRecord",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
];

export const resolverABI = [
	{
		inputs: [
			{ internalType: "bytes32", name: "node", type: "bytes32" },
			{ internalType: "address", name: "addr", type: "address" },
		],
		name: "setAddr",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{ internalType: "bytes32", name: "node", type: "bytes32" },
			{ internalType: "string", name: "key", type: "string" },
		],
		name: "text",
		outputs: [{ internalType: "string", name: "", type: "string" }],
		stateMutability: "view",
		type: "function",
	},
	{
		constant: false,
		inputs: [
			{ name: "node", type: "bytes32" },
			{ name: "key", type: "string" },
			{ name: "value", type: "string" },
		],
		name: "setText",
		outputs: [],
		payable: false,
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "bytes[]",
				name: "data",
				type: "bytes[]",
			},
		],
		name: "multicall",
		outputs: [
			{
				internalType: "bytes[]",
				name: "results",
				type: "bytes[]",
			},
		],
		stateMutability: "nonpayable",
		type: "function",
	},
];

export const ensRegistryABI = [
	{
		inputs: [{ internalType: "bytes32", name: "node", type: "bytes32" }],
		name: "resolver",
		outputs: [{ internalType: "address", name: "", type: "address" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [{ internalType: "string", name: "name", type: "string" }],
		name: "recordExists",
		outputs: [{ internalType: "bool", name: "", type: "bool" }],
		stateMutability: "view",
		type: "function",
	},
];

export const ensSubdomainRegistryAbi = [
	{
		inputs: [
			{
				internalType: "address",
				name: "_ens",
				type: "address",
			},
			{
				internalType: "bytes32",
				name: "_parentNode",
				type: "bytes32",
			},
			{
				internalType: "address",
				name: "_defaultResolver",
				type: "address",
			},
			{
				internalType: "address",
				name: "recoverAddress",
				type: "address",
			},
			{
				internalType: "address",
				name: "_nameWrapper",
				type: "address",
			},
		],
		stateMutability: "nonpayable",
		type: "constructor",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "newOwner",
				type: "address",
			},
		],
		name: "ParentDomainOwnershipReturned",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "string",
				name: "subdomain",
				type: "string",
			},
			{
				indexed: true,
				internalType: "address",
				name: "owner",
				type: "address",
			},
		],
		name: "SubdomainRegistered",
		type: "event",
	},
	{
		inputs: [],
		name: "defaultResolver",
		outputs: [
			{
				internalType: "address",
				name: "",
				type: "address",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "ens",
		outputs: [
			{
				internalType: "contract IENS",
				name: "",
				type: "address",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "isParentWrapped",
		outputs: [
			{
				internalType: "bool",
				name: "",
				type: "bool",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "string",
				name: "subdomain",
				type: "string",
			},
		],
		name: "isSubdomainAvailable",
		outputs: [
			{
				internalType: "bool",
				name: "",
				type: "bool",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "nameWrapper",
		outputs: [
			{
				internalType: "contract INameWrapper",
				name: "",
				type: "address",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "",
				type: "address",
			},
			{
				internalType: "address",
				name: "",
				type: "address",
			},
			{
				internalType: "uint256[]",
				name: "",
				type: "uint256[]",
			},
			{
				internalType: "uint256[]",
				name: "",
				type: "uint256[]",
			},
			{
				internalType: "bytes",
				name: "",
				type: "bytes",
			},
		],
		name: "onERC1155BatchReceived",
		outputs: [
			{
				internalType: "bytes4",
				name: "",
				type: "bytes4",
			},
		],
		stateMutability: "pure",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "",
				type: "address",
			},
			{
				internalType: "address",
				name: "",
				type: "address",
			},
			{
				internalType: "uint256",
				name: "",
				type: "uint256",
			},
			{
				internalType: "uint256",
				name: "",
				type: "uint256",
			},
			{
				internalType: "bytes",
				name: "",
				type: "bytes",
			},
		],
		name: "onERC1155Received",
		outputs: [
			{
				internalType: "bytes4",
				name: "",
				type: "bytes4",
			},
		],
		stateMutability: "pure",
		type: "function",
	},
	{
		inputs: [],
		name: "parentDomainOwner",
		outputs: [
			{
				internalType: "address",
				name: "",
				type: "address",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "parentNode",
		outputs: [
			{
				internalType: "bytes32",
				name: "",
				type: "bytes32",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "reclaimParentDomain",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "string",
				name: "subdomain",
				type: "string",
			},
			{
				internalType: "address",
				name: "subdomainOwner",
				type: "address",
			},
		],
		name: "registerSubdomain",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "string",
				name: "subdomain",
				type: "string",
			},
		],
		name: "registerSubdomainSimple",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "string",
				name: "",
				type: "string",
			},
		],
		name: "registeredSubdomains",
		outputs: [
			{
				internalType: "bool",
				name: "",
				type: "bool",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "bytes4",
				name: "interfaceId",
				type: "bytes4",
			},
		],
		name: "supportsInterface",
		outputs: [
			{
				internalType: "bool",
				name: "",
				type: "bool",
			},
		],
		stateMutability: "view",
		type: "function",
	},
];

export const ensRecordsAbi = [{"inputs":[{"internalType":"address","name":"initialOwner","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"node","type":"bytes32"},{"indexed":false,"internalType":"address","name":"newAddress","type":"address"}],"name":"AddressChanged","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"caller","type":"address"},{"indexed":false,"internalType":"bool","name":"authorized","type":"bool"}],"name":"CallerAuthorized","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"previousOwner","type":"address"},{"indexed":true,"internalType":"address","name":"newOwner","type":"address"}],"name":"OwnershipTransferred","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"newProtocolAddress","type":"address"}],"name":"ProtocolAddressChanged","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"node","type":"bytes32"},{"indexed":true,"internalType":"string","name":"key","type":"string"},{"indexed":false,"internalType":"string","name":"value","type":"string"}],"name":"TextChanged","type":"event"},{"inputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"name":"addresses","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"caller","type":"address"},{"internalType":"bool","name":"authorized","type":"bool"}],"name":"authorizeCaller","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"authorizedCallers","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32[]","name":"nodes","type":"bytes32[]"},{"internalType":"address[]","name":"addrs","type":"address[]"},{"internalType":"string[][]","name":"keys","type":"string[][]"},{"internalType":"string[][]","name":"values","type":"string[][]"}],"name":"batchSetRecords","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32[]","name":"nodes","type":"bytes32[]"},{"internalType":"string[]","name":"commonKeys","type":"string[]"}],"name":"exportState","outputs":[{"components":[{"internalType":"bytes32","name":"node","type":"bytes32"},{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"addr","type":"address"},{"internalType":"string[]","name":"keys","type":"string[]"},{"internalType":"string[]","name":"values","type":"string[]"}],"internalType":"struct ENSSubdomainRecordsContract.NodeData[]","name":"nodeData","type":"tuple[]"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"}],"name":"getAddress","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"},{"internalType":"string[]","name":"keys","type":"string[]"}],"name":"getRecords","outputs":[{"internalType":"address","name":"addr","type":"address"},{"internalType":"string[]","name":"values","type":"string[]"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"},{"internalType":"string","name":"key","type":"string"}],"name":"getText","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"},{"internalType":"string[]","name":"keysToCheck","type":"string[]"}],"name":"getTextRecordKeys","outputs":[{"internalType":"string[]","name":"existingKeys","type":"string[]"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"}],"name":"hasRecords","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"protocolAddress","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"renounceOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"},{"internalType":"address","name":"addr","type":"address"}],"name":"setAddress","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"newProtocolAddress","type":"address"}],"name":"setProtocolAddress","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"},{"internalType":"string","name":"key","type":"string"},{"internalType":"string","name":"value","type":"string"}],"name":"setText","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"","type":"bytes32"},{"internalType":"string","name":"","type":"string"}],"name":"textRecords","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"newOwner","type":"address"}],"name":"transferOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"}]