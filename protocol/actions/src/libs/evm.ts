import { CID } from "multiformats";
import { ALCHEMY_KEY } from "./constants";
import { PKP } from "@s2s/soul2soul-shared/lit-actions"
 
const evmSetup = (contractAddress: string, abi: any, chain: string) => {


  let provider;

  switch(chain) {

    case "ETHEREUM":
      provider = new ethers.providers.JsonRpcProvider({
      url: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      chainId: 1,
      name: "Ethereum",
    });

    break;

    case "BASE":
      provider = new ethers.providers.JsonRpcProvider({
      url: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      chainId: 8453,
      name: "Base",
    });

    break; 

   case "BASE_SEPOLIA":
      provider = new ethers.providers.JsonRpcProvider({
      url: `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      chainId: 84532,
      name: "Base Sepolia",
    });

    break; 
  }


  const contract = new ethers.Contract(
    contractAddress,
    abi,
    provider
  );

  return { provider, contract };
};

export const evmWrite = async (
  chain: string,
  pkp: PKP,
  contractAddress: string,
  abi: any,
  method: string,
  args: any[],
  confirm: boolean = false  // ← Add this parameter back
) => {

  const { provider, contract } = evmSetup(contractAddress, abi, chain);
  const pendingNonce = await provider.getTransactionCount(pkp.ethAddress, "pending");
  const txData = contract.interface.encodeFunctionData(method, args);

  const estimatedGas = await provider.estimateGas({
    to: contractAddress,
    data: txData,
    from: pkp.ethAddress,
  }).catch( (err: any) => {
    console.log("Gas estimation failed:", err.message);
    return ethers.BigNumber.from(60000);
  });

  console.log("Estimated gas:", estimatedGas.toString());

  const gasLimit = estimatedGas.mul(120).div(100);
  console.log("Gas limit (with 20% buffer):", gasLimit.toString());

  const tx = {
    to: contractAddress,
    data: txData,
    nonce: pendingNonce,
    gasLimit: gasLimit,
    maxFeePerGas: ethers.utils.parseUnits("0.15", "gwei"),
    maxPriorityFeePerGas: ethers.utils.parseUnits("0.015", "gwei"),
    chainId: 8453,
    value: 0,
    type: 2,
  };

  const unsignedTx = ethers.utils.serializeTransaction(tx);
  const msgHash = ethers.utils.keccak256(unsignedTx);
  const toSign = ethers.utils.arrayify(msgHash);

  const signature = await Lit.Actions.signAndCombineEcdsa({
    toSign,
    publicKey: pkp.publicKey.replace("0x", ""),
    sigName: `signTx`,
  });

  const s = JSON.parse(signature);

  const rFixed = "0x" + s.r.slice(-64);
  const sFixed = "0x" + s.s;
  const vFixed = Number(s.v);

  const serializedSignature = ethers.utils.joinSignature({
    r: rFixed,
    s: sFixed,
    v: vFixed,
  });

  const serializedTx = ethers.utils.serializeTransaction(
    tx,
    serializedSignature
  );

  try {
    const txResponse = await provider.sendTransaction(serializedTx);
    console.log("Transaction sent! Hash:", JSON.stringify(txResponse));
    
    // ← ADD CONFIRMATION LOGIC HERE
    if (confirm) {
      console.log("Waiting for confirmation...");
      const receipt = await txResponse.wait(1); // Wait for 1 confirmation
      console.log("Transaction confirmed! Block:", receipt.blockNumber);
      return { success: true, hash: txResponse.hash, receipt };
    }
    
    return { success: true, hash: txResponse.hash };
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    if (errMsg.includes("already known") || errMsg.includes("replacement transaction underpriced")) {
      console.log("Transaction already submitted or pending");
      return { 
        success: true, 
        message: "already_submitted",
        hash: "A transaction with this content is already in the mempool" 
      };
    }
        
    console.error("Error sending transaction:", errMsg);
    return { success: false, error: errMsg, hash: undefined };
  }
};

export const evmRead = async (
  chain: string,
  contractAddress: string,
  abi: any,
  method: string,
  args: any[]
) => {
  const { provider, contract } = evmSetup(contractAddress, abi, chain);
  return await contract[method](...args);
};

export const toHexString = (_cid: string) => {

    const cid = CID.parse(_cid);

    const contenthashBytes = new Uint8Array([
      0xe3, // ipfs-ns multicodec
      0x01, // version
      ...cid.bytes
    ]);
    
    return '0x' + Array.from(contenthashBytes)
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
}
