
import { 
  toSafeSmartAccount,
} from "permissionless/accounts";
import { createSmartAccountClient } from "permissionless";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createPublicClient, encodeFunctionData, http, keccak256, parseEther, toBytes } from "viem";
import { privateKeyToAccount  } from "viem/accounts";
import { IMainController } from "../main.ctrlr.js";
import { getChainId, getNetwork, getRPCUrl, getScanApi, getViemChainById, getViemChainByName } from "./chains.factory.js";
import { JsonRpcProvider } from "ethers";


const ENTRYPOINT_ADDRESS_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

interface InternalTransaction {
  contractAddress: string;
  from: string;
  to: string;
  value: string;
  gas: string;
  gasUsed: string;
  input: string;
  output: string;
  type: string;
  traceId: string;
}


export interface IPermissionlessSafeService {
  main: IMainController;
  chainId: number;
  signer: any;
  smartAccount: any;
  smartAccountClient: any;
  provider: any;
  address: string;

  updateSigner: (pk: string) => Promise<string>;
  connectToFreshSafe: (salt: string) => Promise<string>
  connectToExistingSafe: (safe_address: string) => Promise<string>
  genericRead: (address: string, abi: string, method: string, args: string[]) => Promise<any>;
  genericTx: (address: string, abi: string, method: string, args: string[], deploy: boolean, wait?: boolean) => Promise<string>;
  batchGenericTx: (calls: Array<{ address: string; abi: string; method: string; args: any[]; }>) => Promise<string[]>;
  valueTx: (to: string, amount: string) => Promise<string>;
  getSafeAddress: (salt: string) => Promise<string>;
  isDeployed: () => Promise<boolean>;
}

export class PermissionlessSafeService implements IPermissionlessSafeService {
  main: IMainController;
  chainId: number;
  signer: any;
  smartAccount: any;
  smartAccountClient: any;
  provider: any;
  address!: string;

  private txMutex: Promise<void> = Promise.resolve();
  private publicClient: any;
  private pimlicoClient: any;

  constructor(main: IMainController, chain: string) {
    
    this.main = main;
    this.chainId = getChainId(chain);
    // console.log("CHAIN", chain, this.chainId)
    const rpc = getRPCUrl(this.chainId, main.plugin.settings.alchemy_key);
    const network = getNetwork(this.chainId);

    this.provider = new JsonRpcProvider(rpc, network)
    
    this.publicClient = createPublicClient({
      chain: getViemChainByName(chain),
      transport: http(rpc)
    });

    this.pimlicoClient = createPimlicoClient({
      transport: http(`https://api.pimlico.io/v2/${this.chainId}/rpc?apikey=${main.plugin.settings.pimlico_key}`),
      entryPoint: {
        address: ENTRYPOINT_ADDRESS_V07,
        version: "0.7",
      },
    });
  }

  async updateSigner(pk: string) {
    this.signer = await privateKeyToAccount(pk as `0x${string}`);
    return this.signer.address;
  }
  
  async isDeployed(address?: string): Promise<boolean> {
    try {
        // Use provided address or default to current smart account address
        const checkAddress = address || this.address;
        
        if (!checkAddress) {
            console.log("No address to check");
            return false;
        }
        
        // console.log("Checking if Safe is deployed:", checkAddress);
        
        // Get the bytecode at the address
        const code = await this.publicClient.getBytecode({ 
            address: checkAddress as `0x${string}`
        });
        
        // If there's no code or just '0x', the contract is not deployed
        const deployed = code !== undefined && code !== '0x' && code.length > 2;
        
        // console.log("Safe deployment status:", deployed);
        return deployed;
        
    } catch (error: any) {
        console.error("Error checking deployment status:", error.message);
        return false;
    }
  }

  async connectToFreshSafe(salt: string) {

      const smartAccount = await toSafeSmartAccount({
        client: this.publicClient,
        owners: [this.signer],
        threshold: 1n,
        version: "1.4.1",
        saltNonce: BigInt(keccak256(toBytes(salt))),
        safeSingletonAddress: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", // SafeL2 v1.4.1 on Base
        safeProxyFactoryAddress: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"
      });

    return await this.setSafe(smartAccount);
  }

  async connectToExistingSafe(safe_address: string) {

    const smartAccount = await toSafeSmartAccount({
      client: this.publicClient,
      owners: [this.signer], 
      threshold: 1n,
      version: "1.4.1",
      address: safe_address, 
      safeSingletonAddress: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", // SafeL2 v1.4.1 on Base
      // safeProxyFactoryAddress: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"
    });

    return await this.setSafe(smartAccount);

  }

