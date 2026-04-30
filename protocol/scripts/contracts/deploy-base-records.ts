import { ethers, network } from "hardhat";

async function main() {
  console.log("Deploying ENS Subdomain Records Contract to", network.name);

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

  // Deploy the Base Records Contract
  console.log("\n=== Deploying ENS Subdomain Records Contract ===");

  try {
    const ENSSubdomainRecordsContract = await ethers.getContractFactory(
      "ENSSubdomainRecordsContract"
    );

    console.log("Sending deployment transaction...");
    const baseRecords = await ENSSubdomainRecordsContract.deploy();

    console.log("Deployment transaction sent, waiting for confirmation...");
    console.log("Transaction hash:", baseRecords.deploymentTransaction()?.hash);

    await baseRecords.waitForDeployment();
    const baseRecordsAddress = await baseRecords.getAddress();

    console.log("✅ ENS Subdomain Records Contract deployed to:", baseRecordsAddress);
    console.log("\n=== Deployment Summary ===");
    console.log("Network:", network.name);
    console.log("Contract Address:", baseRecordsAddress);
    console.log("Deployer:", deployer.address);
    console.log("Next Steps:");
    console.log("1. Set this address as BASE_RECORDS_ADDRESS in your environment");
    console.log("
