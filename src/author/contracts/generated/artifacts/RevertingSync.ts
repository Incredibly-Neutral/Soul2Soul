export const Artifact_RevertingSync: {
  "contractName": "RevertingSync",
  "sourceName": "test/MockSafe.sol",
  "abi": [
    {
      "inputs": [],
      "name": "Broken",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "sync",
      "outputs": [
        {
          "internalType": "bool",
          "name": "",
          "type": "bool"
        }
      ],
      "stateMutability": "pure",
      "type": "function"
    }
  ],
  "bytecode": "0x60808060405234601457607a90816100198239f35b5f80fdfe60808060405260043610156011575f80fd5b5f3560e01c63fff6cae9146023575f80fd5b346040575f366003190112604057630270c61d60e31b8152600490fd5b5f80fdfea26469706673582212209283da4d49654fd338034158198c7636ed20f50941ea9e8eff78923744d3013764736f6c63430008180033",
  "deployedBytecode": "0x60808060405260043610156011575f80fd5b5f3560e01c63fff6cae9146023575f80fd5b346040575f366003190112604057630270c61d60e31b8152600490fd5b5f80fdfea26469706673582212209283da4d49654fd338034158198c7636ed20f50941ea9e8eff78923744d3013764736f6c63430008180033",
  "linkReferences": {},
  "deployedLinkReferences": {},
  "immutableReferences": {},
  "inputSourceName": "project/test/MockSafe.sol",
  "devdoc": {
    "kind": "dev",
    "methods": {},
    "title": "RevertingSync",
    "version": 1
  },
  "evm": {
    "bytecode": {
      "linkReferences": {},
      "object": "60808060405234601457607a90816100198239f35b5f80fdfe60808060405260043610156011575f80fd5b5f3560e01c63fff6cae9146023575f80fd5b346040575f366003190112604057630270c61d60e31b8152600490fd5b5f80fdfea26469706673582212209283da4d49654fd338034158198c7636ed20f50941ea9e8eff78923744d3013764736f6c63430008180033",
      "opcodes": "PUSH1 0x80 DUP1 PUSH1 0x40 MSTORE CALLVALUE PUSH1 0x14 JUMPI PUSH1 0x7A SWAP1 DUP2 PUSH2 0x19 DUP3 CODECOPY RETURN JUMPDEST PUSH0 DUP1 REVERT INVALID PUSH1 0x80 DUP1 PUSH1 0x40 MSTORE PUSH1 0x4 CALLDATASIZE LT ISZERO PUSH1 0x11 JUMPI PUSH0 DUP1 REVERT JUMPDEST PUSH0 CALLDATALOAD PUSH1 0xE0 SHR PUSH4 0xFFF6CAE9 EQ PUSH1 0x23 JUMPI PUSH0 DUP1 REVERT JUMPDEST CALLVALUE PUSH1 0x40 JUMPI PUSH0 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH1 0x40 JUMPI PUSH4 0x270C61D PUSH1 0xE3 SHL DUP2 MSTORE PUSH1 0x4 SWAP1 REVERT JUMPDEST PUSH0 DUP1 REVERT INVALID LOG2 PUSH5 0x6970667358 0x22 SLT KECCAK256 SWAP3 DUP4 0xDA 0x4D BLOBHASH PUSH6 0x4FD338034158 NOT DUP13 PUSH23 0x36ED20F50941EA9E8EFF78923744D3013764736F6C6343 STOP ADDMOD XOR STOP CALLER ",
      "sourceMap": "5951:129:21:-:0;;;;;;;;;;;;;;;;;"
    },
    "deployedBytecode": {
      "immutableReferences": {},
      "linkReferences": {},
      "object": "60808060405260043610156011575f80fd5b5f3560e01c63fff6cae9146023575f80fd5b346040575f366003190112604057630270c61d60e31b8152600490fd5b5f80fdfea26469706673582212209283da4d49654fd338034158198c7636ed20f50941ea9e8eff78923744d3013764736f6c63430008180033",
      "opcodes": "PUSH1 0x80 DUP1 PUSH1 0x40 MSTORE PUSH1 0x4 CALLDATASIZE LT ISZERO PUSH1 0x11 JUMPI PUSH0 DUP1 REVERT JUMPDEST PUSH0 CALLDATALOAD PUSH1 0xE0 SHR PUSH4 0xFFF6CAE9 EQ PUSH1 0x23 JUMPI PUSH0 DUP1 REVERT JUMPDEST CALLVALUE PUSH1 0x40 JUMPI PUSH0 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH1 0x40 JUMPI PUSH4 0x270C61D PUSH1 0xE3 SHL DUP2 MSTORE PUSH1 0x4 SWAP1 REVERT JUMPDEST PUSH0 DUP1 REVERT INVALID LOG2 PUSH5 0x6970667358 0x22 SLT KECCAK256 SWAP3 DUP4 0xDA 0x4D BLOBHASH PUSH6 0x4FD338034158 NOT DUP13 PUSH23 0x36ED20F50941EA9E8EFF78923744D3013764736F6C6343 STOP ADDMOD XOR STOP CALLER ",
      "sourceMap": "5951:129:21:-:0;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;-1:-1:-1;;5951:129:21;;;;-1:-1:-1;;;6063:8:21;;5951:129;;6063:8;5951:129;;;"
    },
    "gasEstimates": {
      "creation": {
        "codeDepositCost": "24400",
        "executionCost": "81",
        "totalCost": "24481"
      },
      "external": {
        "sync()": "148"
      }
    },
    "methodIdentifiers": {
      "sync()": "fff6cae9"
    }
  },
  "metadata": "{\"compiler\":{\"version\":\"0.8.24+commit.e11b9ed9\"},\"language\":\"Solidity\",\"output\":{\"abi\":[{\"inputs\":[],\"name\":\"Broken\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"sync\",\"outputs\":[{\"internalType\":\"bool\",\"name\":\"\",\"type\":\"bool\"}],\"stateMutability\":\"pure\",\"type\":\"function\"}],\"devdoc\":{\"kind\":\"dev\",\"methods\":{},\"title\":\"RevertingSync\",\"version\":1},\"userdoc\":{\"kind\":\"user\",\"methods\":{},\"notice\":\"A module stand-in whose `sync()` reverts, for the guard's catch.\",\"version\":1}},\"settings\":{\"compilationTarget\":{\"project/test/MockSafe.sol\":\"RevertingSync\"},\"evmVersion\":\"shanghai\",\"libraries\":{},\"metadata\":{\"bytecodeHash\":\"ipfs\",\"useLiteralContent\":true},\"optimizer\":{\"enabled\":true,\"runs\":200},\"remappings\":[\"project/:@openzeppelin/contracts-upgradeable/=npm/@openzeppelin/contracts-upgradeable@4.9.6/\",\"project/:@openzeppelin/contracts/=npm/@openzeppelin/contracts@4.9.6/\"],\"viaIR\":true},\"sources\":{\"project/test/MockSafe.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\npragma solidity ^0.8.19;\\n\\n/**\\n * @title MockSafe\\n * @notice Just enough of Safe 1.4.1's owner surface to exercise\\n *         OwnerHistoryModuleV1 and OwnerHistoryGuard: `getOwners`, `isOwner`,\\n *         `guard` / `setGuard`, and an `execOwnerChange` entry point that\\n *         reproduces the two calls a real Safe makes around an `onlySelf`\\n *         owner mutation \\u2014 `checkTransaction` before, `checkAfterExecution`\\n *         after \\u2014 with the same ABI (the enum operation is `uint8` on the wire).\\n *\\n * Deliberately NOT the Safe package: the point of this suite is the hook and\\n * the index, and the module only ever needs `getOwners()`/`isOwner()` from the\\n * Safe. Everything else a real Safe does (thresholds, signatures, nonce) is\\n * orthogonal to what is under test here.\\n */\\ncontract MockSafe {\\n\\n    address[] private _owners;\\n    mapping(address who => bool) private _isOwner;\\n\\n    /// @notice The installed transaction guard; zero = none.\\n    address public guard;\\n\\n    event AddedOwner(address indexed owner);\\n    event RemovedOwner(address indexed owner);\\n    event GuardChanged(address indexed guard);\\n\\n    error AlreadyOwner(address who);\\n    error NotOwner(address who);\\n    error LastOwner();\\n    error UnknownChange(uint8 kind);\\n\\n    constructor(address[] memory initialOwners) {\\n        for (uint256 i = 0; i < initialOwners.length; i++) {\\n            _owners.push(initialOwners[i]);\\n            _isOwner[initialOwners[i]] = true;\\n        }\\n    }\\n\\n    // \\u2500\\u2500 The module's whole view of the Safe \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n\\n    function getOwners() external view returns (address[] memory) {\\n        return _owners;\\n    }\\n\\n    function isOwner(address who) external view returns (bool) {\\n        return _isOwner[who];\\n    }\\n\\n    function ownerCount() external view returns (uint256) {\\n        return _owners.length;\\n    }\\n\\n    // \\u2500\\u2500 Guard plumbing (on a real Safe this is `onlySelf`) \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n\\n    function setGuard(address newGuard) external {\\n        guard = newGuard;\\n        emit GuardChanged(newGuard);\\n    }\\n\\n    /**\\n     * @dev One `onlySelf` owner mutation, wired the way Safe 1.4.1 wires it:\\n     *      the guard is read once, `checkTransaction` runs before the mutation,\\n     *      `checkAfterExecution(txHash, true)` after it. `kind`: 0 = add(a),\\n     *      1 = remove(a), 2 = swap(a \\u2192 b).\\n     */\\n    function execOwnerChange(uint8 kind, address a, address b) external {\\n        address g = guard;\\n        if (g != address(0)) {\\n            IGuard(g).checkTransaction(\\n                address(this),\\n                0,\\n                \\\"\\\",\\n                0,\\n                0,\\n                0,\\n                0,\\n                address(0),\\n                payable(address(0)),\\n                \\\"\\\",\\n                msg.sender\\n            );\\n        }\\n\\n        if (kind == 0) {\\n            _addOwner(a);\\n        } else if (kind == 1) {\\n            _removeOwner(a);\\n        } else if (kind == 2) {\\n            _swapOwner(a, b);\\n        } else {\\n            revert UnknownChange(kind);\\n        }\\n\\n        if (g != address(0)) {\\n            IGuard(g).checkAfterExecution(bytes32(0), true);\\n        }\\n    }\\n\\n    /// @dev Execute an arbitrary call as the Safe \\u2014 the `execTransaction`\\n    ///      shape minus signatures, which is how a real Safe upgrades its own\\n    ///      module or calls an `onlySelf` target.\\n    function execCall(address target, bytes calldata data) external payable returns (bytes memory) {\\n        (bool ok, bytes memory ret) = target.call(data);\\n        if (!ok) {\\n            assembly {\\n                revert(add(ret, 32), mload(ret))\\n            }\\n        }\\n        return ret;\\n    }\\n\\n    /// @dev Call the guard's post-execution hook as the Safe, without an owner\\n    ///      change. Used to prove the sender gate and the catch.\\n    function pokeGuard(bytes32 txHash, bool success) external {\\n        address g = guard;\\n        if (g != address(0)) IGuard(g).checkAfterExecution(txHash, success);\\n    }\\n\\n    // \\u2500\\u2500 Mutation \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n\\n    function _addOwner(address a) private {\\n        if (_isOwner[a]) revert AlreadyOwner(a);\\n        _isOwner[a] = true;\\n        _owners.push(a);\\n        emit AddedOwner(a);\\n    }\\n\\n    function _removeOwner(address a) private {\\n        if (!_isOwner[a]) revert NotOwner(a);\\n        if (_owners.length == 1) revert LastOwner();\\n        _isOwner[a] = false;\\n        for (uint256 i = 0; i < _owners.length; i++) {\\n            if (_owners[i] == a) {\\n                _owners[i] = _owners[_owners.length - 1];\\n                _owners.pop();\\n                break;\\n            }\\n        }\\n        emit RemovedOwner(a);\\n    }\\n\\n    function _swapOwner(address oldOwner, address newOwner) private {\\n        if (!_isOwner[oldOwner]) revert NotOwner(oldOwner);\\n        if (_isOwner[newOwner]) revert AlreadyOwner(newOwner);\\n        _isOwner[oldOwner] = false;\\n        _isOwner[newOwner] = true;\\n        for (uint256 i = 0; i < _owners.length; i++) {\\n            if (_owners[i] == oldOwner) {\\n                _owners[i] = newOwner;\\n                break;\\n            }\\n        }\\n        emit RemovedOwner(oldOwner);\\n        emit AddedOwner(newOwner);\\n    }\\n}\\n\\ninterface IGuard {\\n    function checkTransaction(\\n        address to,\\n        uint256 value,\\n        bytes memory data,\\n        uint8 operation,\\n        uint256 safeTxGas,\\n        uint256 baseGas,\\n        uint256 gasPrice,\\n        address gasToken,\\n        address payable refundReceiver,\\n        bytes memory signatures,\\n        address msgSender\\n    ) external;\\n\\n    function checkAfterExecution(bytes32 txHash, bool success) external;\\n}\\n\\n/**\\n * @title RevertingSync\\n * @notice A module stand-in whose `sync()` reverts, for the guard's catch.\\n */\\ncontract RevertingSync {\\n    error Broken();\\n\\n    function sync() external pure returns (bool) {\\n        revert Broken();\\n    }\\n}\\n\",\"keccak256\":\"0xce9c36ddf6752a7b85942e7a9af452f51bc7785508e57c6c8a05f338303392f3\",\"license\":\"MIT\"}},\"version\":1}",
  "storageLayout": {
    "storage": [],
    "types": null
  },
  "userdoc": {
    "kind": "user",
    "methods": {},
    "notice": "A module stand-in whose `sync()` reverts, for the guard's catch.",
    "version": 1
  }
} = {
  "contractName": "RevertingSync",
  "sourceName": "test/MockSafe.sol",
  "abi": [
    {
      "inputs": [],
      "name": "Broken",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "sync",
      "outputs": [
        {
          "internalType": "bool",
          "name": "",
          "type": "bool"
        }
      ],
      "stateMutability": "pure",
      "type": "function"
    }
  ],
  "bytecode": "0x60808060405234601457607a90816100198239f35b5f80fdfe60808060405260043610156011575f80fd5b5f3560e01c63fff6cae9146023575f80fd5b346040575f366003190112604057630270c61d60e31b8152600490fd5b5f80fdfea26469706673582212209283da4d49654fd338034158198c7636ed20f50941ea9e8eff78923744d3013764736f6c63430008180033",
  "deployedBytecode": "0x60808060405260043610156011575f80fd5b5f3560e01c63fff6cae9146023575f80fd5b346040575f366003190112604057630270c61d60e31b8152600490fd5b5f80fdfea26469706673582212209283da4d49654fd338034158198c7636ed20f50941ea9e8eff78923744d3013764736f6c63430008180033",
  "linkReferences": {},
  "deployedLinkReferences": {},
  "immutableReferences": {},
  "inputSourceName": "project/test/MockSafe.sol",
  "devdoc": {
    "kind": "dev",
    "methods": {},
    "title": "RevertingSync",
    "version": 1
  },
  "evm": {
    "bytecode": {
      "linkReferences": {},
      "object": "60808060405234601457607a90816100198239f35b5f80fdfe60808060405260043610156011575f80fd5b5f3560e01c63fff6cae9146023575f80fd5b346040575f366003190112604057630270c61d60e31b8152600490fd5b5f80fdfea26469706673582212209283da4d49654fd338034158198c7636ed20f50941ea9e8eff78923744d3013764736f6c63430008180033",
      "opcodes": "PUSH1 0x80 DUP1 PUSH1 0x40 MSTORE CALLVALUE PUSH1 0x14 JUMPI PUSH1 0x7A SWAP1 DUP2 PUSH2 0x19 DUP3 CODECOPY RETURN JUMPDEST PUSH0 DUP1 REVERT INVALID PUSH1 0x80 DUP1 PUSH1 0x40 MSTORE PUSH1 0x4 CALLDATASIZE LT ISZERO PUSH1 0x11 JUMPI PUSH0 DUP1 REVERT JUMPDEST PUSH0 CALLDATALOAD PUSH1 0xE0 SHR PUSH4 0xFFF6CAE9 EQ PUSH1 0x23 JUMPI PUSH0 DUP1 REVERT JUMPDEST CALLVALUE PUSH1 0x40 JUMPI PUSH0 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH1 0x40 JUMPI PUSH4 0x270C61D PUSH1 0xE3 SHL DUP2 MSTORE PUSH1 0x4 SWAP1 REVERT JUMPDEST PUSH0 DUP1 REVERT INVALID LOG2 PUSH5 0x6970667358 0x22 SLT KECCAK256 SWAP3 DUP4 0xDA 0x4D BLOBHASH PUSH6 0x4FD338034158 NOT DUP13 PUSH23 0x36ED20F50941EA9E8EFF78923744D3013764736F6C6343 STOP ADDMOD XOR STOP CALLER ",
      "sourceMap": "5951:129:21:-:0;;;;;;;;;;;;;;;;;"
    },
    "deployedBytecode": {
      "immutableReferences": {},
      "linkReferences": {},
      "object": "60808060405260043610156011575f80fd5b5f3560e01c63fff6cae9146023575f80fd5b346040575f366003190112604057630270c61d60e31b8152600490fd5b5f80fdfea26469706673582212209283da4d49654fd338034158198c7636ed20f50941ea9e8eff78923744d3013764736f6c63430008180033",
      "opcodes": "PUSH1 0x80 DUP1 PUSH1 0x40 MSTORE PUSH1 0x4 CALLDATASIZE LT ISZERO PUSH1 0x11 JUMPI PUSH0 DUP1 REVERT JUMPDEST PUSH0 CALLDATALOAD PUSH1 0xE0 SHR PUSH4 0xFFF6CAE9 EQ PUSH1 0x23 JUMPI PUSH0 DUP1 REVERT JUMPDEST CALLVALUE PUSH1 0x40 JUMPI PUSH0 CALLDATASIZE PUSH1 0x3 NOT ADD SLT PUSH1 0x40 JUMPI PUSH4 0x270C61D PUSH1 0xE3 SHL DUP2 MSTORE PUSH1 0x4 SWAP1 REVERT JUMPDEST PUSH0 DUP1 REVERT INVALID LOG2 PUSH5 0x6970667358 0x22 SLT KECCAK256 SWAP3 DUP4 0xDA 0x4D BLOBHASH PUSH6 0x4FD338034158 NOT DUP13 PUSH23 0x36ED20F50941EA9E8EFF78923744D3013764736F6C6343 STOP ADDMOD XOR STOP CALLER ",
      "sourceMap": "5951:129:21:-:0;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;-1:-1:-1;;5951:129:21;;;;-1:-1:-1;;;6063:8:21;;5951:129;;6063:8;5951:129;;;"
    },
    "gasEstimates": {
      "creation": {
        "codeDepositCost": "24400",
        "executionCost": "81",
        "totalCost": "24481"
      },
      "external": {
        "sync()": "148"
      }
    },
    "methodIdentifiers": {
      "sync()": "fff6cae9"
    }
  },
  "metadata": "{\"compiler\":{\"version\":\"0.8.24+commit.e11b9ed9\"},\"language\":\"Solidity\",\"output\":{\"abi\":[{\"inputs\":[],\"name\":\"Broken\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"sync\",\"outputs\":[{\"internalType\":\"bool\",\"name\":\"\",\"type\":\"bool\"}],\"stateMutability\":\"pure\",\"type\":\"function\"}],\"devdoc\":{\"kind\":\"dev\",\"methods\":{},\"title\":\"RevertingSync\",\"version\":1},\"userdoc\":{\"kind\":\"user\",\"methods\":{},\"notice\":\"A module stand-in whose `sync()` reverts, for the guard's catch.\",\"version\":1}},\"settings\":{\"compilationTarget\":{\"project/test/MockSafe.sol\":\"RevertingSync\"},\"evmVersion\":\"shanghai\",\"libraries\":{},\"metadata\":{\"bytecodeHash\":\"ipfs\",\"useLiteralContent\":true},\"optimizer\":{\"enabled\":true,\"runs\":200},\"remappings\":[\"project/:@openzeppelin/contracts-upgradeable/=npm/@openzeppelin/contracts-upgradeable@4.9.6/\",\"project/:@openzeppelin/contracts/=npm/@openzeppelin/contracts@4.9.6/\"],\"viaIR\":true},\"sources\":{\"project/test/MockSafe.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\npragma solidity ^0.8.19;\\n\\n/**\\n * @title MockSafe\\n * @notice Just enough of Safe 1.4.1's owner surface to exercise\\n *         OwnerHistoryModuleV1 and OwnerHistoryGuard: `getOwners`, `isOwner`,\\n *         `guard` / `setGuard`, and an `execOwnerChange` entry point that\\n *         reproduces the two calls a real Safe makes around an `onlySelf`\\n *         owner mutation \\u2014 `checkTransaction` before, `checkAfterExecution`\\n *         after \\u2014 with the same ABI (the enum operation is `uint8` on the wire).\\n *\\n * Deliberately NOT the Safe package: the point of this suite is the hook and\\n * the index, and the module only ever needs `getOwners()`/`isOwner()` from the\\n * Safe. Everything else a real Safe does (thresholds, signatures, nonce) is\\n * orthogonal to what is under test here.\\n */\\ncontract MockSafe {\\n\\n    address[] private _owners;\\n    mapping(address who => bool) private _isOwner;\\n\\n    /// @notice The installed transaction guard; zero = none.\\n    address public guard;\\n\\n    event AddedOwner(address indexed owner);\\n    event RemovedOwner(address indexed owner);\\n    event GuardChanged(address indexed guard);\\n\\n    error AlreadyOwner(address who);\\n    error NotOwner(address who);\\n    error LastOwner();\\n    error UnknownChange(uint8 kind);\\n\\n    constructor(address[] memory initialOwners) {\\n        for (uint256 i = 0; i < initialOwners.length; i++) {\\n            _owners.push(initialOwners[i]);\\n            _isOwner[initialOwners[i]] = true;\\n        }\\n    }\\n\\n    // \\u2500\\u2500 The module's whole view of the Safe \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n\\n    function getOwners() external view returns (address[] memory) {\\n        return _owners;\\n    }\\n\\n    function isOwner(address who) external view returns (bool) {\\n        return _isOwner[who];\\n    }\\n\\n    function ownerCount() external view returns (uint256) {\\n        return _owners.length;\\n    }\\n\\n    // \\u2500\\u2500 Guard plumbing (on a real Safe this is `onlySelf`) \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n\\n    function setGuard(address newGuard) external {\\n        guard = newGuard;\\n        emit GuardChanged(newGuard);\\n    }\\n\\n    /**\\n     * @dev One `onlySelf` owner mutation, wired the way Safe 1.4.1 wires it:\\n     *      the guard is read once, `checkTransaction` runs before the mutation,\\n     *      `checkAfterExecution(txHash, true)` after it. `kind`: 0 = add(a),\\n     *      1 = remove(a), 2 = swap(a \\u2192 b).\\n     */\\n    function execOwnerChange(uint8 kind, address a, address b) external {\\n        address g = guard;\\n        if (g != address(0)) {\\n            IGuard(g).checkTransaction(\\n                address(this),\\n                0,\\n                \\\"\\\",\\n                0,\\n                0,\\n                0,\\n                0,\\n                address(0),\\n                payable(address(0)),\\n                \\\"\\\",\\n                msg.sender\\n            );\\n        }\\n\\n        if (kind == 0) {\\n            _addOwner(a);\\n        } else if (kind == 1) {\\n            _removeOwner(a);\\n        } else if (kind == 2) {\\n            _swapOwner(a, b);\\n        } else {\\n            revert UnknownChange(kind);\\n        }\\n\\n        if (g != address(0)) {\\n            IGuard(g).checkAfterExecution(bytes32(0), true);\\n        }\\n    }\\n\\n    /// @dev Execute an arbitrary call as the Safe \\u2014 the `execTransaction`\\n    ///      shape minus signatures, which is how a real Safe upgrades its own\\n    ///      module or calls an `onlySelf` target.\\n    function execCall(address target, bytes calldata data) external payable returns (bytes memory) {\\n        (bool ok, bytes memory ret) = target.call(data);\\n        if (!ok) {\\n            assembly {\\n                revert(add(ret, 32), mload(ret))\\n            }\\n        }\\n        return ret;\\n    }\\n\\n    /// @dev Call the guard's post-execution hook as the Safe, without an owner\\n    ///      change. Used to prove the sender gate and the catch.\\n    function pokeGuard(bytes32 txHash, bool success) external {\\n        address g = guard;\\n        if (g != address(0)) IGuard(g).checkAfterExecution(txHash, success);\\n    }\\n\\n    // \\u2500\\u2500 Mutation \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n\\n    function _addOwner(address a) private {\\n        if (_isOwner[a]) revert AlreadyOwner(a);\\n        _isOwner[a] = true;\\n        _owners.push(a);\\n        emit AddedOwner(a);\\n    }\\n\\n    function _removeOwner(address a) private {\\n        if (!_isOwner[a]) revert NotOwner(a);\\n        if (_owners.length == 1) revert LastOwner();\\n        _isOwner[a] = false;\\n        for (uint256 i = 0; i < _owners.length; i++) {\\n            if (_owners[i] == a) {\\n                _owners[i] = _owners[_owners.length - 1];\\n                _owners.pop();\\n                break;\\n            }\\n        }\\n        emit RemovedOwner(a);\\n    }\\n\\n    function _swapOwner(address oldOwner, address newOwner) private {\\n        if (!_isOwner[oldOwner]) revert NotOwner(oldOwner);\\n        if (_isOwner[newOwner]) revert AlreadyOwner(newOwner);\\n        _isOwner[oldOwner] = false;\\n        _isOwner[newOwner] = true;\\n        for (uint256 i = 0; i < _owners.length; i++) {\\n            if (_owners[i] == oldOwner) {\\n                _owners[i] = newOwner;\\n                break;\\n            }\\n        }\\n        emit RemovedOwner(oldOwner);\\n        emit AddedOwner(newOwner);\\n    }\\n}\\n\\ninterface IGuard {\\n    function checkTransaction(\\n        address to,\\n        uint256 value,\\n        bytes memory data,\\n        uint8 operation,\\n        uint256 safeTxGas,\\n        uint256 baseGas,\\n        uint256 gasPrice,\\n        address gasToken,\\n        address payable refundReceiver,\\n        bytes memory signatures,\\n        address msgSender\\n    ) external;\\n\\n    function checkAfterExecution(bytes32 txHash, bool success) external;\\n}\\n\\n/**\\n * @title RevertingSync\\n * @notice A module stand-in whose `sync()` reverts, for the guard's catch.\\n */\\ncontract RevertingSync {\\n    error Broken();\\n\\n    function sync() external pure returns (bool) {\\n        revert Broken();\\n    }\\n}\\n\",\"keccak256\":\"0xce9c36ddf6752a7b85942e7a9af452f51bc7785508e57c6c8a05f338303392f3\",\"license\":\"MIT\"}},\"version\":1}",
  "storageLayout": {
    "storage": [],
    "types": null
  },
  "userdoc": {
    "kind": "user",
    "methods": {},
    "notice": "A module stand-in whose `sync()` reverts, for the guard's catch.",
    "version": 1
  }
} as const;