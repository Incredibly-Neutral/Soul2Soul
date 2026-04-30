import { ethers, network } from "hardhat";

async function main() {
  console.log("Deploying S2S Publication Module Factory to", network.name);

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)) // Fixed: use ethers.provider
  );

  console.log("\n=== Deploying S2S Publication Module Factory ===");
  console.log("(This will also deploy the implementation in the constructor)");

  try {
    const S2SPublicationModuleFactory = await ethers.getContractFactory(
      "S2SPublicationModuleFactory"
    );

    console.log("Sending deployment transaction...");
    const factory = await S2SPublicationModuleFactory.deploy();

    console.log("Deployment transaction sent, waiting for confirmation...");
    console.log("Transaction hash:", factory.deploymentTransaction()?.hash);

    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();

    console.log("✅ S2S Publication Module Factory deployed to:", factoryAddress);

    // Wait for contract to propagate
    console.log("\nWaiting for contract propagation...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Get the implementation address from the factory
    const implementationAddress = await factory.latestImplementation();
    
    console.log("✅ S2S Publication Module Implementation:", implementationAddress);

    // Verify it has the new functions
    const impl = await ethers.getContractAt("S2SPublicationModule", implementationAddress);
    
    try {
      const name = await impl.NAME();
      const count = await impl.getContentIdCount(); // Fixed: getStreamIdCount -> getContentIdCount
      console.log("\n=== Verification ===");
      console.log("✅ NAME():", name);
      console.log("✅ getContentIdCount():", count.toString());
    } catch (e: any) {
      console.error("❌ New functions not found:", e.message);
    }

    console.log("\n=== Deployment Summary ===");
    console.log("Network:", network.name);
    console.log("Factory Address:", factoryAddress);
    console.log("Implementation Address:", implementationAddress);
    console.log("Deployer:", deployer.address);

    console.log("\n=== Next Steps ===");
    console.log("1. Create a module for your Safe:");
    console.log(`   const tx = await factory.createModuleEmpty("YOUR_SAFE_ADDRESS");`);
    console.log(`   const receipt = await tx.wait();`);
    console.log("\n2. Enable the module in Safe UI:");
    console.log("   Settings → Modules → Add Module → [Module Address]");

    console.log("\n=== Verification Commands ===");
    console.log(`npx hardhat verify --network ${network.name} ${factoryAddress}`);
    console.log(`npx hardhat verify --network ${network.name} ${implementationAddress}`);

  } catch (error: any) {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Script failed:", error);
  process.exitCode = 1;
});