import { ethers, network } from "hardhat";

async function main() {
  console.log("Deploying ENSSubdomainRecordsContract to", network.name);

  // Configuration
  const PROTOCOL_SAFE_ADDRESS = process.env.PROTOCOL_MULTISIG || ""; // Set this in .env or pass as argument

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await deployer.provider.getBalance(deployer.address))
  );

  // Get contract factory
  const ENSSubdomainRecordsContract = await ethers.getContractFactory(
    "ENSSubdomainRecordsContract"
  );

  console.log("\nProceeding with deployment...");
  console.log(
    "Contract will be owned by:",
    PROTOCOL_SAFE_ADDRESS || deployer.address
  );

  try {
    // Deploy with initialOwner parameter
    const recordsContract = await ENSSubdomainRecordsContract.deploy(
      PROTOCOL_SAFE_ADDRESS || ethers.ZeroAddress, // Pass Zero Address if no protocol safe to keep deployer as owner
      { gasLimit: 3000000 }
    );

    console.log("Deployment transaction sent, waiting for confirmation...");
    console.log(
      "Transaction hash:",
      recordsContract.deploymentTransaction()?.hash
    );

    await recordsContract.waitForDeployment();
    const contractAddress = await recordsContract.getAddress();

    console.log("✅ ENSSubdomainRecordsContract deployed to:", contractAddress);

    // Verify the owner
    const owner = await recordsContract.owner();
    console.log("Contract owner is now:", owner);

    // Check protocol address
    const protocolAddress = await recordsContract.protocolAddress();
    console.log("Protocol address is set to:", protocolAddress);

    // Log verification command
    console.log("\nTo verify the contract on Basescan:");
    console.log(
      `npx hardhat verify --network ${network.name} ${contractAddress} "${
        PROTOCOL_SAFE_ADDRESS || ethers.ZeroAddress
      }"`
    );

    // Return the contract and deployment info for testing
    return { recordsContract, contractAddress };
  } catch (error) {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }
}

// Execute deployment if script is run directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

// Export for testing
export { main };
