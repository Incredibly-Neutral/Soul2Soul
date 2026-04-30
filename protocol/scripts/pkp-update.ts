import { nagaTest } from "@lit-protocol/networks";
import { createLitClient, type LitClient } from "@lit-protocol/lit-client";
import { privateKeyToAccount, type Account } from 'viem/accounts';
import dotenv from "dotenv";
import axios from "axios";
import fs from 'fs';
import FormData from  'form-data';
import { updateActions } from "./update-protocol";

dotenv.config();

const dev = false;

async function main() {

  const litClient = await createLitClient({
    network: nagaTest,
  });

  const account: Account = privateKeyToAccount(
    `0x${process.env.PRIVATE_KEY}` as `0x${string}`
  );

  const pkpInfo = {
    tokenId: 85114906815462184742768363226412480142813533400558362552861740619065102786819n,
    pubkey: '0x04dcde57e74a14a7507494e2db9d28489343b33c9227351b4fb91f8a97c8f5d9ea1797fa5330f497bd20b06d52d86c999f5040d20cd2e33d586ecc3e09465c98db',
    ethAddress: '0x6A5E01791551Ac47CDAD4aA796E74F492c11c66C'
  }

  console.log(pkpInfo)

  // check if changed ?? 

  const prepActionCid = await uploadFileToPinata("./actions/dist/prep/main.js");
  const singleActionCid = await uploadFileToPinata("./actions/dist/single/main.js");
  console.log('-')
  const cborActionCid = await uploadFileToPinata("./actions/dist/cbor/main.js");
  const rootUpdateActionCid = await uploadFileToPinata("./actions/dist/updateEvm/main.js");

  console.log(0)

  const pkpPermissionsManager = await litClient.getPKPPermissionsManager({ 
    pkpIdentifier: { tokenId: pkpInfo.tokenId.toString() }, 
    account 
  }); 

  console.log(1)
  
  await pkpPermissionsManager.addPermittedAction({ ipfsId: prepActionCid, scopes: ['sign-anything']}); 
  await pkpPermissionsManager.addPermittedAction({ ipfsId: singleActionCid, scopes: ['sign-anything'] });
  await pkpPermissionsManager.addPermittedAction({ ipfsId: cborActionCid, scopes: ['sign-anything'] }); 
  await pkpPermissionsManager.addPermittedAction({ ipfsId: rootUpdateActionCid, scopes: ['sign-anything']}); 

  console.log("b4txs")

  await updateActions(account, prepActionCid, singleActionCid, cborActionCid, rootUpdateActionCid);

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

