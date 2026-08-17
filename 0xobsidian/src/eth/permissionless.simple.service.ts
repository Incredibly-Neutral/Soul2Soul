import { toSimpleSmartAccount } from "permissionless/accounts";
import { createSmartAccountClient } from "permissionless";
import { createPimlicoClient, type PimlicoClient } from "permissionless/clients/pimlico";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseEther,
  toBytes,
  Transport,
} from "viem";
import type { Chain, Hash } from "viem";

import { IMainController } from "../main.ctrlr.js";
import {
  getChainId,
  getRPCUrl,
  getViemChainById,
} from "./chains.factory.js";
import { TxOptions, TxResult } from "./tx.types.js";
import { extractDeployedAddress } from "./contract-address.factory.js";
import { privateKeyToAccount } from "viem/accounts";
import type { TypedDataSigner } from "@s2s/soul2soul-shared";
import { createGasPriceFetcher, warmUpPimlico, GasPriceResult } from "./pimlico.gas.js";

const ENTRYPOINT_ADDRESS_V07 =
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

export interface IPermissionlessSimpleService {
  main: IMainController;
  chainId: number;
  signer: any;
  smartAccount: any;
  smartAccountClient: any;
  address: `0x${string}`;

  updateSigner: (pk: string) => Promise<string>;
  signMessage: (message: string) => Promise<string>;
  signTypedData: (domain: any, types: any, message: any) => Promise<`0x${string}`>;
  connectToFreshSafe: (salt: string) => Promise<string>;
  isDeployed: () => Promise<boolean>;
  valueTx: (to: `0x${string}`, amount: string) => Promise<string>;
  write: (
    address: string,
    abi: any,
    method: string,
    args: any[],
    options?: TxOptions,
  ) => Promise<TxResult>;
  writeRaw: (
    to: string,
    data: `0x${string}`,
    options?: TxOptions,
  ) => Promise<TxResult>;
  getAddress: () => `0x${string}` | undefined;
}

