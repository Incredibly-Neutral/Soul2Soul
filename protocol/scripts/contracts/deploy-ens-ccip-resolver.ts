import { ethers, network } from "hardhat";
import * as fs from "fs";

async function main() {
  console.log("Deploying ENS Resolver with CCIP to", network.name);

  if (network.name !== "mainnet") {
    console.log("⚠️ Warning: You're not deploying to mainnet. Current network:", network.name);
  }

  // Configuration
  const DOMAIN_NAME = "soul2soul.eth";
  const PROTOCOL_SAFE_ADDRESS = process.env.PROTOCOL_SAFE_ADDRESS || "";
  const BASE_RECORDS_ADDRESS = process.env.BASE_RECORDS_ADDRESS || "";


  // Mainnet addresses
  const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
  const NAME_WRAPPER = "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401";

  // Gateway URLs - your CCIP-Read gateway
  const GATEWAY_URLS = [
    process.env.GATEWAY_URL || "https://ccip.transport-union.dev",
    // Add backup gateways if available
  ];

  // ============================================
  // VALIDATION
  // ============================================
  
  console.log("\n🔍 Validating configuration...\n");

  if (!BASE_RECORDS_ADDRESS) {
    console.error("❌ ERROR: BASE_RECORDS_ADDRESS environment variable not set");
    process.exit(1);
  }

  if (!ethers.isAddress(BASE_RECORDS_ADDRESS)) {
    console.error("❌ ERROR: BASE_RECORDS_ADDRESS is not a valid address");
    process.exit(1);
  }

  if (!PROTOCOL_SAFE_ADDRESS) {
    console.error("❌ ERROR: PROTOCOL_SAFE_ADDRESS environment variable not set");
    process.exit(1);
  }

  if (!ethers.isAddress(PROTOCOL_SAFE_ADDRESS)) {
    console.error("❌ ERROR: PROTOCOL_SAFE_ADDRESS is not a valid address");
    process.exit(1);
  }

  if (!GATEWAY_URLS[0] || !GATEWAY_URLS[0].startsWith('https://')) {
    console.error("❌ ERROR: GATEWAY_URL must be set and use HTTPS");
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider;

  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await provider.getBalance(deployer.address)));

  // Calculate domain node
  const domainNode = ethers.namehash(DOMAIN_NAME);

  // Verify Base contract exists
  // const baseCode = await provider.getCode(BASE_RECORDS_ADDRESS);
  // if (baseCode === "0x") {
  //   console.error(`❌ ERROR: BASE_RECORDS_ADDRESS ${BASE_RECORDS_ADDRESS} is not a contract`);
  //   process.exit(1);
  // }
  // console.log("✅ Base records contract verified on Base");

  // Verify multisig exists
  const safeCode = await provider.getCode(PROTOCOL_SAFE_ADDRESS);
  if (safeCode === "0x") {
    console.error(`❌ ERROR: PROTOCOL_SAFE_ADDRESS ${PROTOCOL_SAFE_ADDRESS} is not a contract`);
    process.exit(1);
  }
  console.log("✅ Multisig contract verified on mainnet");

  // Display configuration
  console.log("\n📋 Deployment Configuration:");
  console.log("═".repeat(60));
  console.log(`Network: ${network.name}`);
  console.log(`Domain: ${DOMAIN_NAME}`);
  console.log(`Domain Node: ${domainNode}`);
  console.log(`Base Records: ${BASE_RECORDS_ADDRESS}`);
  console.log(`Gateway URLs: ${GATEWAY_URLS.join(", ")}`);
  console.log(`ENS Registry: ${ENS_REGISTRY}`);
  console.log(`NameWrapper: ${NAME_WRAPPER}`);
  console.log(`Initial Owner: ${PROTOCOL_SAFE_ADDRESS}`);
  console.log("═".repeat(60));

  // ============================================
  // DEPLOYMENT
  // ============================================

  console.log("\n🚀 Deploying ENSResolverWthCCIP...\n");

  const ResolverFactory = await ethers.getContractFactory("ENSResolverWthCCIP");

  try {
    // Get deployment transaction
    const deployTx = await ResolverFactory.getDeployTransaction(
      domainNode,
      GATEWAY_URLS,
      BASE_RECORDS_ADDRESS,
      ENS_REGISTRY,
      NAME_WRAPPER,
      PROTOCOL_SAFE_ADDRESS
    );

    // Get gas settings
    const feeData = await provider.getFeeData();
    if (!feeData.gasPrice) {
      console.error("❌ Could not get gas price");
      process.exit(1);
    }

    const gasPrice = (feeData.gasPrice * BigInt(12)) / BigInt(10); // +20% buffer
    const gasEstimate = BigInt(6000000); // Generous estimate

    deployTx.gasLimit = gasEstimate;
    deployTx.gasPrice = gasPrice;

    console.log(`Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
    console.log(`Gas limit: ${gasEstimate.toString()}`);
    console.log(`Estimated cost: ${ethers.formatEther(gasPrice * gasEstimate)} ETH`);

    console.log("\n📤 Sending deployment transaction...");
    const txResponse = await deployer.sendTransaction(deployTx);
    console.log(`Transaction hash: ${txResponse.hash}`);
    console.log(`Etherscan: https://etherscan.io/tx/${txResponse.hash}`);

    console.log("\n⏳ Waiting for confirmation...");
    const receipt = await txResponse.wait();
    
    if (!receipt || !receipt.contractAddress) {
      console.error("❌ Deployment failed - no contract address");
      process.exit(1);
    }

    const resolverAddress = receipt.contractAddress;

    console.log("\n✅ Resolver deployed successfully!");
    console.log("═".repeat(60));
    console.log(`Contract address: ${resolverAddress}`);
    console.log(`Block number: ${receipt.blockNumber}`);
    console.log(`Gas used: ${receipt.gasUsed.toString()}`);
    console.log("═".repeat(60));

    // Save deployment info
    const deploymentInfo = {
      ENS_RESOLVER_ADDRESS: resolverAddress,
      DOMAIN_NAME: DOMAIN_NAME,
      DOMAIN_NODE: domainNode,
      BASE_RECORDS_ADDRESS: BASE_RECORDS_ADDRESS,
      GATEWAY_URLS: GATEWAY_URLS,
      ENS_REGISTRY: ENS_REGISTRY,
      NAME_WRAPPER: NAME_WRAPPER,
      PROTOCOL_SAFE_ADDRESS: PROTOCOL_SAFE_ADDRESS,
      DEPLOYED_AT: new Date().toISOString(),
      NETWORK: network.name,
      TX_HASH: txResponse.hash,
      BLOCK_NUMBER: receipt.blockNumber
    };

    fs.writeFileSync(
      "./deployed-resolver-mainnet.json",
      JSON.stringify(deploymentInfo, null, 2)
    );

    console.log("\n💾 Deployment info saved to: deployed-resolver-mainnet.json");

    // Verification command
    console.log("\n📝 Hardhat verification command:");
    console.log("═".repeat(60));
    console.log(`npx hardhat verify --network mainnet ${resolverAddress} \\`);
    console.log(`  "${domainNode}" \\`);
    console.log(`  '${JSON.stringify(GATEWAY_URLS)}' \\`);
    console.log(`  "${BASE_RECORDS_ADDRESS}" \\`);
    console.log(`  "${ENS_REGISTRY}" \\`);
    console.log(`  "${NAME_WRAPPER}" \\`);
    console.log(`  "${PROTOCOL_SAFE_ADDRESS}"`);
    console.log("═".repeat(60));

    // Next steps
    console.log("\n🚀 NEXT STEPS:");
    console.log("═".repeat(60));
    console.log("1. Verify the contract on Etherscan (command above)");
    console.log("\n2. Set this resolver for soul2soul.eth:");
    console.log("   Use Safe Transaction Builder:");
    console.log(`   Contract: ${NAME_WRAPPER}`);
    console.log(`   Function: setResolver(bytes32 node, address resolver)`);
    console.log(`   Parameters:`);
    console.log(`     node: ${domainNode}`);
    console.log(`     resolver: ${resolverAddress}`);
    console.log("\n3. Test resolution:");
    console.log(`   const resolver = new ethers.Contract("${resolverAddress}", abi, provider);`);
    console.log(`   const hash = await resolver.contenthash("${domainNode}");`);
    console.log("\n4. Make sure your CCIP gateway is running:");
    console.log(`   ${GATEWAY_URLS[0]}`);
    console.log("═".repeat(60));

    return { resolverAddress, deploymentInfo };

  } catch (error: any) {
    console.error("\n❌ Deployment failed:");
    console.error("Error:", error.message);
    if (error.transaction) {
      console.error("Transaction:", error.transaction);
    }
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Script failed:", error);
    process.exit(1);
  });