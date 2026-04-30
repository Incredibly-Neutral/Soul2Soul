import { ethers, network } from "hardhat";

const FACTORY_ADDRESS = "0x6F5fc13c55783A7667E0e8D80970772A5A74027a";


const main = async () => {

    const factory = await ethers.getContractAt(
      "S2SPublicationModuleFactory", 
      FACTORY_ADDRESS
    );


      // Deploy new implementation to factory
    console.log("Deploying new implementation...");
    const tx = await factory.deployNewImplementation();
    await tx.wait();
    
    const newImplementation = await factory.latestImplementation();
    console.log("✅ New implementation deployed:", newImplementation);
    console.log("✅ Future modules will use this implementation");

    // This requires the proxy owner to call it
    // await proxy.upgradeToAndCall(newImplementation, "0x"); 
}

main();