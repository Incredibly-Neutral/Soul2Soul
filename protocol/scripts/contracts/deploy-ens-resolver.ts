import { ethers, network } from "hardhat";
import * as namehashModule from "@ensdomains/eth-ens-namehash";
const namehash = namehashModule.hash;

// Helper function to format gas to a readable amount with ETH equivalent
function formatGasCost(gasAmount: bigint, gasPrice: bigint): string {
  const gasCostWei = gasAmount * gasPrice;
  return `${ethers.formatEther(gasCostWei)} ETH at ${ethers.formatUnits(gasPrice, 'gwei')} gwei`;
}

async function main() {
  console.log("Deploying ENS Subdomain Resolver to", network.name);

  // Configuration
  const DOMAIN_NAME = "soul2soul.eth"; // Replace with your ENS domain

  // RPC URLs for Base chain (multiple for redundancy)
  const BASE_RPC_URLS = [
    "https://base-sepolia.g.alchemy.com/v2/REDACTED",
    "https://sepolia.base.org",
    "https://base-sepolia.public.blastapi.io",
    "https://1rpc.io/base-sepolia",
  ];

  // For the initial deployment, use just one URL to avoid stack overflow
  const LIMITED_RPC_URLS = [BASE_RPC_URLS[0]];

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await deployer.provider.getBalance(deployer.address))
  );

  // 1. Deploy Base Records Contract (on Base chain)
  console.log("\n=== Step 1: Deploy ENS Subdomain Records Contract ===");
  console.log("Switch to Base network and deploy ENSSubdomainRecordsContract");
  console.log("Contract: ENSSubdomainRecordsContract.sol");

  // For this script, we'll assume you have the Base contract address
  const BASE_RECORDS_ADDRESS = process.env.BASE_RECORDS_ADDRESS;

  if (!BASE_RECORDS_ADDRESS) {
    console.log("\n📝 Manual Step Required:");
    console.log("1. Switch your hardhat network to Base");
    console.log("2. Deploy ENSSubdomainRecordsContract:");
    console.log(
      "   npx hardhat run scripts/deploy-base.js --network baseSepolia"
    );
    console.log("3. Set BASE_RECORDS_ADDRESS environment variable");
    console.log("4. Re-run this script");
    return;
  }

  console.log("Using Base Records Contract at:", BASE_RECORDS_ADDRESS);

  // 2. Deploy ENS Subdomain Resolver (on Ethereum mainnet)
  console.log("\n=== Step 2: Deploy ENS Subdomain Resolver ===");
  const domainNode = namehash(DOMAIN_NAME);

  const ENSSubdomainResolver = await ethers.getContractFactory(
    "ENSSubdomainResolver"
  );

  console.log("Deploying with parameters:");
  console.log("- Domain Node:", domainNode);
  console.log("- RPC URLs (initial):", LIMITED_RPC_URLS);
  console.log("- Base Contract:", BASE_RECORDS_ADDRESS);

  // Estimate deployment cost using fixed values
  console.log("\n=== Deployment Cost Estimation ===");
  const gasEstimate = BigInt(3000000); // conservative estimate
  
  // Get current gas price
  const feeData = await deployer.provider.getFeeData();
  const gasPrice = feeData.gasPrice || ethers.parseUnits("20", "gwei");
  
  console.log(`Fixed gas estimate: ${gasEstimate.toString()}`);
  console.log(`Current gas price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
  console.log(`Approximate deployment cost: ${formatGasCost(gasEstimate, gasPrice)}`);
  
  console.log("\nProceeding with deployment...");
  console.log("NOTE: Deploying with single RPC URL first to avoid stack overflow");
  
  try {
    // Deploy with limited RPC URLs first to avoid stack overflow
    const resolver = await ENSSubdomainResolver.deploy(
      domainNode,
      LIMITED_RPC_URLS,
      BASE_RECORDS_ADDRESS,
      { gasLimit: 5000000 }
    );

    console.log("Deployment transaction sent, waiting for confirmation...");
    console.log("Transaction hash:", resolver.deploymentTransaction()?.hash);
    
    await resolver.waitForDeployment();
    const resolverAddress = await resolver.getAddress();
    console.log("Deployment transaction confirmed");
    console.log("✅ ENS Subdomain Resolver deployed to:", resolverAddress);

    // 3. Test the deployment
    console.log("\n=== Step 3: Testing Deployment ===");

    try {
      // Test resolver configuration
      const rpcUrls = await resolver.getRpcUrls();
      console.log("Initial RPC URLs:", rpcUrls);

      const baseContract = await resolver.baseRecordsContract();
      console.log("Base Contract Address:", baseContract);

      const domain = await resolver.domainNode();
      console.log("Domain Node:", domain);

      console.log("✅ Resolver configuration verified");
      
      // 4. Update RPC URLs if we need to add more
      if (BASE_RPC_URLS.length > 1) {
        console.log("\n=== Step 4: Updating RPC URLs ===");
        console.log("Adding all RPC URLs to the resolver...");
        
        const updateTx = await resolver.updateRpcUrls(BASE_RPC_URLS);
        console.log("Update transaction sent:", updateTx.hash);
        
        await updateTx.wait();
        console.log("✅ RPC URLs updated successfully");
        
        // Verify the update
        const updatedUrls = await resolver.getRpcUrls();
        console.log("Updated RPC URLs:", updatedUrls);
      }
      
      // 5. Estimate gas costs for using the resolver
      console.log("\n=== Step 5: Gas Cost Analysis ===");

      try {
        const testNode = namehash(`test.${DOMAIN_NAME}`);

        // Estimate gas for a resolution call (this will fail but show gas estimate)
        const addrCallData = resolver.interface.encodeFunctionData("addr", [
          testNode,
        ]);
        const gasEstimate = await deployer.provider.estimateGas({
          to: resolverAddress,
          data: addrCallData,
        });

        console.log("Estimated gas for resolution:", gasEstimate.toString());
        console.log(
          "Estimated cost at 20 gwei:",
          ethers.formatEther(gasEstimate * 20000000000n),
          "ETH"
        );
      } catch (error) {
        console.log("Gas estimation completed (expected revert for CCIP-Read)");
      }

      // 6. Generate configuration for Base Records setup
      console.log("\n=== Step 6: Next Steps ===");

      const baseSetupScript = `
// Run this on Base chain to authorize the resolver
const baseRecords = await ethers.getContractAt('ENSSubdomainRecordsContract', '${BASE_RECORDS_ADDRESS}');

// If you're the owner of the Base contract, authorize the resolver
// Note: The resolver won't be calling the Base contract directly,
// but you might want to authorize a registrar contract later
await baseRecords.authorizeCaller('REGISTRAR_ADDRESS', true);

// Set some test records
const testNode = '${namehash(`test.${DOMAIN_NAME}`)}';
await baseRecords.setAddress(testNode, '${deployer.address}');
await baseRecords.setText(testNode, 'description', 'Test subdomain for ${DOMAIN_NAME}');
await baseRecords.setText(testNode, 'avatar', 'https://example.com/avatar.png');

console.log('✅ Test records set on Base chain');
`;

      console.log("Base Chain Setup Script:");
      console.log(baseSetupScript);

      // 7. Generate ENS setup instructions
      const ensSetupInstructions = `
// Set your ENS domain to use the new resolver
// This must be done by the domain owner

const ensRegistry = new ethers.Contract(
  '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', // ENS Registry
  ['function setResolver(bytes32 node, address resolver)'],
  signer // Must be domain owner
);

await ensRegistry.setResolver('${domainNode}', '${resolverAddress}');
console.log('✅ ENS domain resolver updated');
`;

      console.log("\nENS Setup Instructions:");
      console.log(ensSetupInstructions);

      // 8. Generate testing script
      const testingScript = `
// Test the complete system
const resolver = await ethers.getContractAt('ENSSubdomainResolver', '${resolverAddress}');

// This should trigger CCIP-Read and fetch from Base chain
try {
  const testNode = '${namehash(`test.${DOMAIN_NAME}`)}';
  const address = await resolver.addr(testNode);
  console.log('Resolved address:', address);

  const description = await resolver.text(testNode, 'description');
  console.log('Resolved description:', description);

} catch (error) {
  console.log('CCIP-Read triggered (this is expected)');
  console.log('Use a CCIP-Read compatible client like ethers.js');
}
`;

      console.log("\nTesting Script:");
      console.log(testingScript);

      // Get the detailed receipt information for final summary
      const deploymentTx = resolver.deploymentTransaction();
      const receipt = await deploymentTx?.wait();
      
      // 9. Save deployment info
      const deploymentInfo = {
        network: network.name,
        domain: DOMAIN_NAME,
        domainNode,
        baseRecordsContract: BASE_RECORDS_ADDRESS,
        resolverContract: resolverAddress,
        rpcUrls: await resolver.getRpcUrls(),
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        gasUsed: receipt?.gasUsed?.toString() || "Unknown",
        effectiveGasPrice: receipt?.gasPrice?.toString() || "Unknown", 
        deploymentCost: receipt ? 
          `${ethers.formatEther(receipt.gasUsed * receipt.gasPrice)} ETH` : 
          "Unknown",
        transactionHash: deploymentTx?.hash || "Unknown",
      };

      console.log("\n=== Deployment Summary ===");
      console.log(JSON.stringify(deploymentInfo, null, 2));

      // 10. Important reminders
      console.log("\n=== Important Reminders ===");
      console.log("1. ✅ Resolver deployed on Ethereum");
      console.log("2. ⏳ Deploy ENSSubdomainRecordsContract on Base if not done");
      console.log("3. ⏳ Set ENS domain resolver (requires domain ownership)");
      console.log("4. ⏳ Test with ethers.js or other CCIP-Read compatible client");
      console.log(
        "5. ⏳ Deploy SubdomainRegistrar if you want registration functionality"
      );

      console.log("\n=== Test Command ===");
      console.log("After setting up Base records and ENS resolver:");
      console.log(`node test-resolution.js ${resolverAddress} test.${DOMAIN_NAME}`);
      
    } catch (error) {
      console.error("❌ Post-deployment steps failed:", error);
    }
  } catch (error) {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }
}

// Helper function to deploy Base Records Contract
async function deployBaseRecords() {
  console.log("Deploying ENSSubdomainRecordsContract...");
  
  const ENSSubdomainRecordsContract = await ethers.getContractFactory(
    "ENSSubdomainRecordsContract"
  );
  
  // Get current gas price for estimation
  const [deployer] = await ethers.getSigners();
  const feeData = await deployer.provider.getFeeData();
  const gasPrice = feeData.gasPrice || ethers.parseUnits("20", "gwei");
  const gasEstimate = BigInt(1000000); // conservative estimate
  
  console.log(`Fixed gas estimate: ${gasEstimate.toString()}`);
  console.log(`Current gas price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
  console.log(`Approximate deployment cost: ${formatGasCost(gasEstimate, gasPrice)}`);
  
  console.log("Deploying contract...");
  const baseRecords = await ENSSubdomainRecordsContract.deploy({ gasLimit: 2000000 });
  
  console.log("Waiting for deployment to complete...");
  await baseRecords.waitForDeployment();
  const address = await baseRecords.getAddress();
  console.log("BaseRecordsContract deployed to:", address);
  
  return baseRecords;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
