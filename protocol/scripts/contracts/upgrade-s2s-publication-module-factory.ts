import { ethers, network } from "hardhat";

async function main() {
  console.log("Upgrading S2S Publication Module Implementation on", network.name);

  const [deployer] = await ethers.getSigners();
  console.log("Upgrading with account:", deployer.address);

  const FACTORY_ADDRESS = "0x6F5fc13c55783A7667E0e8D80970772A5A74027a";

  try {
    const factoryContract = await ethers.getContractAt(
      "S2SPublicationModuleFactory", 
      FACTORY_ADDRESS
    );

    const oldImplementation = await factoryContract.latestImplementation();
    console.log("\n=== Current Implementation ===");
    console.log("Old Implementation:", oldImplementation);

    // Just call deployNewImplementation - it does everything
    console.log("\n=== Deploying New Implementation ===");
    const tx = await factoryContract.deployNewImplementation();
    console.log("Transaction hash:", tx.hash);
    
    const receipt = await tx.wait();
    console.log("✅ Factory updated");

    // Get the new implementation address
    const newImplementation = await factoryContract.latestImplementation();
    const version = await factoryContract.implementationCount();

    console.log("\n=== Upgrade Summary ===");
    console.log("Network:", network.name);
    console.log("Factory:", FACTORY_ADDRESS);
    console.log("Old Implementation:", oldImplementation);
    console.log("New Implementation:", newImplementation);
    console.log("Version:", version.toString());

    console.log("\n=== Verification Commands ===");
    console.log(`npx hardhat verify --network ${network.name} ${newImplementation}`);

  } catch (error: any) {
    console.error("❌ Upgrade failed:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Script failed:", error);
  process.exitCode = 1;
});