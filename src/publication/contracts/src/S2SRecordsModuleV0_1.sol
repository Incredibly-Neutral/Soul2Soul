// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title S2SRecordsModuleV0_1
 * @notice The records module as a factory-deployed proxy: string to string records
 *         that only the owning Safe writes, behind the same proxy as every other
 *         kind, so its address is computed the same way.
 *
 * The Safe arrives from the factory in `initialize`, never as a constructor
 * argument, so the address depends only on (factory, safe, kind) and is knowable
 * in advance; nothing has to be deployed first to learn it, and the module can
 * be upgraded.
 *
 * Three declarations the factory reads before it will set this implementation:
 * `moduleKind()`, `factory()`, and `proxiableUUID()`. An upgrade target is then
 * judged per kind: an implementation approved for the publication kind is not a
 * target here.
 *
 * Records are keyed by string, exactly as before, and enumerated in insertion
 * order with a swap-pop on delete. `NAME` and `VERSION` stay for callers that
 * read them.
 */
interface IS2SRecordsModuleV0_1 {
    event RecordSet(string indexed key, string value);
    event RecordsSetBatch(string[] keys, string[] values);
    event RecordDeleted(string indexed key);
    event ContractUpgraded(address indexed implementation);

    error OnlySafe();
    error OnlyFactory();
    error ArrayLengthMismatch();
    error EmptyKey();
    error KeyNotFound();
    error ImplementationNotApproved(address implementation);
    error InvalidFactory(address factory);
    error ProtocolSafeMismatch(address factorySays, address expected);

    function NAME() external view returns (string memory);
    function VERSION() external view returns (string memory);
    function safe() external view returns (address);
    function moduleKind() external view returns (bytes32);

    function setRecord(string calldata key, string calldata value) external;
    function setRecords(string[] calldata keys, string[] calldata values) external;
    function deleteRecord(string calldata key) external;

    function getRecord(string calldata key) external view returns (string memory value);
    function getRecords(string[] calldata keys) external view returns (string[] memory values);
    function recordExists(string calldata key) external view returns (bool exists);

    function getAllKeys() external view returns (string[] memory);
    function getAllRecords() external view returns (string[] memory keys, string[] memory values);
    function getRecordCount() external view returns (uint256);
    function getKeyAtIndex(uint256 index) external view returns (string memory);

    function supportsInterface(bytes4 interfaceId) external pure returns (bool);
}

/// @dev The reads this module makes on the factory, declared here rather than
///      imported, so the module is not tied to one build of the factory.
interface IRecordsFactoryApprovals {
    function isApproved(bytes32 kind, address implementation) external view returns (bool);
    function protocolSafe() external view returns (address);
}

