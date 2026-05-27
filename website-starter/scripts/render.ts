import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { LIT_ABILITY, LIT_NETWORK, LIT_RPC } from "@lit-protocol/constants";
import * as ethers from "ethers";
import { ethers as ethers5, Wallet as Wallet5, providers } from "ethers5";
import "dotenv/config";
import { LitContracts } from "@lit-protocol/contracts-sdk";
import {
  LitPKPResource,
  LitActionResource,
  createSiweMessageWithRecaps,
  generateAuthSig,
} from "@lit-protocol/auth-helpers";
import { uploadToPinata } from "./pinata";
import { clearFolder } from "./fs";
import { downloadHTML } from "./ipfs";
import { getProtocolInfo } from "./protocol";
import { LocalConfigBuilder } from "./local-config-builder";

const STREAM_IDS = [
  "87119185787620437889240302547756526407722694952350143032371926081755117621597",
];
const publication = "block001.soul2soul.eth";
const authorSafeAddress = "0x04660132323Fe65C5BaF9107Cfe8a941386b4EAF";

const epk = process.env.PRIVATE_KEY_UNAMORE || process.env.PRIVATE_KEY || "";
const SELECTED_LIT_NETWORK = LIT_NETWORK.Datil;

const main = async () => {
  const protocolInfo: any = await getProtocolInfo();

  const builder = new LocalConfigBuilder(
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiI0MzNhYjNkMS02YTZjLTQzMGUtODhkZC03Yzc0Y2MyZmQzMDkiLCJlbWFpbCI6ImpvZXJhQGpvZXJhbXVsZGVycy5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwicGluX3BvbGljeSI6eyJyZWdpb25zIjpbeyJkZXNpcmVkUmVwbGljYXRpb25Db3VudCI6MSwiaWQiOiJOWUMxIn1dLCJ2ZXJzaW9uIjoxfSwibWZhX2VuYWJsZWQiOmZhbHNlLCJzdGF0dXMiOiJBQ1RJVkUifSwiYXV0aGVudGljYXRpb25UeXBlIjoic2NvcGVkS2V5Iiwic2NvcGVkS2V5S2V5IjoiNDdlMTk2ZDI2ODNjMzNhMWJmNDUiLCJzY29wZWRLZXlTZWNyZXQiOiI4MjE0NDY0YTAyOTlmMmE1OGU4MzcwNWI4NWYxNTNjMTQ1Mzc2YWY3ODc1N2ZjOWI5NTM3YjBjNWFiZGQyNWY0IiwiZXhwIjoxNzc1MDU1NTAyfQ.PnFMDGxYGbzfqFjcENNgSEi393Pi5qE0ebZPOBEJUVk',
    'https://neutralpress.mypinata.cloud',
    'https://ipfs.transport-union.dev'
  );

  const { config, cid: configCid } = await builder.buildConfig(publication,"");

  console.log("render_action", config.render_action);

  const litNodeClient = new LitNodeClient({
    litNetwork: SELECTED_LIT_NETWORK,
    debug: false,
  });

  await litNodeClient.connect();
  const provider5 = new providers.JsonRpcProvider(LIT_RPC.CHRONICLE_YELLOWSTONE);
  const ethersWallet = new Wallet5(epk, provider5);

  console.log(ethersWallet)

  let capacityTokenId: string = "";
  if (!process.env.CAPACITY_TOKEN_ID) {
    const litContracts = new LitContracts({
      signer: ethersWallet,
      network: SELECTED_LIT_NETWORK,
    });
    await litContracts.connect();

    capacityTokenId = (
      await litContracts.mintCapacityCreditsNFT({
        requestsPerKilosecond: 10,
        daysUntilUTCMidnightExpiration: 1,
      })
    ).capacityTokenIdStr;

    console.log("Capacity token ID:", capacityTokenId);
  } else {
    capacityTokenId = process.env.CAPACITY_TOKEN_ID!;
  }

  const { capacityDelegationAuthSig } =
    await litNodeClient.createCapacityDelegationAuthSig({
      dAppOwnerWallet: ethersWallet,
      capacityTokenId,
      delegateeAddresses: [ethersWallet.address],
      uses: "1",
    });

  const sessionSignatures: any = await litNodeClient.getSessionSigs({
    chain: "yellowstone",
    capabilityAuthSigs: [capacityDelegationAuthSig],
    expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(), // 24 hours
    resourceAbilityRequests: [
      {
        resource: new LitPKPResource("*"),
        ability: LIT_ABILITY.PKPSigning,
      },
      {
        resource: new LitActionResource("*"),
        ability: LIT_ABILITY.LitActionExecution,
      },
    ],
    authNeededCallback: async ({
      resourceAbilityRequests,
      expiration,
      uri,
    }) => {
      const toSign = await createSiweMessageWithRecaps({
        uri: uri!,
        expiration: expiration!,
        resources: resourceAbilityRequests!,
        walletAddress: ethersWallet.address,
        nonce: await litNodeClient.getLatestBlockhash(),
        litNodeClient,
      });

      return await generateAuthSig({
        signer: ethersWallet,
        toSign,
      });
    },
  });
  try {
    const action: any = await litNodeClient.executeJs({
      sessionSigs: sessionSignatures,
      ipfsId: protocolInfo.lit_action_main,
      jsParams: {
        authorSafeAddress,
        publication,
        stream_ids: STREAM_IDS,
        config_cid: configCid,
        publish: true,
        dev: true,
      },
    });

    console.log(action)

    console.log(action.logs);

    const response = JSON.parse(action.response);

    console.log("res", response)

    if (response.cborRootCid) {
      const folder = "./html";
      clearFolder(folder);
      await downloadHTML(response.cborRootCid, folder);
    }
  } catch (error) {
    console.error("Error deploying action:", error);
  }
};

main()
  .then(() => {
    console.log("Action executed successfully");
  })
  .catch((error) => {
    console.error("Error executing action:", error);
  })
  .finally(() => {
    process.exit(0);
  });
