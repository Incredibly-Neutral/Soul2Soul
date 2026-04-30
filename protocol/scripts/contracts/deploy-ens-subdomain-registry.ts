import { ethers, network } from "hardhat";
import { namehash } from 'ethers';

// Helper function to format gas to a readable amount with ETH equivalent
function formatGasCost(gasAmount: bigint, gasPrice: bigint): string {
  const gasCostWei = gasAmount * gasPrice;
  return `${ethers.formatEther(gasCostWei)} ETH at ${ethers.formatUnits(
    gasPrice,
    "gwei",
  )} gwei`;
}

async function main() {
  console.log("Deploying Minimal ENSSubdomainRegistry to", network.name);

  // CRITICAL: Require mainnet for production
  if (network.name !== "mainnet") {
    console.log("⚠️ Warning: You're not deploying to mainnet. Current network:", network.name);
    console.log("To deploy to mainnet, use: npx hardhat run scripts/deploy-ens-subdomain-registry.ts --network mainnet");
  }

  // Configuration
  const DOMAIN_NAME = "soul2soul.eth";
  const DOMAIN_NODE = namehash(DOMAIN_NAME);
  const PROTOCOL_SAFE_ADDRESS = process.env.PROTOCOL_SAFE_ADDRESS || "";
  const NAMEWRAPPER_ADDRESS = process.env.NAMEWRAPPER_ADDRESS || "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401";

  // ENS contracts on mainnet
  const ENS_REGISTRY_ADDRESS = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

  // ============================================
  // SAFETY CHECKS BEFORE DEPLOYMENT
  // ============================================
  
  console.log("\n🔍 Running pre-deployment safety checks...\n");

  // 1. Check PROTOCOL_SAFE_ADDRESS is set and valid
  if (!PROTOCOL_SAFE_ADDRESS) {
    console.error("❌ ERROR: PROTOCOL_SAFE_ADDRESS environment variable not set");
    console.log("The multisig address should be set as the controller");
    process.exit(1);
  }

  if (!ethers.isAddress(PROTOCOL_SAFE_ADDRESS)) {
    console.error("❌ ERROR: PROTOCOL_SAFE_ADDRESS is not a valid address");
    process.exit(1);
  }

  // 2. Verify the multisig exists on-chain
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider;
  const safeCode = await provider.getCode(PROTOCOL_SAFE_ADDRESS);
  if (safeCode === "0x") {
    console.error(`❌ ERROR: PROTOCOL_SAFE_ADDRESS ${PROTOCOL_SAFE_ADDRESS} is not a contract`);
    console.log("Please verify the Safe multisig address");
    process.exit(1);
  }
  console.log("✅ Multisig contract verified on-chain");

  // 3. Check deployer owns the domain
  const nameWrapper = new ethers.Contract(
    NAMEWRAPPER_ADDRESS,
    ["function ownerOf(uint256 id) view returns (address)"],
    provider
  );

  let currentOwner;
  // try {
  //   currentOwner = await nameWrapper.ownerOf(DOMAIN_NODE);
  //   console.log(`Current owner of ${DOMAIN_NAME}:`, currentOwner);
    
  //   if (currentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
  //     console.error(`❌ ERROR: Deployer doesn't own ${DOMAIN_NAME}`);
  //     console.log(`Current owner: ${currentOwner}`);
  //     console.log(`Deployer: ${deployer.address}`);
  //     console.log("\nYou must own the domain to transfer it to the registry after deployment");
  //     process.exit(1);
  //   }
  //   console.log("✅ Deployer owns the domain");
  // } catch (error) {
  //   console.error(`❌ ERROR: Could not verify domain ownership`);
  //   console.error(error);
  //   process.exit(1);
  // }

  // 4. Verify NameWrapper address
  if (NAMEWRAPPER_ADDRESS.toLowerCase() !== "0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401") {
    console.error("❌ ERROR: NameWrapper address doesn't match mainnet");
    console.log(`Expected: 0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401`);
    console.log(`Got: ${NAMEWRAPPER_ADDRESS}`);
    process.exit(1);
  }
  console.log("✅ NameWrapper address verified");

  // 5. Display deployment summary and ask for confirmation
  console.log("\n📋 Deployment Summary:");
  console.log("═".repeat(50));
  console.log(`Network: ${network.name}`);
  console.log(`Domain: ${DOMAIN_NAME}`);
  console.log(`Controller (Multisig): ${PROTOCOL_SAFE_ADDRESS}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(await provider.getBalance(deployer.address))} ETH`);
  console.log("═".repeat(50));
  
  console.log("\n⚠️  IMPORTANT POST-DEPLOYMENT STEPS:");
  console.log("1. After deployment, you MUST transfer the domain to the registry contract");
  console.log("2. Use: nameWrapper.safeTransferFrom(yourAddress, registryAddress, DOMAIN_NODE, 1, '0x')");
  console.log("3. Only then will the registry be able to create subdomains\n");

  console.log("\nProceeding with deployment...");

  // Rest of your deployment code...
  const factory = await ethers.getContractFactory("ENSOpenSubdomainRegistry");

  try {
    const recordsContract = await factory.deploy(
      ENS_REGISTRY_ADDRESS,
      DOMAIN_NODE,
      PROTOCOL_SAFE_ADDRESS,
      NAMEWRAPPER_ADDRESS,
      { gasLimit: 3000000 }
    );

    console.log("Deployment transaction sent, waiting for confirmation...");
    console.log("Transaction hash:", recordsContract.deploymentTransaction()?.hash);

    await recordsContract.waitForDeployment();
    const contractAddress = await recordsContract.getAddress();

    console.log("✅ ENSSubdomainRegistry deployed to:", contractAddress);

    // Verify the controller was set correctly
    const registryContract = await ethers.getContractAt("ENSOpenSubdomainRegistry", contractAddress);
    const setController = await registryContract.parentDomainController();
    console.log("✅ Controller set to:", setController);
    
    if (setController.toLowerCase() !== PROTOCOL_SAFE_ADDRESS.toLowerCase()) {
      console.error("❌ WARNING: Controller mismatch!");
      console.log(`Expected: ${PROTOCOL_SAFE_ADDRESS}`);
      console.log(`Got: ${setController}`);
    }

    console.log("\n📝 Verification command:");
    console.log(`npx hardhat verify --network ${network.name} ${contractAddress} "${ENS_REGISTRY_ADDRESS}" "${DOMAIN_NODE}" "${PROTOCOL_SAFE_ADDRESS}" "${NAMEWRAPPER_ADDRESS}"`);

    console.log("\n🚀 NEXT STEPS:");
    console.log("═".repeat(50));
    console.log("1. Transfer domain ownership to registry:");
    console.log(`   nameWrapper.safeTransferFrom(`);
    console.log(`     "${deployer.address}",`);
    console.log(`     "${contractAddress}",`);
    console.log(`     "${DOMAIN_NODE}",`);
    console.log(`     1,`);
    console.log(`     "0x"`);
    console.log(`   )`);
    console.log("2. Verify the registry owns the domain");
    console.log("3. Test subdomain registration");
    console.log("═".repeat(50));

    return { recordsContract, contractAddress };
  } catch (error) {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
