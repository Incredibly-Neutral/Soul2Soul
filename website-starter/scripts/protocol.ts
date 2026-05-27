import { namehash } from "ethers";


import { getContractAddress } from "./ens";
import * as ethers from "ethers";

interface PKP {
  tokenId: string;
  publicKey: string;
  ethAddress: string;
}

const ALCHEMY_KEY = process.env.ALCHEMY_KEY;
const IPFS_URL = process.env.IPFS_URL;

const ENS_NAMEWRAPPER = "0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401"

export const getProtocolInfo = async (dev = false) => {
  
  try {
    const ensName = dev ? "dev.soul2soul.eth" : "soul2soul.eth";

    const { multisig, configModule } = await getProtocolControllerAndModules();

    const [ assets_gateway, data_gateway, ens_records, lens_app, lit_action_main, lit_action_root_update, pkp_tokenId, pkp_publicKey, pkp_ethAddress ] = await getRecords(configModule, ["assets_gateway","data_gateway","ens_records","lens_app","lit_action_main","lit_action_root_update","pkp_tokenId","pkp_publicKey","pkp_ethAddress"]);

    return {
      addr: multisig,
      recordsModule: configModule,
      data_gateway: data_gateway,
      assets_gateway: assets_gateway,
      lens_app: lens_app,
      ens_records: ens_records,
      pkp: {
        ethAddress: pkp_ethAddress,
        publicKey: pkp_publicKey,
        tokenId: pkp_tokenId
      },
      lit_action_main: lit_action_main,
      lit_action_root_update: lit_action_root_update
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log("Protocol info error:", errorMsg);
    return {};
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

export const getRecords = async (moduleAddress: string, keys: string[]) => {


      const l2Provider = new ethers.JsonRpcProvider(
          `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
          { chainId: 8453, name: "base" }
      );

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
          l2Provider
      );

    return await module.getRecords(keys);
}

export const getProtocolControllerAndModules = async () => {
    try {
        const l1Provider = new ethers.JsonRpcProvider(
            `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
            { chainId: 1, name: 'ethereum' }
        );

        const l2Provider = new ethers.JsonRpcProvider(
            `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
            { chainId: 8453, name: "base" }
        );

        const nameWrapper = new ethers.Contract(
            ENS_NAMEWRAPPER,
            [
                "function ownerOf(uint256 id) view returns (address)"
            ],
            l1Provider
        );
        
        const subdomainNode = namehash("soul2soul.eth");
        const customRegistryContract = await nameWrapper.ownerOf(subdomainNode);

        const registry = new ethers.Contract(
            customRegistryContract,
            [
                "function parentDomainController() view returns (address)"
            ],
            l1Provider
        );

        const controller = await registry.parentDomainController();


        console.log("Publication Safe (multisig):", controller.target);

        // 5. Get modules from the Safe
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
        
        console.log("Modules found:", modules);

        // 6. Identify modules by checking for NAME constant
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
                console.log(`Module ${moduleAddress} NAME:`, name);
                
                if (name === "S2S Records Module") {
                    configModule = moduleAddress;
                } else if (name === "S2S Publication Module") {
                    publicationModule = moduleAddress;
                }
            } catch (error) {
                // Module doesn't have NAME function, skip
                console.log(`Module ${moduleAddress} has no NAME function`);
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