contract S2SRecordsModuleV0_1 is IS2SRecordsModuleV0_1, Initializable, UUPSUpgradeable {
    string public constant NAME = "S2S Records Module";
    /// @notice The manifest's major.minor, which this build implements. The
    ///         document names its own `x.y.z`; a reader compares that prefix to
    ///         this string, so a patch release of the document needs no redeploy
    ///         while a minor does.
    string public constant VERSION = "0.1";

    /// @notice This module's kind, in the one pattern every kind follows:
    ///         `s2s.module.<name>`. The factory approves upgrade targets per kind,
    ///         and a deploy script that passes another kind's string is refused by
    ///         `ImplementationKindMismatch` rather than silently accepted.
    bytes32 public constant MODULE_KIND = keccak256("s2s.module.records");

    /// @notice The Safe that owns this module. Set once, by the factory.
    address public safe;

    mapping(string => string) private records;
    string[] private recordKeys;
    mapping(string => uint256) private keyIndex;
    mapping(string => bool) private keyExists;

    /// @dev The factory whose approved set decides what this module may upgrade
    ///      to. Immutable: no storage write can change it, and it is the same
    ///      answer for every proxy over this implementation.
    address public immutable FACTORY;

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }

    /// @notice The factory that approves this module's upgrades.
    function factory() external view returns (address) {
        return FACTORY;
    }

    function moduleKind() external pure returns (bytes32) {
        return MODULE_KIND;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    /// @param _factory The factory that approves upgrade targets. Must have code:
    ///        the value cannot be corrected after this point.
    /// @param _protocolSafe The protocol safe this deploy expects the factory to
    ///        name. Not proof of ownership: what binds this implementation to the
    ///        protocol is the protocol safe's `setImplementation` on that factory.
    constructor(address _factory, address _protocolSafe) {
        if (_factory == address(0) || _factory.code.length == 0) revert InvalidFactory(_factory);
        address answers = IRecordsFactoryApprovals(_factory).protocolSafe();
        if (answers != _protocolSafe) revert ProtocolSafeMismatch(answers, _protocolSafe);
        FACTORY = _factory;
        _disableInitializers();
    }

    /**
     * @dev Called by the factory, in the same call that deployed this proxy, with
     *      the Safe the factory recorded. `params` is `abi.encode(string[] keys,
     *      string[] values)` for records to seed, or empty.
     *
     *      Seeding emits `RecordsSetBatch` like any other batch write: an indexer
     *      watching the event sees every record, including the ones the module
     *      started with.
     *
     *      The protocol Safe may create this module on a publication's behalf and
     *      choose the seeded records. That is intended: it is the same authority
     *      that approves builds, and the Safe can rewrite any record after.
     */
    function initialize(address _safe, bytes calldata params) external initializer {
        if (msg.sender != FACTORY) revert OnlyFactory();
        __UUPSUpgradeable_init();
        safe = _safe;

        if (params.length != 0) {
            (string[] memory keys, string[] memory values) = abi.decode(
                params,
                (string[], string[])
            );
            _setBatch(keys, values);
            emit RecordsSetBatch(keys, values);
        }
    }

    /// @dev Only the owning Safe starts an upgrade, and only to an implementation
    ///      the protocol safe approved for this kind. The approval is read at the
    ///      moment of the upgrade, so a withdrawn target cannot be used.
    function _authorizeUpgrade(address newImplementation) internal onlySafe override {
        if (!IRecordsFactoryApprovals(FACTORY).isApproved(MODULE_KIND, newImplementation)) {
            revert ImplementationNotApproved(newImplementation);
        }
        emit ContractUpgraded(newImplementation);
    }

    // ── Writes ─────────────────────────────────────────────────────

    function setRecord(string calldata key, string calldata value) external onlySafe {
        if (bytes(key).length == 0) revert EmptyKey();
        _set(key, value);
        emit RecordSet(key, value);
    }

    function setRecords(string[] calldata keys, string[] calldata values) external onlySafe {
        _setBatch(keys, values);
        emit RecordsSetBatch(keys, values);
    }

    function deleteRecord(string calldata key) external onlySafe {
        if (!keyExists[key]) revert KeyNotFound();

        delete records[key];

        uint256 indexToDelete = keyIndex[key];
        uint256 lastIndex = recordKeys.length - 1;
        if (indexToDelete != lastIndex) {
            string memory lastKey = recordKeys[lastIndex];
            recordKeys[indexToDelete] = lastKey;
            keyIndex[lastKey] = indexToDelete;
        }

        recordKeys.pop();
        delete keyIndex[key];
        keyExists[key] = false;

        emit RecordDeleted(key);
    }

    // ── Reads ──────────────────────────────────────────────────────

    function getRecord(string calldata key) external view returns (string memory value) {
        return records[key];
    }

    function getRecords(string[] calldata keys) external view returns (string[] memory values) {
        values = new string[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            values[i] = records[keys[i]];
        }
    }

    function recordExists(string calldata key) external view returns (bool exists) {
        return keyExists[key];
    }

    function getAllKeys() external view returns (string[] memory) {
        return recordKeys;
    }

    function getAllRecords() external view returns (string[] memory keys, string[] memory values) {
        keys = recordKeys;
        values = new string[](recordKeys.length);
        for (uint256 i = 0; i < recordKeys.length; i++) {
            values[i] = records[recordKeys[i]];
        }
    }

    function getRecordCount() external view returns (uint256) {
        return recordKeys.length;
    }

    function getKeyAtIndex(uint256 index) external view returns (string memory) {
        require(index < recordKeys.length, "Index out of bounds");
        return recordKeys[index];
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IS2SRecordsModuleV0_1).interfaceId || interfaceId == 0x01ffc9a7;
    }

    // ── Internal ───────────────────────────────────────────────────

    function _set(string memory key, string memory value) private {
        if (!keyExists[key]) {
            recordKeys.push(key);
            keyIndex[key] = recordKeys.length - 1;
            keyExists[key] = true;
        }
        records[key] = value;
    }

    function _setBatch(string[] memory keys, string[] memory values) private {
        if (keys.length != values.length) revert ArrayLengthMismatch();
        for (uint256 i = 0; i < keys.length; i++) {
            if (bytes(keys[i]).length == 0) revert EmptyKey();
            _set(keys[i], values[i]);
        }
    }
}
