import { ethers, network } from "hardhat";

async function main() {
  console.log("Deploying S2S Records Module Factory to", network.name);

  // Check if we're on Base chain
  if (!network.name.toLowerCase().includes("base")) {
    console.warn("⚠️ Warning: This contract should be deployed to Base chain!");
    console.log("Current network:", network.name);
    const confirmDeploy = process.env.FORCE_DEPLOY === "true";

    if (!confirmDeploy) {
      console.log("Deployment aborted. Set FORCE_DEPLOY=true to override.");
      return;
    }
    console.log("FORCE_DEPLOY=true, continuing anyway...");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await deployer.provider.getBalance(deployer.address))
  );

  // Deploy the S2S Records Module Factory
  console.log("\n=== Deploying S2S Records Module Factory ===");

  try {
    const S2SRecordsModuleFactory = await ethers.getContractFactory(
      "S2SRecordsModuleFactory"
    );

    console.log("Sending deployment transaction...");
    const factory = await S2SRecordsModuleFactory.deploy();

    console.log("Deployment transaction sent, waiting for confirmation...");
    console.log("Transaction hash:", factory.deploymentTransaction()?.hash);

    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();

    console.log("✅ S2S Records Module Factory deployed to:", factoryAddress);

    // Optional: Deploy a test module to verify factory works
    // console.log("\n=== Testing Factory (Optional) ===");
    // const testSafeAddress = "0x0000000000000000000000000000000000000001"; // Dummy address for testing
    
    // console.log("Creating test module for address:", testSafeAddress);
    // const createTx = await factory.createModule(testSafeAddress);
    // const createReceipt = await createTx.wait();
    
    // // Get module address from event
    // const moduleCreatedEvent = createReceipt?.logs.find(
    //   (log: any) => log.fragment?.name === "ModuleCreated"
    // );
    
    // if (moduleCreatedEvent) {
    //   console.log("✅ Test module created at:", moduleCreatedEvent.args[1]);
    // }

    console.log("\n=== Deployment Summary ===");
    console.log("Network:", network.name);
    console.log("Factory Address:", factoryAddress);
    console.log("Deployer:", deployer.address);
    console.log("\n=== Next Steps ===");
    console.log("1. Set this address as S2S_FACTORY_ADDRESS in your environment:");
    console.log(`   export S2S_FACTORY_ADDRESS=${factoryAddress}`);
    console.log("\n2. Verify the contract on the block explorer:");
    console.log(`   npx hardhat verify --network ${network.name} ${factoryAddress}`);
    console.log("\n3. To create a module for a Safe, call:");
    console.log(`   factory.createModule(safeAddress)`);
    console.log("\n4. Enable the created module in your Safe through the Safe UI");
    console.log("\n5. Use the module to store/retrieve records via Safe transactions");

    // Save deployment info to file
    const deploymentInfo = {
      network: network.name,
      factoryAddress: factoryAddress,
    //   deploymentBlock: createReceipt?.blockNumber,
      transactionHash: factory.deploymentTransaction()?.hash,
      deployer: deployer.address,
      timestamp: new Date().toISOString(),
    };

    console.log("\n=== Deployment Info ===");
    console.log(JSON.stringify(deploymentInfo, null, 2));

  } catch (error) {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error("❌ Script failed:", error);
  process.exitCode = 1;
});