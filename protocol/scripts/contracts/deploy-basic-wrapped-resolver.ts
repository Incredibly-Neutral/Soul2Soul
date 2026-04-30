import { ethers, network } from "hardhat";
import * as namehashModule from "@ensdomains/eth-ens-namehash";
import * as fs from "fs";
const namehash = namehashModule.hash;

async function main() {
  console.log("Deploying Basic Wrapped Resolver to", network.name);
  console.log("Script: deploy-basic-wrapped-resolver.ts");

  const PROTOCOL_SAFE_ADDRESS = process.env.PROTOCOL_MULTISIG || ""; // Set this in .env or pass as argument

  // Configuration
  const DOMAIN_NAME = "web.eth"; // Using web.eth for testing

  // Use a minimal RPC URL list for initial deployment
  const INITIAL_RPC_URL = ["https://sepolia.base.org"]; // Sepolia Base URL

  // Get the Base contract address from environment
  const BASE_RECORDS_ADDRESS = process.env.BASE_RECORDS_ADDRESS;
  if (!BASE_RECORDS_ADDRESS) {
    console.error("ERROR: BASE_RECORDS_ADDRESS environment variable not set");
    console.log(
      "Please set BASE_RECORDS_ADDRESS to the address of your ENSSubdomainRecordsContract on Base"
    );
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await deployer.provider.getBalance(deployer.address))
  );
  console.log("Network:", network.name);
  console.log("ChainId:", (await ethers.provider.getNetwork()).chainId);

  // Calculate the namehash of the domain
  const domainNode = namehash(DOMAIN_NAME);
  console.log("Domain node:", domainNode);

  // Deploy the resolver with minimal parameters
  console.log("\nDeploying BasicWrappedResolver with configuration:");
  console.log("- Domain Node:", domainNode);
  console.log("- RPC URL:", INITIAL_RPC_URL[0]);
  console.log("- Base Records Contract:", BASE_RECORDS_ADDRESS);
  console.log("- Initial Owner:", PROTOCOL_SAFE_ADDRESS || deployer.address);

  // Get factory
  const BasicWrappedResolver = await ethers.getContractFactory(
    "BasicWrappedResolver"
  );

  try {
    console.log("\nDeploying the contract directly...");
    
    // Deploy directly 
    const resolverContract = await BasicWrappedResolver.deploy(
      domainNode,
      INITIAL_RPC_URL,
      BASE_RECORDS_ADDRESS,
      PROTOCOL_SAFE_ADDRESS || ethers.ZeroAddress
    );

    console.log("Transaction hash:", resolverContract.deploymentTransaction()?.hash);
    
    console.log("\nWaiting for deployment confirmation...");
    await resolverContract.waitForDeployment();

    const resolverAddress = await resolverContract.getAddress();
    console.log("Contract deployed at:", resolverAddress);
    
    // Save the deployed contract address to a file for verification
    fs.writeFileSync(
      "./deployed-basic-wrapped-resolver.txt",
      `BASIC_WRAPPED_RESOLVER_ADDRESS=${resolverAddress}\n` +
      `DOMAIN_NODE=${domainNode}\n` +
      `BASE_RECORDS_ADDRESS=${BASE_RECORDS_ADDRESS}\n` +
      `INITIAL_RPC_URL=${INITIAL_RPC_URL[0]}\n` +
      `PROTOCOL_MULTISIG=${PROTOCOL_SAFE_ADDRESS || ethers.ZeroAddress}\n`
    );
    console.log("\nDeployment information saved to deployed-basic-wrapped-resolver.txt");
    
    console.log("\n✅ Deployment successful!");
  } catch (error: any) {
    console.error("\n❌ Basic Wrapped Resolver deployment failed:");
    if (error.code) console.error("Error code:", error.code);
    if (error.reason) console.error("Error reason:", error.reason);
    if (error.transaction) {
      console.error("Transaction:", error.transaction.hash);
      console.error("Gas limit:", error.transaction.gasLimit?.toString());
    }
    console.error(error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Script execution failed:", error);
    process.exit(1);
  });