# ENS Deployment Guide for Soul2Soul

This guide walks through the process of deploying and configuring the ENS infrastructure for the Soul2Soul protocol. The system uses a cross-chain approach with records stored on Base and resolved from Ethereum.

## Prerequisites

Before you begin, ensure you have:

1. An ENS domain you own (e.g., soul2soul.eth)
2. Access to both Ethereum and Base networks
3. Sufficient ETH on both networks for deployment transactions
4. API keys for block explorers if you want contract verification

Make sure your `.env` file has the following variables:

```
# Network access
SEPOLIA_RPC_URL=https://ethereum-sepolia.publicnode.com
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
PRIVATE_KEY=your_private_key_here

# Block explorer API keys (for verification)
ETHERSCAN_API_KEY=your_etherscan_api_key
BASESCAN_API_KEY=your_basescan_api_key
```

## Deployment Process

### Step 1: Deploy ENSSubdomainRecordsContract on Base Sepolia

First, deploy the contract that will store ENS records on Base:

```bash
npx hardhat run scripts/deploy-ens-subdomain-records.ts --network baseSepolia
```

After successful deployment, you'll receive:
- Contract address
- Transaction hash
- Verification status

Export the contract address as an environment variable:

```bash
export BASE_RECORDS_ADDRESS=0x...your_contract_address...
```

### Step 2: Authorize Callers (Optional)

If you want other addresses to be able to manage ENS records:

```bash
npx hardhat run scripts/authorize-caller.ts --network baseSepolia
```

You'll be prompted to enter:
- The address to authorize
- Whether to authorize or revoke authorization

### Step 3: Test Records on Base

Test that your records contract works correctly:

```bash
npx hardhat run scripts/test-ens-subdomain-records.ts --network baseSepolia
```

This will:
- Set test records for `test.soul2soul.eth`
- Verify records can be read
- Test batch operations

### Step 4: Deploy DirectRPCResolver on Ethereum Sepolia

Now deploy the resolver contract on Ethereum that will use CCIP-Read to fetch records from Base:

```bash
npx hardhat run scripts/deploy-ens-resolver.ts --network sepolia
```

After deployment, save the resolver address:

```bash
export ENS_RESOLVER_ADDRESS=0x...your_resolver_address...
```

### Step 5: Set Your ENS Domain to Use the Resolver

Using the ENS app (https://app.ens.domains/):

1. Connect wallet that owns your ENS domain
2. Navigate to your domain
3. Go to "More" → "Set Resolver"
4. Enter your resolver address
5. Confirm the transaction

Alternatively, you can use our script (requires domain ownership):

```bash
npx hardhat run scripts/set-ens-resolver.ts --network sepolia
```

### Step 6: Test the Complete Setup

Test the full resolution flow:

```bash
npx hardhat run scripts/test-ens-resolution.ts --network sepolia
```

This confirms:
- Resolver is properly configured
- CCIP-Read is working correctly
- Cross-chain resolution is set up

## Managing ENS Records

### Adding New Subdomains

To add a new subdomain:

```bash
npx hardhat run scripts/add-subdomain-record.ts --network baseSepolia
```

Or use direct contract calls:

```javascript
// Get the namehash of the subdomain
const subNode = namehash("mysubdomain.soul2soul.eth");

// Set records
await ensSubdomainRecords.setAddress(subNode, "0x...");
await ensSubdomainRecords.setText(subNode, "description", "My subdomain description");
await ensSubdomainRecords.setText(subNode, "url", "https://example.com");
```

### Batch Updates

For efficiency, use batch updates when setting multiple records:

```javascript
const nodes = [namehash("sub1.soul2soul.eth"), namehash("sub2.soul2soul.eth")];
const addresses = ["0x...", "0x..."];
const keys = [
  ["description", "url"],
  ["description", "avatar", "url"]
];
const values = [
  ["First subdomain", "https://example.com"],
  ["Second subdomain", "https://example.com/avatar.png", "https://example.com/sub2"]
];

await ensSubdomainRecords.batchSetRecords(nodes, addresses, keys, values);
```

## Troubleshooting

### Common Issues

1. **Resolver not set correctly**:
   - Verify the resolver address with `ens.getResolver('soul2soul.eth')`

2. **Records not appearing**:
   - Check Base contract has records: `ensSubdomainRecords.getAddress(node)`
   - Verify RPC URLs in resolver are correct: `resolver.getRpcUrls()`

3. **Transaction errors**:
   - Ensure you're using the account that owns the contract or is authorized
   - Check gas settings for Base transactions

### Verification Failures

If contract verification fails:

```bash
npx hardhat verify --network baseSepolia CONTRACT_ADDRESS
```

## Advanced Configuration

### Custom RPC URLs

To update RPC URLs in the resolver:

```bash
npx hardhat run scripts/update-resolver-rpcs.ts --network sepolia
```

### Emergency Functions

For emergency situations:

- Clear records: `ensSubdomainRecords.clearRecords(node, keys)`
- Transfer records: `ensSubdomainRecords.emergencyTransferRecords(fromNode, toNode, keys)`

## References

- [ENS Documentation](https://docs.ens.domains/)
- [CCIP-Read Specification](https://eips.ethereum.org/EIPS/eip-3668)
- [Base Chain Documentation](https://docs.base.org/)