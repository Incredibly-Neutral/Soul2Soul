import { evmRead } from './evm';

const ENS_REGISTRY_ADDRESS = "0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5";

export const getProtocolControllerAndModules = async () => {

     try {
  
        const subdomainNode = ethers.utils.namehash("soul2soul.eth");
        const nameWrapperAddress = await evmRead("ETHEREUM", ENS_REGISTRY_ADDRESS, ["function nameWrapper() view returns (address)"], "nameWrapper", []);
        const customRegistry = await evmRead("ETHEREUM", nameWrapperAddress, ["function ownerOf(uint256 id) view returns (address)"], "ownerOf", [subdomainNode])
        const controller = await evmRead("ETHEREUM", customRegistry, ["function parentDomainController() view returns (address)"], "parentDomainController", [])
        const modules = await evmRead("BASE", controller, ["function getModulesPaginated(address start, uint256 pageSize) view returns (address[] memory array, address next)"], "getModulesPaginated", [ "0x0000000000000000000000000000000000000001", 10])
        
        let configModule = null;

        for (const moduleAddress of modules[0]) {
            try {
          
                const name = await evmRead("BASE", moduleAddress, ["function NAME() view returns (string)"], "NAME", [] )
                
                if (name === "S2S Records Module") {
                    configModule = moduleAddress;
                } 

            } catch (error) {
                // Module doesn't have NAME function, skip
                // console.log(`Module ${moduleAddress} has no NAME function`);
            }
        }

        return {
            multisig : controller,
            configModule,
         
        };

    } catch (error) {
        console.error("Error getting publication addresses:", error);
        return {
            multisig: null,
            configModule: null,
        };
    }
}

export const getDomainOwnerAndModules = async (publication: string) => {

    return JSON.parse(await LitActions.runOnce({
        waitForResponse: true,
        name: `protocol-${publication}`
    }, async () => { 

        const nameWrapperAddress = await evmRead("ETHEREUM", ENS_REGISTRY_ADDRESS, ["function nameWrapper() view returns (address)"], "nameWrapper", []);
        const subdomainNode = await ensNameToNode(publication, ENS_REGISTRY_ADDRESS)
        const multisig = await evmRead("ETHEREUM", nameWrapperAddress, ["function ownerOf(uint256 id) view returns (address)"], "ownerOf", [subdomainNode]);

        const [modules]  = await evmRead("BASE", multisig, ["function getModulesPaginated(address start, uint256 pageSize) view returns (address[] memory array, address next)"], "getModulesPaginated", ["0x0000000000000000000000000000000000000001",10]);

        let configModule = null;
        let publicationModule = null;

        const moduleNames = await Promise.allSettled(
            modules.map(( addr: string) => 
                evmRead("BASE", addr, ["function NAME() view returns (string)"], 'NAME', [])
            )
        );

        for (let i = 0; i < modules.length; i++) {
            const result = moduleNames[i];
            if (result.status === 'fulfilled') {
                if (result.value === "S2S Records Module") {
                    configModule = modules[i];
                } else if (result.value === "S2S Publication Module") {
                    publicationModule = modules[i];
                }
            }
        }

        return JSON.stringify({
            multisig,
            configModule,
            publicationModule
        });
    }))
}

const ensNameToNode = async (ensName: string, en_registry_address: string) => {

    const parts = ensName.split('.');
    const subdomain = parts[0]; // e.g., "fly61" from "fly61.soul2soul.eth"

    const parentNode = await evmRead("ETHEREUM", en_registry_address, ["function parentNode() view returns (bytes32)"], "parentNode", []);
    
    const subdomainLabel = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(subdomain));
    return ethers.utils.keccak256(
        ethers.utils.concat([
            ethers.utils.arrayify(parentNode),
            ethers.utils.arrayify(subdomainLabel)
        ])
    );
}


      