import { ethers } from "hardhat";

const FACTORY = "0x6C289E77E19e748ab2c219A6529544A49EFF6250";

async function check() {
    const factory = await ethers.getContractAt(
        "S2SPublicationModuleFactory",
        FACTORY
    );
    
    // What implementation is the factory using?
    const latestImpl = await factory.latestImplementation();
    console.log("Factory's latest implementation:", latestImpl);
    
    // Does it have the new methods?
    const impl = await ethers.getContractAt("S2SPublicationModule", latestImpl);
    
    try {
        const name = await impl.NAME();
        console.log("✅ NAME():", name);
    } catch (e) {
        console.log("❌ No NAME() function");
    }
    
    try {
        const count = await impl.getContentIdCount();
        console.log("✅ getContentIdCount():", count.toString());
    } catch (e) {
        console.log("❌ No getContentIdCount() function");
    }
    
    // Check if it has old methods
    try {
        const streamCount = await impl.getStreamIdCount();
        console.log("❌ Still has OLD getStreamIdCount():", streamCount.toString());
    } catch (e) {
        console.log("✅ Old getStreamIdCount() removed");
    }
}

check();