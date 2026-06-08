export const S2S_RECORDS_ABI = [
  "function setRecord(string calldata key, string calldata value) external",
  "function setRecords(string[] calldata keys, string[] calldata values) external", 
  "function getRecord(string calldata key) external view returns (string memory)",
  "function getRecords(string[] calldata keys) external view returns (string[] memory)",
  "function getAllRecords() external view returns (string[] memory keys, string[] memory values)",
  "function deleteRecord(string calldata key) external",
  "function recordExists(string calldata key) external view returns (bool)",
  "function NAME() external view returns (string memory)",
  "function VERSION() external view returns (string memory)",
  "function getRecordCount() external view returns (uint256)"
];


export const IPFS_URL = "https://ipfs.transport-union.dev";
export const PINATA_API_KEY = "REDACTED";
export const PINATA_SECRET_API_KEY =
  "REDACTED";