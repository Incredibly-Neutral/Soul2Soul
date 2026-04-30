import { namehash } from "ethers";
import * as ethers from "ethers";
import { S2SProtocolInfo, PKP } from "./types";
import { ENS_NAMEWRAPPER } from "./constants";

export {S2SProtocolInfo, PKP}; 

export const getProtocolInfo = async (dev = false, l1Provider: ethers.Provider, l2Provider: ethers.Provider) : Promise<S2SProtocolInfo> => {
  
  try {

    const { multisig, configModule } = await getProtocolControllerAndModules(dev, l1Provider, l2Provider);

    const [ assets_gateway, data_gateway, ens_records, lens_app, lit_action_prep, lit_action_single, lit_action_cbor, lit_action_root_update, pkp_tokenId, pkp_publicKey, pkp_ethAddress ] = await getRecords(configModule, ["assets_gateway","data_gateway","ens_records","lens_app","lit_action_prep", "lit_action_single", "lit_action_cbor", "lit_action_root_update","pkp_tokenId","pkp_publicKey","pkp_ethAddress"], l2Provider);

    return  {
      addr: multisig || "",
      recordsModule: configModule,
      dataGateway: data_gateway,
      assetsGateway: assets_gateway,
      lensApp: lens_app,
      ensRecords: ens_records,
      pkp: {
        ethAddress: pkp_ethAddress,
        publicKey: pkp_publicKey,
        tokenId: pkp_tokenId
      },
      litActionPrep: lit_action_prep,
      litActionCbor: lit_action_cbor,
      litActionSingle: lit_action_single,
      litActionRootUpdate: lit_action_root_update
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log("Protocol info error:", errorMsg);
    throw error;
  }
};

export const tokenIDFromBytes = (bytes: string): string => {
  // I Doubt this can actualy be done .. and probably we wont need it anyway
  return "";
};

export const publicKeyFromBytes = (bytes: string): string => {
  return ethers.hexlify(bytes);
};

export const addressFromBytes = (
  publicKeyBytes: Uint8Array | string,
): string => {
  const pubKeyHex = ethers.hexlify(publicKeyBytes);

  const uncompressedKey = pubKeyHex.startsWith("0x04")
    ? pubKeyHex.slice(4)
    : pubKeyHex.replace(/^0x/, "");

  const hash = ethers.keccak256("0x" + uncompressedKey);
  const rawAddress = "0x" + hash.slice(-40);
  return ethers.getAddress(rawAddress);
};

export const getRecords = async (moduleAddress: string, keys: string[], ethersProvider: ethers.Provider ) => {

  const module = new ethers.Contract(
        moduleAddress,  
        [
            {"inputs": [
    {
      "internalType": "string[]",
      "name": "keys",
      "type": "string[]"
    }
  ],
  "name": "getRecords",
  "outputs": [
    {
      "internalType": "string[]",
      "name": "values",
      "type": "string[]"
    }
  ],
  "stateMutability": "view",
  "type": "function" }
        ],
        ethersProvider
    );

  return await module.getRecords(keys);
}

export const getProtocolControllerAndModules = async (dev: boolean, l1Provider: ethers.Provider, l2Provider: ethers.Provider) => {
    
    try {
    
        const ensName = dev ? "dev.soul2soul.eth" : "soul2soul.eth";

        const nameWrapper = new ethers.Contract(
            ENS_NAMEWRAPPER,
            [
                "function ownerOf(uint256 id) view returns (address)"
            ],
            l1Provider
        );
        
        const subdomainNode = namehash(ensName);
        const customRegistryContract = await nameWrapper.ownerOf(subdomainNode);

        const registry = new ethers.Contract(
            customRegistryContract,
            [
                "function parentDomainController() view returns (address)"
            ],
            l1Provider
        );

        const controller = await registry.parentDomainController();

        const safe = new ethers.Contract(
            controller,
            [
                "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] memory array, address next)"
            ],
            l2Provider
        );
        
        const [modules] = await safe.getModulesPaginated(
            "0x0000000000000000000000000000000000000001", // sentinel
            10
        );
        
        let configModule = null;
        let publicationModule = null;

        for (const moduleAddress of modules) {
            try {
                const module = new ethers.Contract(
                    moduleAddress,
                    ["function NAME() view returns (string)"],
                    l2Provider
                );
                
                const name = await module.NAME();
                // console.log(`Module ${moduleAddress} NAME:`, name);
                
                if (name === "S2S Records Module") {
                    configModule = moduleAddress;
                } else if (name === "S2S Publication Module") {
                    publicationModule = moduleAddress;
                }
            } catch (error) {
                // Module doesn't have NAME function, skip
                // console.log(`Module ${moduleAddress} has no NAME function`);
            }
        }

        return {
            multisig : controller,
            configModule,
            publicationModule
        };

    } catch (error) {
        console.error("Error getting publication addresses:", error);
        return {
            multisig: null,
            configModule: null,
            publicationModule: null
        };
    }
}
