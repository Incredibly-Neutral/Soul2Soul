# IPFS Migration: DAG-CBOR to DAG-PB



## Task Description
We write the code to migrate data structure from DAG-CBOR to DAG-PB:
- The DAG-CBOR structure is for use of hosting over traditional DNS
- We use DAG-PB for a dnslink with ipfs:// protocol to be added to .eth address
- DAG-CBOR uses https://ipfs.transport-union.dev
- DAG-PB uses https://neutralpress.mypinata.cloud

## Implementation Requirements
- DO NOT use MFS (Mutable File System) - it causes timeout issues
- Return string should be CID for the directory that includes the file structure
- Result must work with DNS dnslink
- look at Pinata best practices

## Implementation Notes
1. We use Pinata API for uploading files in DAG-PB format:
   - Authentication via PINATA_API_KEY and PINATA_SECRET_API_KEY from constants.ts
   - Upload files using pinFileToIPFS endpoint

2. Path conflicts:
   - Must handle conflicts between files and directories with same name
   - Use trailing slashes to properly mark directories
   - Track existing paths to avoid duplicates

3. Common issues:
   - "ENOTDIR" errors occur when there's a path conflict (e.g., both a file and directory at /en/ethical-positions)
   - Files need unique paths - normalize paths before adding to upload
   - Pinata extracts files to temp directories on their server before processing

4. Testing:
   - Verify CID works with dnslink by testing in IPFS gateway
   - Check entire directory structure is preserved
