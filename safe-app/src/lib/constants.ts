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
export const PINATA_API_KEY = "47e196d2683c33a1bf45";
export const PINATA_SECRET_API_KEY =
  "8214464a0299f2a58e83705b85f153c145376af78757fc9b9537b0c5abdd25f4";