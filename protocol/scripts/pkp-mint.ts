import { nagaTest } from "@lit-protocol/networks";
import { createLitClient, type LitClient } from "@lit-protocol/lit-client";
import { privateKeyToAccount, type Account } from 'viem/accounts';
import { ViemAccountAuthenticator } from '@lit-protocol/auth';
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
import dotenv from "dotenv";
import axios from "axios";
import fs from 'fs';
import FormData from  'form-data';
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { base } from "viem/chains";
import { updateProtocol } from "./update-protocol";

dotenv.config();

const dev = false;

async function main() {

  const litClient = await createLitClient({
    network: nagaTest,
  });

  const account: Account = privateKeyToAccount(
    `0x${process.env.PRIVATE_KEY}` as `0x${string}`
  );

  const authManager = createAuthManager({
    storage: storagePlugins.localStorageNode({
      appName: "s2s",
      networkName: "naga-dev",
      storagePath: "./.lit-storage", // local file path
    }),
  });

  const authData = await ViemAccountAuthenticator.authenticate(account);

  const pkp = await litClient.mintWithEoa({
    account,
  });

  const pkpInfo = pkp.data;

  console.log(pkpInfo)

  await authManager.createPkpAuthContext({
      authData, 
      pkpPublicKey: pkpInfo.pubkey, 
      authConfig: { resources: [ ["pkp-signing", "*"], ["lit-action-execution", "*"], ["access-control-condition-decryption", "*"]], 
      expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(), }, 
      litClient, 
  });

  const prepActionCid = await uploadFileToPinata("./actions/dist/prep/main.js");
  const singleActionCid = await uploadFileToPinata("./actions/dist/single/main.js");
  const cborActionCid = await uploadFileToPinata("./actions/dist/cbor/main.js");
  const rootUpdateActionCid = await uploadFileToPinata("./actions/dist/updateEvm/main.js");

  const pkpPermissionsManager = await litClient.getPKPPermissionsManager({ 
     pkpIdentifier: { tokenId: pkpInfo.tokenId.toString() }, 
     account 
  }); 

  await pkpPermissionsManager.addPermittedAction({ ipfsId: prepActionCid, scopes: ['sign-anything']}); 
  await pkpPermissionsManager.addPermittedAction({ ipfsId: singleActionCid, scopes: ['sign-anything'] }); 
  await pkpPermissionsManager.addPermittedAction({ ipfsId: cborActionCid, scopes: ['sign-anything'] }); 
  await pkpPermissionsManager.addPermittedAction({ ipfsId: rootUpdateActionCid, scopes: ['sign-anything']}); 


  // // FUNDING PKP ON BASE

  const baseClient = createWalletClient({
    account,
    chain: base,
    transport: http(process.env.BASE_RPC_URL),
  });

  const basePublicClient = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL),
  });

  const eoaBalance = await basePublicClient.getBalance({
    address: account.address,
  });

  const requiredAmount = parseEther("0.00005");

  if (eoaBalance < requiredAmount) {
    console.log(`❌ Insufficient balance: ${formatEther(eoaBalance)} ETH`);
    console.log(`   Need: ${formatEther(requiredAmount)} ETH`);
  } else {
    // Fund PKP
    const hash = await baseClient.sendTransaction({
      to: pkp.ethAddress as `0x${string}`,
      value: requiredAmount,
    });
    console.log(`✅ Funded PKP on Base: ${hash}`);
  }

  await updateProtocol(account, pkpInfo, prepActionCid, singleActionCid, cborActionCid, rootUpdateActionCid);

  console.log("FINISHED")
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });



// const mintPkpWithLitActionAuthMethod = async (
//   litContracts: LitContracts,
//   prepActionCid: string,
//   singleActionCid: string,
//   cborActionCid: string,
//   rootUpdateActionCid: string,
//   // renderActionCid: string
// ) => {
//   const mintTx =
//     await litContracts.pkpHelperContract.write.mintNextAndAddAuthMethods(
//       AUTH_METHOD_TYPE.LitAction, // keyType
//       [AUTH_METHOD_TYPE.LitAction, AUTH_METHOD_TYPE.LitAction, AUTH_METHOD_TYPE.LitAction, AUTH_METHOD_TYPE.LitAction], // permittedAuthMethodTypes
//       [
//         convertIpfsCid({ cid: prepActionCid, outputFormat: "hex" }),
//         convertIpfsCid({ cid: singleActionCid, outputFormat: "hex" }),
//         convertIpfsCid({ cid: cborActionCid, outputFormat: "hex" }),
//         convertIpfsCid({ cid: rootUpdateActionCid, outputFormat: "hex" }),
//         // convertIpfsCid({ cid: renderActionCid, outputFormat: "hex" })
//       ],
//       ["0x", "0x", "0x", "0x"], // permittedAuthMethodPubkeys
//       [[AUTH_METHOD_SCOPE.SignAnything], [AUTH_METHOD_SCOPE.SignAnything], [AUTH_METHOD_SCOPE.SignAnything], [AUTH_METHOD_SCOPE.SignAnything]], // permittedAuthMethodScopes
//       false, // addPkpEthAddressAsPermittedAddress
//       false, // sendPkpToItself
//       { value: await litContracts.pkpNftContract.read.mintCost() }
//     );
//   const mintTxReceipt = await mintTx.wait();

//   return getPkpInfoFromMintTxReceipt({
//     txReceipt: mintTxReceipt,
//     litContractsClient: litContracts,
//   });
// };

// export async function getLitActionIpfsCid({
//   input,
//   outputFormat,
// }: {
//   input: string;
//   outputFormat: "base58" | "hex";
// }): Promise<string> {
//   const base58Cid = await ipfsOnlyHash.of(input);
//   if (outputFormat === "base58") {
//     return base58Cid;
//   } else {
//     return `0x${Buffer.from(ethers5.utils.base58.decode(base58Cid)).toString(
//       "hex"
//     )}`;
//   }
// }

// export function convertIpfsCid({
//   cid,
//   outputFormat,
// }: {
//   cid: string;
//   outputFormat: "base58" | "hex";
// }): string {
//   if (outputFormat === "base58") {
//     return cid;
//   } else {
//     return `0x${Buffer.from(ethers5.utils.base58.decode(cid)).toString("hex")}`;
//   }
// }

async function uploadFileToPinata(filePath: string) {
  const url = `https://api.pinata.cloud/pinning/pinFileToIPFS`;
  const formData = new FormData();
  formData.append("file", fs.createReadStream(filePath));

  try {
    const response = await axios.post(url, formData, {
      maxBodyLength: Infinity,
      headers: {
        ...formData.getHeaders(),
        pinata_api_key: process.env.PINATA_API_KEY!.trim(),
        pinata_secret_api_key: process.env.PINATA_SECRET_API_KEY!.trim(),
      },
    });
    return response.data.IpfsHash;
  } catch (error: any) {
    if (error.response) {
      console.error("Error response:", {
        status: error.response.status,
        data: error.response.data,
      });
    }
    throw error;
  }
}

