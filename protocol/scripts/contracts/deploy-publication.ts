import { ethers, run } from "hardhat";
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  // 1. Deploy implementation
  console.log("Deploying implementation...");
  const NPublication = await ethers.getContractFactory("NPublication");
  const implementation = await NPublication.deploy();
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();
  console.log("Implementation deployed to:", implementationAddress);

  try {
    // Wait for fewer blocks
    console.log("Waiting for block confirmation...");
    await implementation.deploymentTransaction()?.wait(1);

    // Verify implementation
    console.log("Verifying implementation...");
    try {
      await run("verify:verify", {
        address: implementationAddress,
        constructorArguments: []
      });
    } catch (error: any) {
      if (!error.message.includes("already been verified")) {
        console.log("Implementation verification failed (but deployment succeeded):", error.message);
      } else {
        console.log("Implementation already verified");
      }
    }

    console.log("\nDeployment completed!");
    console.log({
      implementation: implementationAddress
    });

  } catch (error) {
    console.error("Error during deployment:", error);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
