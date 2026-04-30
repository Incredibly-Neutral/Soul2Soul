import {
  Safe4337Pack,
  UserOperationReceipt,
  IFeeEstimator,
} from "@safe-global/relay-kit";
import { ethers } from "ethers";
import { IMainController } from "src/main.ctrlr.js";
import { getInternalTransactions } from "./eth_utils.js";

export const sendTx = async (
  main: IMainController,
  relay: Safe4337Pack,
  chain: string,
  transactions: any[],
  includesDeploy: boolean,
): Promise<any> => {
  return new Promise(async (resolve, reject) => {
    console.log("Transactions:", transactions);
    let safeOperation = await relay.createTransaction({
      transactions,
      options: {
        validUntil: Math.floor(Date.now() / 1000) + 3600,
        validAfter: Math.floor(Date.now() / 1000) - 60,
      },
    });

    const identifier = ethers.keccak256(
      ethers.toUtf8Bytes(main.user.name + main.user.eoa),
    );

    // Direct access to callData (no .data)
    // safeOperation.userOperation.callData = ethers
    //   .concat([
    //     safeOperation.userOperation.callData as `0x${string}`,
    //     identifier,
    //   ])
    //   .toString();

    // const identifiedSafeOperation = await relay.getEstimateFee(safeOperation);

    const signedSafeOperation = await relay.signSafeOperation(safeOperation);

    // // Direct access to signature (no .data)
    // console.log("Signature after signing:", signedSafeOperation.signatures);

    const userOperationHash = await relay.executeTransaction({
      executable: signedSafeOperation,
    });

    let userOperationReceipt: UserOperationReceipt | null = null;

    while (!userOperationReceipt) {
      // Wait 2 seconds before checking the status again
      await new Promise((resolve) => setTimeout(resolve, 2000));
      userOperationReceipt =
        await relay.getUserOperationReceipt(userOperationHash);
    }

    const userOperationPayload =
      await relay.getUserOperationByHash(userOperationHash);

    console.log("txHash: " + userOperationPayload.transactionHash);

    // let userOperationReceipt: UserOperationReceipt | null = null;

    // while (!userOperationReceipt) {
    //   // Wait 2 seconds before checking the status again
    //   await new Promise((resolve) => setTimeout(resolve, 2000));
    //   userOperationReceipt =
    //     await relay.getUserOperationReceipt(userOperationHash);
    // }

    // const userOperationPayload =
    //   await relay.getUserOperationByHash(userOperationHash);

    // console.log("txHash: " + userOperationPayload.transactionHash);
    // // console.log(includesDeploy);

    if (includesDeploy) {
      let attempts = 0;
      const maxAttempts = 9;
      let txs: any[] = [];
      
      while (attempts < maxAttempts) {
        txs = await getInternalTransactions(
          chain,
          userOperationPayload.transactionHash,
          "6QXJHPD91YEMD1YXYKAQF2XPIU2RZVIPQ3" // chain == "SEPOLIA" ? main.plugin.settings.basescan_key : main.plugin.settings.basescan_key,
        );
        console.log(
          `Attempt ${attempts + 1}: Found ${txs.length} internal transactions`,
        );

        // console.log("txs", txs)

        if (txs.length > 0 && txs.find((tx) => tx.contractAddress != "")) {
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
        attempts++;
      }

      // console.log(txs);

      const tx = txs.find((tx) => tx.contractAddress != "");
      console.log(tx);
      resolve(tx ? tx.contractAddress : "No contract address found");
    } else {
      resolve(userOperationPayload);
    }
  });
};

// export const sendExecTx = async (
//   main: IMainController,
//   relay: Safe4337Pack,
//   transaction: any,
//   includesDeploy: boolean,
// ): Promise<any> => {
//   return new Promise(async (resolve, reject) => {
//     const safeOperation = await relay.createTransaction({
//       transactions: [transaction],
//     });
//     const identifier = ethers.keccak256(
//       ethers.toUtf8Bytes(main.user.name + main.user.eoa),
//     );
//     safeOperation.callData = ethers
//       .concat([safeOperation.callData as `0x{string}`, identifier])
//       .toString();

//     const identifiedSafeOperation = await relay.getEstimateFee({
//       safeOperation,
//     });

//     const signedSafeOperation = await relay.signSafeOperation(
//       identifiedSafeOperation,
//     );

//     const userOperationHash = await relay.executeTransaction({
//       executable: signedSafeOperation,
//     });

//     let userOperationReceipt: UserOperationReceipt | null = null;

//     while (!userOperationReceipt) {
//       // Wait 2 seconds before checking the status again
//       await new Promise((resolve) => setTimeout(resolve, 2000));
//       userOperationReceipt =
//         await relay.getUserOperationReceipt(userOperationHash);
//     }

//     const userOperationPayload =
//       await relay.getUserOperationByHash(userOperationHash);

//     console.log("txHash: " + userOperationPayload.transactionHash);

//     if (includesDeploy) {
//       let attempts = 0;
//       const maxAttempts = 5;
//       let txs: any[] = [];

//       while (attempts < maxAttempts) {
//         txs = await getInternalTransactions(
//           "BASE_SEPOLIA",
//           userOperationPayload.transactionHash,
//           main.plugin.settings.basescan_key,
//         );
//         console.log(
//           `Attempt ${attempts + 1}: Found ${txs.length} internal transactions`,
//         );

//         if (txs.length > 0 && txs.find((tx) => tx.contractAddress != "")) {
//           break;
//         }

//         // Wait for 2 seconds before next attempt
//         await new Promise((r) => setTimeout(r, 2000));
//         attempts++;
//       }

//       console.log(txs);

//       const tx = txs.find((tx) => tx.contractAddress != "");
//       console.log(tx);
//       resolve(tx ? tx.contractAddress : "No contract address found");
//     } else {
//       resolve(userOperationPayload);
//     }
//   });
// };
