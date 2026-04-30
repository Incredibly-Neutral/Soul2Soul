import { ethers, run } from "hardhat";
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying modules with the account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());
  console.log("Network:", (await ethers.provider.getNetwork()).name);

  // Deploy RolesModule
  console.log("Deploying RolesModule...");
  const RolesModule = await ethers.getContractFactory("RolesModule");
  const rolesModule = await RolesModule.deploy();
  await rolesModule.waitForDeployment();
  const rolesModuleAddress = await rolesModule.getAddress();
  console.log("RolesModule deployed to:", rolesModuleAddress);

  // Deploy DealsModule
  console.log("Deploying DealsModule...");
  const DealsModule = await ethers.getContractFactory("DealsModule");
  const dealsModule = await DealsModule.deploy();
  await dealsModule.waitForDeployment();
  const dealsModuleAddress = await dealsModule.getAddress();
  console.log("DealsModule deployed to:", dealsModuleAddress);

  // Verify contracts on Etherscan/Basescan
  console.log("Waiting for 5 blocks to be mined before verification...");
  await rolesModule.deploymentTransaction()?.wait(5);
  await dealsModule.deploymentTransaction()?.wait(5);

  console.log("Verifying RolesModule contract...");
  try {
    await run("verify:verify", {
      address: rolesModuleAddress,
      constructorArguments: []
    });
    console.log("RolesModule verified successfully");
  } catch (error) {
    console.error("Error verifying RolesModule:", error);
  }

  console.log("Verifying DealsModule contract...");
  try {
    await run("verify:verify", {
      address: dealsModuleAddress,
      constructorArguments: []
    });
    console.log("DealsModule verified successfully");
  } catch (error) {
    console.error("Error verifying DealsModule:", error);
  }

  console.log("Deployment Summary:");
  console.log("-------------------");
  console.log("RolesModule:", rolesModuleAddress);
  console.log("DealsModule:", dealsModuleAddress);
  console.log("-------------------");
  console.log("Don't forget to set up these modules in your Safe!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});