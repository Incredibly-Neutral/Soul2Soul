import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { LIT_NETWORK, LIT_RPC } from "@lit-protocol/constants";
import "dotenv/config";
import { providers, Wallet } from "ethers5";
import { createSessionSignatures, getProtocolInfo, getProviders, mintCapacityToken, renderwithLitActions } from "@s2s/soul2soul-shared";

const epk = process.env.PRIVATE_KEY_UNAMORE || process.env.PRIVATE_KEY || "";
const SELECTED_LIT_NETWORK = LIT_NETWORK.Datil;
const alchemy_key = process.env.ALCHEMY_KEY

const main = async () => {
  
  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY environment variable is not set");
  }

  const update = false;
  const dev = false;
  const notice = false;
  const debug = true;

  const { l1Provider, l2Provider } = await getProviders(alchemy_key)
  
  const protocolInfo = await getProtocolInfo(dev, l1Provider, l2Provider);

  const litNodeClient = new LitNodeClient({
    litNetwork: SELECTED_LIT_NETWORK,
    debug: false,
  });

  await litNodeClient.connect();

  const provider5 = new providers.JsonRpcProvider(LIT_RPC.CHRONICLE_YELLOWSTONE);
  const ethersWallet = new Wallet(epk, provider5);
  const capacityTokenId = await mintCapacityToken(ethersWallet, SELECTED_LIT_NETWORK)
  const sessionSignatures = await createSessionSignatures(litNodeClient, ethersWallet, capacityTokenId)

  const publication = "block001.soul2soul.eth";
  const authorSafeAddress = "0x04660132323Fe65C5BaF9107Cfe8a941386b4EAF"; //author!!!!
  const stream_ids = ["87119185787620437889240302547756526407722694952350143032371926081755117621597"]

  const actions = await renderwithLitActions(litNodeClient, sessionSignatures, protocolInfo, notice, authorSafeAddress, publication, stream_ids, update, dev, debug, undefined );
  console.log(actions)

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