export class PermissionlessSimpleService
  implements IPermissionlessSimpleService
{
  main: IMainController;
  chainId: number;
  signer: any;
  smartAccount: any;
  smartAccountClient: any;
  publicClient: any;
  pimlicoClient: PimlicoClient;
  address!: `0x${string}`;

  private readonly getGasPrice: () => Promise<GasPriceResult>;

  constructor(main: IMainController, chain: string) {
    this.main = main;
    this.chainId = getChainId(chain);

    // Uses DRPC
    const rpc = getRPCUrl(this.chainId, main.plugin.settings.rpc_key);

    this.publicClient = createPublicClient({
      chain: getViemChainById(this.chainId),
      transport: http(rpc),
    });

    this.pimlicoClient = createPimlicoClient({
      transport: http(
        `https://api.pimlico.io/v2/${this.chainId}/rpc?apikey=${main.plugin.settings.pimlico_key}`,
        { timeout: 8000 },
      ) as Transport,
      entryPoint: {
        address: ENTRYPOINT_ADDRESS_V07,
        version: "0.7",
      },
    });

    // Short-TTL gas-price cache + in-flight dedupe: N concurrent publishes
    // share ONE Pimlico request, and a recent result is reused within the TTL.
    this.getGasPrice = createGasPriceFetcher(() => this.pimlicoClient.getUserOperationGasPrice());

    // Best-effort warm-up so the first real gas-price call doesn't touch a
    // cold/stale pooled socket (intermittent TimeoutError on Base).
    warmUpPimlico(this.pimlicoClient);
  }

  async updateSigner(pk: string): Promise<string> {
    this.signer = privateKeyToAccount(pk as `0x${string}`);
    await this.connectToAccount();
    console.log("[simple] updateSigner with key →", this.signer.address);
    return this.signer.address;
  }

  private async connectToAccount(): Promise<void> {
    if (!this.signer) {
      throw new Error("connectToAccount: call updateSigner() first");
    }

    this.smartAccount = await toSimpleSmartAccount({
      client: this.publicClient,
      owner: this.signer,
      entryPoint: { address: ENTRYPOINT_ADDRESS_V07, version: "0.7" },
    });

    this.smartAccountClient = createSmartAccountClient({
      account: this.smartAccount,
      chain: getViemChainById(this.chainId),
      bundlerTransport: http(
        `https://api.pimlico.io/v2/${this.chainId}/rpc?apikey=${this.main.plugin.settings.pimlico_key}`,
      ),
      paymaster: this.pimlicoClient,
      userOperation: {
        estimateFeesPerGas: async () =>
          (await this.getGasPrice()).fast,
      },
    });

    this.address = this.smartAccount.address;
    console.log("[simple] account address:", this.address);
  }

  getAddress(): `0x${string}` | undefined {
    return this.smartAccount ? this.smartAccount.address : undefined;
  }

  /**
   * Alias for getAddress() — mirrors the safe service's connectToFreshSafe
   * so main.ctrlr.ts doesn't need method-guard branches. Simple account
   * addresses are deterministic from (owner, entrypoint); no salt concept.
   */
  async connectToFreshSafe(_salt: string): Promise<string> {
    if (!this.smartAccount) {
      throw new Error(
        "connectToFreshSafe: call updateSigner() first to create the account",
      );
    }
    return this.smartAccount.address;
  }

  /**
   * Check if the simple account is deployed (has bytecode on-chain).
   * Simple accounts are deployed on first userOp; this is informational.
   */
  async isDeployed(): Promise<boolean> {
    try {
      if (!this.address) return false;
      const code = await this.publicClient.getBytecode({
        address: this.address,
      });
      return code !== undefined && code !== "0x" && code.length > 2;
    } catch (err: any) {
      console.error("[simple] isDeployed error:", err.message);
      return false;
    }
  }

  async signMessage(message: string): Promise<string> {
    return await this.signer!.signMessage({ message });
  }

  async write(
    address: string,
    abi: any,
    method: string,
    args: any[],
    options: TxOptions = {},
  ): Promise<TxResult> {
    const {
      deploy = false,
      waitForReceipt = false,
      confirmations = 1,
      excludeAddress,
      nth,
    } = options;

    const data = encodeFunctionData({ abi, functionName: method, args });
    const gasPrice = await this.getGasPrice();

    const txHash: Hash = await this.smartAccountClient.sendTransaction({
      to: address as `0x${string}`,
      data,
      value: 0n,
      maxFeePerGas: gasPrice.fast.maxFeePerGas,
      maxPriorityFeePerGas: gasPrice.fast.maxPriorityFeePerGas,
    });

    const result: TxResult = { txHash };

    if (waitForReceipt || deploy) {
      result.receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations,
      });
    }

    if (deploy) {
      result.deployedAddress = await extractDeployedAddress(
        txHash,
        this.chainId,
        excludeAddress || "",
        nth?.toString(),
      );
    }

    return result;
  }

  async writeRaw(
    to: string,
    data: `0x${string}`,
    options: TxOptions = {},
  ): Promise<TxResult> {
    const { waitForReceipt = false, confirmations = 1 } = options;
    const gasPrice = await this.getGasPrice();

    const txHash: Hash = await this.smartAccountClient.sendTransaction({
      to: to as `0x${string}`,
      data,
      value: 0n,
      maxFeePerGas: gasPrice.fast.maxFeePerGas,
      maxPriorityFeePerGas: gasPrice.fast.maxPriorityFeePerGas,
    });

    const result: TxResult = { txHash };

    if (waitForReceipt) {
      result.receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations,
      });
    }

    return result;
  }

  async valueTx(to: `0x${string}`, amount: string): Promise<string> {
    const gasPrice = await this.getGasPrice();

    const txHash: Hash = await this.smartAccountClient.sendTransaction({
      to,
      value: parseEther(amount),
      maxFeePerGas: gasPrice.fast.maxFeePerGas,
      maxPriorityFeePerGas: gasPrice.fast.maxPriorityFeePerGas,
    });

    return txHash;
  }

  async transfer(to: string, amount: string): Promise<string> {
    return this.valueTx(to as `0x${string}`, amount);
  }

  signTypedData(
    domain: any,
    types: any,
    message: any,
  ): Promise<`0x${string}`> {
    // Signer is an EOA — signTypedData is available
    return this.signer.signTypedData({
      domain,
      types,
      message,
      primaryType: Object.keys(types)[0] || "",
    });
  }

  /**
   * Expose this service as a TypedDataSigner (adapter for buildSignedContentItem).
   * The service already has signTypedData and getAddress; this adapter
   * renames the message parameter and handles the optional address.
   */
  asTypedDataSigner(): TypedDataSigner {
    const self = this;
    return {
      signTypedData(
        domain: Record<string, unknown>,
        types: Record<string, { name: string; type: string }[]>,
        value: Record<string, unknown>,
      ): Promise<string> {
        // Extract primaryType from types keys — must be a key in the types dict.
        // viem's validateTypedData rejects undefined or empty primaryType.
        const typeKeys = Object.keys(types);
        const primaryType = typeKeys.find(k => k !== 'EIP712Domain') ?? typeKeys[0] ?? '';
        return self.signer.signTypedData({ domain, types, message: value, primaryType });
      },
      getAddress(): string {
        // The signer is the EOA (this.signer.address), not the smart account (this.address).
        // The EOA is what produces the signature, so it must be the identity.
        return self.signer?.address ?? '';
      },
    };
  }
}