  async setSafe(smartAccount: any): Promise<string> {

    this.smartAccount = smartAccount
  
    this.smartAccountClient = await createSmartAccountClient({
      account: smartAccount,
      chain: getViemChainById(this.chainId),
      bundlerTransport: http(`https://api.pimlico.io/v2/${this.chainId}/rpc?apikey=${this.main.plugin.settings.pimlico_key}`),
      paymaster: this.pimlicoClient,
      
    });

    this.address = smartAccount.address;
    return this.address;
  }

  async getSafeAddress(salt: string): Promise<string> {

    const tempAccount = await toSafeSmartAccount({
      client: this.publicClient,
      owners: [this.signer],
      threshold: 1n,
      version: "1.4.1",
      saltNonce: BigInt(keccak256(toBytes(salt))),
    });
        
    return tempAccount.address;
  }


  async genericRead(address: string, abi: string, method: string, args: string[]): Promise<any> {
    let retries = 1;
    while (retries > 0) {
        try {
            // console.log("🔍 Reading:", method, "from", address, "with args:", args);
            
            const result = await this.publicClient.readContract({
                address: this.ensureHex(address),
                abi: JSON.parse(abi),
                functionName: method,
                args: args,
            });
            
            // console.log("📖 Read result:", result);
            return result;
        } catch (error: any) {
            retries--;
            // console.log(`❌ RPC read failed:`, error.message || error);
            if (retries === 0) throw error;
            // console.log(`Retrying... (${retries} attempts left)`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
  }

  async genericTx(address: string, abi: string, method: string, args: string[], deploy: boolean, wait = false ): Promise<string> {


    console.log("🔧 genericTx called:", { address, method, args: JSON.stringify(args) });

    const data = encodeFunctionData({
        abi: JSON.parse(abi),
        functionName: method,
        args: args,
    });

    // console.log("📝 Encoded data:", data);

    const gasPrice = await this.pimlicoClient.getUserOperationGasPrice();

    // console.log("📤 About to call sendTransaction...");
    
    const txHash = await this.smartAccountClient.sendTransaction({
        to: address as `0x${string}`,
        data,
        value: 0n,
        maxFeePerGas: gasPrice.fast.maxFeePerGas,     
        maxPriorityFeePerGas: gasPrice.fast.maxPriorityFeePerGas,
    });

    console.log("✅ sendTransaction returned txHash:", txHash, "for method:", method);
    
    
    if (wait) {
        // Wait for the actual transaction receipt (not user operation)

        await  this.publicClient.waitForTransactionReceipt({ 
            hash: txHash as `0x${string}`,
            confirmations: 1 
        });
        console.log("Transaction confirmed:", txHash);
    }

    if (!deploy) {
      // For non-deployment transactions, just return the tx hash
      return txHash;
    }

    // For deployment transactions, extract the deployed contract address
    return await this.extractDeployedAddress(txHash);
  }

  async valueTx(to: string, amount: string): Promise<string> {

    const gasPrice = await this.pimlicoClient.getUserOperationGasPrice();

    const txHash = await this.smartAccountClient.sendTransaction({
      to: to as `0x${string}`,
      value: parseEther(amount),
      maxFeePerGas: gasPrice.fast.maxFeePerGas,     
      maxPriorityFeePerGas: gasPrice.fast.maxPriorityFeePerGas
    });

    return txHash;
  }


  async batchGenericTx(calls: Array<{
      address: string;
      abi: string;
      method: string;
      args: any[];
      deploy?: boolean; // ← Add this
  }>): Promise<string[]> {
      console.log("🔧 Executing", calls.length, "transactions sequentially");
      
      const results: string[] = [];
      
      for (const call of calls) {
          let result: string;
          
          await (this.txMutex = this.txMutex.then(async () => {
              console.log("📤 Executing:", call.method);
              
              result = await this.genericTx(
                  call.address,
                  call.abi,
                  call.method,
                  call.args,
                  call.deploy ?? false, // ← Use the deploy flag from call
                  true
              );
              
              console.log("✅ Completed:", call.method, "->", result);
          }));
          
          results.push(result!);
      }
      
      return results;
  }

  private async extractDeployedAddress(txHash: string): Promise<string> {
      console.log("🔍 [START] Extracting deployed address from tx:", txHash);
      const result = await this.extractFromInternalTransactions(txHash, this.address);
      console.log("✅ [END] Extracted address:", result, "for tx:", txHash);
      return result;
  }

// ALSO WORKS WHEN SAFE DEPLOYMENT IS PART OF TX AS ITS THR SAFES FIRST 
 private async extractFromInternalTransactions(
      txHash: string, 
      safeAddress?: string
  ): Promise<string> {
      // console.log("🔄 Querying internal transactions...");
      // console.log("🔍 Safe address to filter:", safeAddress);  // ✅ ADD THIS
      // console.log("🔍 this.address:", this.address);           // ✅ ADD THIS
      
      let attempts = 0;
      const maxAttempts = 16;
      
      while (attempts < maxAttempts) {
          const response: any = await this.getInternalTransactions(
              this.chainId,
              txHash,
              this.main.plugin.settings.etherscan_key
          );
          
          const txs = Array.isArray(response) ? response : response?.result || [];
          
          if (Array.isArray(txs) && txs.length > 0) {
              const deployedContracts = txs.filter(tx => 
                  tx.contractAddress && tx.contractAddress !== ""
              );
              
              console.log("📋 Deployed contracts:", deployedContracts.length);
              deployedContracts.forEach(tx => {
                  const isSafe = tx.contractAddress.toLowerCase() === safeAddress?.toLowerCase();
                  // console.log("  -", tx.contractAddress, isSafe ? "← SAFE (filter)" : "← candidate");
              });
              
              // ✅ If only ONE deployment, return it (even if it's the Safe)
              if (deployedContracts.length === 1) {
                  // console.log("✅ Single deployment:", deployedContracts[0].contractAddress);
                  return deployedContracts[0].contractAddress;
              }
              
              // ✅ If MULTIPLE deployments, filter out Safe and return the other
              if (deployedContracts.length > 1) {
                  const nonSafeDeployment = deployedContracts.find(tx => {
                      const matches = tx.contractAddress.toLowerCase() === safeAddress?.toLowerCase();
                      // console.log(`  🔍 Checking ${tx.contractAddress}: matches safe? ${matches}`);  // ✅ ADD THIS
                      return !matches;  // Return ones that DON'T match
                  });
                  
                  if (nonSafeDeployment) {
                      // console.log("✅ Found non-Safe deployment:", nonSafeDeployment.contractAddress);
                      return nonSafeDeployment.contractAddress;
                  }
              }
          }
          
          await new Promise((resolve) => setTimeout(resolve, 3000));
          attempts++;
      }

      throw new Error("Failed to extract deployed contract address");
  }

  async getInternalTransactions(
    chainId: number, 
    txHash: string, 
    apiKey: string
    ): Promise<InternalTransaction[]> {

      const baseUrl = getScanApi(chainId);
      
      const url = `${baseUrl}&module=account&action=txlistinternal&txhash=${txHash}&apikey=${apiKey}`;

      // console.log(url)
      
      try {
          const response = await fetch(url);
          const data = await response.json();
          return data.result || [];
      } catch (error) {
          // console.error('Failed to fetch internal transactions:', error);
          return [];
      }
  }

//   private async extractAllDeployedAddresses(txHash: string): Promise<string[]> {
//     console.log("🔍 Extracting all deployed addresses from tx:", txHash);
    
//     let attempts = 0;
//     const maxAttempts = 9;
    
//     while (attempts < maxAttempts) {
//         attempts++;
        
//         const response: any = await this.getInternalTransactions(
//             this.chainId,
//             txHash,
//             this.main.plugin.settings.etherscan_key
//         );
        
//         const txs = Array.isArray(response) ? response : response?.result || [];
        
//         if (Array.isArray(txs) && txs.length > 0) {
//             const deployedAddresses = txs
//                 .filter(tx => tx.contractAddress && tx.contractAddress !== "")
//                 .map(tx => tx.contractAddress);
            
//             if (deployedAddresses.length > 0) {
//                 console.log("✅ Found", deployedAddresses.length, "deployed contracts:", deployedAddresses);
//                 return deployedAddresses;
//             }
//         }
        
//         if (attempts < maxAttempts) {
//             await new Promise(resolve => setTimeout(resolve, 3000));
//         }
//     }
    
//     throw new Error(`Failed to extract deployed addresses for tx: ${txHash}`);
// }


  // private getRPC(): string {
  //   // Your existing RPC logic
  //   return "";
  // }

    // Helper function to ensure proper 0x prefixed hex string format
  private ensureHex(value: string): `0x${string}` {
    if (!value) throw new Error("Empty value provided");
    
    // Remove any existing 0x prefix and convert to lowercase
    const cleaned = value.replace(/^0x/i, '').toLowerCase();
    
    // Validate it's a valid hex string
    if (!/^[0-9a-f]*$/.test(cleaned)) {
      throw new Error(`Invalid hex string: ${value}`);
    }
    
    return `0x${cleaned}` as `0x${string}`;
  }
}