export const safeAbi = [
	{
		inputs: [
			{
				name: "owner",
				type: "address",
			},
		],
		name: "isOwner",
		outputs: [
			{
				name: "",
				type: "bool",
			},
		],
		stateMutability: "view",
		type: "function",
	},
];

export const publicationAbi = [
	{
		inputs: [],
		stateMutability: "nonpayable",
		type: "constructor",
	},
	{
		inputs: [],
		name: "ExecutionFailed",
		type: "error",
	},
	{
		inputs: [],
		name: "InvalidAuthorAddress",
		type: "error",
	},
	{
		inputs: [],
		name: "InvalidOwnerAddress",
		type: "error",
	},
	{
		inputs: [],
		name: "InvalidOwnerCount",
		type: "error",
	},
	{
		inputs: [],
		name: "InvalidPrinterAddress",
		type: "error",
	},
	{
		inputs: [],
		name: "InvalidThresholdCount",
		type: "error",
	},
	{
		inputs: [],
		name: "MaxAuthorsReached",
		type: "error",
	},
	{
		inputs: [],
		name: "MaxOwnersReached",
		type: "error",
	},
	{
		inputs: [],
		name: "NotAnOwner",
		type: "error",
	},
	{
		inputs: [],
		name: "NotAuthorizedToUpgrade",
		type: "error",
	},
	{
		inputs: [],
		name: "NotPrinter",
		type: "error",
	},
	{
		inputs: [],
		name: "UnauthorizedCall",
		type: "error",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: "address",
				name: "previousAdmin",
				type: "address",
			},
			{
				indexed: false,
				internalType: "address",
				name: "newAdmin",
				type: "address",
			},
		],
		name: "AdminChanged",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "beacon",
				type: "address",
			},
		],
		name: "BeaconUpgraded",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "implementation",
				type: "address",
			},
		],
		name: "ContractUpgraded",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "triggeredBy",
				type: "address",
			},
		],
		name: "EmergencyRecovery",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "triggeredBy",
				type: "address",
			},
		],
		name: "EmergencyShutdown",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: "uint8",
				name: "version",
				type: "uint8",
			},
		],
		name: "Initialized",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: "string",
				name: "config",
				type: "string",
			},
		],
		name: "NConfigUpdate",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "author",
				type: "address",
			},
			{
				indexed: true,
				internalType: "address",
				name: "publication",
				type: "address",
			},
			{
				indexed: true,
				internalType: "string",
				name: "stream_id",
				type: "string",
			},
		],
		name: "NDeal",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "author",
				type: "address",
			},
			{
				indexed: true,
				internalType: "address",
				name: "publication",
				type: "address",
			},
			{
				indexed: true,
				internalType: "string",
				name: "stream_id",
				type: "string",
			},
		],
		name: "NDealOffered",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "revoker",
				type: "address",
			},
			{
				indexed: true,
				internalType: "string",
				name: "stream_id",
				type: "string",
			},
		],
		name: "NDealRevoked",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: "string",
				name: "html_root",
				type: "string",
			},
			{
				indexed: false,
				internalType: "address",
				name: "sender",
				type: "address",
			},
			{
				indexed: false,
				internalType: "address",
				name: "pkpAddress",
				type: "address",
			},
		],
		name: "NRootUpdate",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: "string",
				name: "html_root",
				type: "string",
			},
			{
				indexed: false,
				internalType: "address",
				name: "sender",
				type: "address",
			},
			{
				indexed: false,
				internalType: "address",
				name: "pkpAddress",
				type: "address",
			},
		],
		name: "NRootUpdateDev",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "owner",
				type: "address",
			},
		],
		name: "OwnerAdded",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "owner",
				type: "address",
			},
		],
		name: "OwnerRemoved",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "previousOwner",
				type: "address",
			},
			{
				indexed: true,
				internalType: "address",
				name: "newOwner",
				type: "address",
			},
		],
		name: "OwnershipTransferred",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: "address",
				name: "account",
				type: "address",
			},
		],
		name: "Paused",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: "address",
				name: "account",
				type: "address",
			},
		],
		name: "Unpaused",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "implementation",
				type: "address",
			},
		],
		name: "Upgraded",
		type: "event",
	},
	{
		inputs: [],
		name: "MAX_OWNERS",
		outputs: [
			{
				internalType: "uint256",
				name: "",
				type: "uint256",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "MAX_WHITELISTED_AUTHORS",
		outputs: [
			{
				internalType: "uint256",
				name: "",
				type: "uint256",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "string",
				name: "stream_id",
				type: "string",
			},
		],
		name: "acceptDeal",
		outputs: [
			{
				internalType: "bool",
				name: "",
				type: "bool",
			},
		],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "_author",
				type: "address",
			},
		],
		name: "canPublish",
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
		name: "emergencyPause",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [],
		name: "emergencyUnpause",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [],
		name: "getAuthors",
		outputs: [
			{
				internalType: "address[]",
				name: "",
				type: "address[]",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "getCommit",
		outputs: [
			{
				internalType: "string",
				name: "",
				type: "string",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "getConfig",
		outputs: [
			{
				internalType: "string",
				name: "",
				type: "string",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "getDevRepo",
		outputs: [
			{
				internalType: "string",
				name: "",
				type: "string",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "getHtmlRoot",
		outputs: [
			{
				internalType: "string",
				name: "",
				type: "string",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "getOwners",
		outputs: [
			{
				internalType: "address[]",
				name: "",
				type: "address[]",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "string",
				name: "stream_id",
				type: "string",
			},
		],
		name: "hasDeal",
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
				internalType: "string[]",
				name: "stream_ids",
				type: "string[]",
			},
		],
		name: "hasDealBatch",
		outputs: [
			{
				internalType: "bool[]",
				name: "results",
				type: "bool[]",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "html_root",
		outputs: [
			{
				internalType: "string",
				name: "",
				type: "string",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "initUpdate",
		outputs: [
			{
				internalType: "string",
				name: "",
				type: "string",
			},
		],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "_pkp",
				type: "address",
			},
			{
				internalType: "address[]",
				name: "_owners",
				type: "address[]",
			},
			{
				internalType: "address[]",
				name: "_authors",
				type: "address[]",
			},
			{
				internalType: "uint256",
				name: "_threshold",
				type: "uint256",
			},
			{
				internalType: "string",
				name: "_config",
				type: "string",
			},
			{
				internalType: "string",
				name: "_html_root",
				type: "string",
			},
			{
				internalType: "string",
				name: "_dev_repository",
				type: "string",
			},
			{
				internalType: "string",
				name: "_commit",
				type: "string",
			},
		],
		name: "initialize",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "account",
				type: "address",
			},
		],
		name: "isAuthor",
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
				internalType: "address",
				name: "account",
				type: "address",
			},
		],
		name: "isOwner",
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
				internalType: "address",
				name: "publication",
				type: "address",
			},
			{
				internalType: "string",
				name: "stream_id",
				type: "string",
			},
		],
		name: "offerDeal",
		outputs: [
			{
				internalType: "bool",
				name: "",
				type: "bool",
			},
		],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [],
		name: "owner",
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
		name: "paused",
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
		name: "protocol_address",
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
		name: "proxiableUUID",
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
		name: "renounceOwnership",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "string",
				name: "stream_id",
				type: "string",
			},
		],
		name: "revokeDeal",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "string",
				name: "_commit",
				type: "string",
			},
		],
		name: "setCommit",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "string",
				name: "_dev_repo",
				type: "string",
			},
		],
		name: "setDevRepo",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "newOwner",
				type: "address",
			},
		],
		name: "transferOwnership",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "string",
				name: "_config",
				type: "string",
			},
		],
		name: "updateConfig",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "string",
				name: "_html_root",
				type: "string",
			},
		],
		name: "updateHtmlRoot",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "_pkp",
				type: "address",
			},
		],
		name: "updatePkp",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "newImplementation",
				type: "address",
			},
		],
		name: "upgradeTo",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "newImplementation",
				type: "address",
			},
			{
				internalType: "bytes",
				name: "data",
				type: "bytes",
			},
		],
		name: "upgradeToAndCall",
		outputs: [],
		stateMutability: "payable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "_author",
				type: "address",
			},
		],
		name: "whitelistAuthor",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
];
