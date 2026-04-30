// import { ENTRYPOINT_ADDRESS } from "./constants.js";
// import { ethers } from "ethers";
// import { IMSCAService } from "../eth/msca_service.js";
// import { paymasterAddress } from "./paymaster.factory.js";
// import { getRPC } from "../eth/provider.factory.js";

// export const eth_salt = () => {
//     return ethers.toBigInt(ethers.randomBytes(32));
// }

// export const eth_fixed_salt = () => {
//     return "82713067786997665706895799707315602316482679773042431943929829195857031311336";
// }

// export const zeroEth = () => {
//     return ethers.parseUnits("0", "gwei");
// }

// // export const create_init_code = async (userService: ISafeService | IMSCAService, contract_address: string, function_data: string) => {

// //     const eoa = await userService.signer.getAddress();
// //     const salt = eth_fixed_salt();

// //     let initCode = contract_address + function_data;
// //     // ethService.accountFactory.interface.encodeFunctionData("createAccount",[salt,[eoa]])
// //     // .slice(2);


// //     // do you need this?? 
// //     let msca;
// //     try {
// //         msca = await userService.entrypoint.getSenderAddress(initCode)
// //     } catch(ex) {
// //         if(ex.data == undefined) {
// //             console.log(ex);
// //         }
// //         msca = '0x' + ex.data.slice(-40);
// //     }
// //     const code = await userService.provider.getCode(msca)
// //     if (code !== "0x") {
// //         initCode = "0x";
// //     }

// //     return {
// //         initCode,
// //         msca: ethers.getAddress(msca)
// //     }
// // }

// // export const formatUserOp = async (ethService: IEthService, sender: string, initCode: string, target: string, callData: string, token: string) : Promise<any> => {

// //     const callDataUserOp = ethService.smartAccount.interface.encodeFunctionData("execute",[target, zeroEth(), callData]);

// //     let userOp: any =  {
// //         sender: sender, 
// //         nonce: "0x" + (await ethService.entrypoint.getNonce(sender, 0)).toString(16),
// //         initCode,
// //         callData: callDataUserOp,
// //         paymasterAndData: PAYMASTER_ADDRESS,
// //         signature: "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c"
// //     }

// //     // console.log(userOp);

// //     const { preVerificationGas, verificationGasLimit, callGasLimit} =  await estimateUserOpGas(userOp, ENTRYPOINT_ADDRESS, token);

// //     const { maxFeePerGas } = await ethService.provider.getFeeData();
// //     const maxPriorityFeePerGas = await rundler_maxPriorityFeePerGas(token);

// //     userOp.callGasLimit = callGasLimit;
// //     userOp.verificationGasLimit = verificationGasLimit;
// //     userOp.preVerificationGas = preVerificationGas;
// //     userOp.maxFeePerGas = maxFeePerGas != null ? "0x" + maxFeePerGas.toString(16) : "0x";
// //     userOp.maxPriorityFeePerGas = maxPriorityFeePerGas;

// //     const userOpHash = await ethService.entrypoint.getUserOpHash(userOp);
// //     userOp.signature = await ethService.signer.signMessage(ethers.getBytes(userOpHash));

// //     return userOp;
// // }

// export const userOp = async (userService: ISafeService | IMSCAService, sender: string, initCode: string, callData: string, chain: string) : Promise<any> => {

//     const pm = ethers.getAddress(paymasterAddress(chain) || "0x");
//     const rpc = getRPC(chain, userService.main.plugin.settings.alchemy_key);

//     let userOp: any =  {
//         sender: sender, 
//         nonce: "0x0" + (await userService.entrypoint.getNonce(sender, 0)).toString(16),
//         initCode,
//         callData,
//         paymasterAndData: pm,
//         signature: "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c"
//     }

//     const { preVerificationGas, verificationGasLimit, callGasLimit} =  await estimateUserOpGas(userOp, ENTRYPOINT_ADDRESS, rpc);

//     const { maxFeePerGas } = await userService.provider.getFeeData();
//     const maxPriorityFeePerGas = await rundler_maxPriorityFeePerGas(rpc);

//     console.log(callGasLimit);

//     userOp.callGasLimit = callGasLimit;
//     userOp.verificationGasLimit = verificationGasLimit;
//     userOp.preVerificationGas = preVerificationGas;
//     userOp.maxFeePerGas = maxFeePerGas != null ? "0x" + maxFeePerGas.toString(16) : "0x";
//     userOp.maxPriorityFeePerGas = maxPriorityFeePerGas;

//     const userOpHash = await userService.entrypoint.getUserOpHash(userOp);
//     userOp.signature = await userService.signer.signMessage(ethers.getBytes(userOpHash));

//     return userOp;
// }


// export const rundler_maxPriorityFeePerGas = async (rpc: string) : Promise<any> =>  {

//     return new Promise( (resolve, reject) : any => {
    
//         const options = {
//             method: 'POST',
//             headers: {accept: 'application/json', 'content-type': 'application/json'},
//             body: JSON.stringify({
//                 id: 1,
//                 jsonrpc: '2.0',
//                 method: 'rundler_maxPriorityFeePerGas',
//             })
//         };
      
//         fetch(rpc, options)
//             .then(response => response.json())
//             .then(response => resolve(response.result))
//             .catch(err => {
//                 console.error(err); 
//                 reject()
//             });

//     });
// }

// export const estimateUserOpGas = async (userOp: any, entrypoint: string, rpc: string) : Promise<any> =>  {

//     console.log(entrypoint);
//     console.log(rpc);

//     return new Promise( (resolve, reject) : any => {
    
//         const options = {
//             method: 'POST',
//             headers: {accept: 'application/json', 'content-type': 'application/json'},
//             body: JSON.stringify({
//                 id: 1,
//                 jsonrpc: '2.0',
//                 method: 'eth_estimateUserOperationGas',
//                 params: [
//                     userOp,
//                     entrypoint
//                 ]
//             })
//         };
      
//         fetch(rpc, options)
//             .then(response => response.json())
//             .then(response => {

//                 if(response.result == undefined || response.result.callGasLimit == undefined){
//                     console.log(response);
//                 }   
//                 resolve(response.result)
//              })
//             .catch(err => {
//                 console.error(err); 
//                 reject()
//             });

//     });
// }

// export const sendUserOperation = async (userOp: any, contract_address: string, rpc: string) : Promise<any> =>  {

//     return new Promise( (resolve, reject) : any => {
    
//         const options = {
//             method: 'POST',
//             headers: {accept: 'application/json', 'content-type': 'application/json'},
//             body: JSON.stringify({
//               id: 1,
//               jsonrpc: '2.0',
//               method: 'eth_sendUserOperation',
//               params: [
//                 userOp,
//                 contract_address
//               ]
//             })
//         };
          
//         fetch(rpc, options)
//             .then(response => response.json())
//             .then(response => {
//                // "invalid 1st argument: userOperation invalid user operation fields"
//                 // console.log(response);
//                 resolve(response.result)
//             })
//             .catch(err => console.error(err));
//     });
// }

// export const getUserOperationByHash = async (ops: string[], token: string) : Promise<any> =>  {

//     return new Promise( (resolve, reject) : any => {

//         const options = {
//             method: 'POST',
//             headers: {accept: 'application/json', 'content-type': 'application/json'},
//             body: JSON.stringify({
//               id: 1,
//               jsonrpc: '2.0',
//               method: 'eth_getUserOperationByHash',
//               params: ops
//             })
//           };
          
//         fetch(`https://arb-sepolia.g.alchemy.com/v2/${token}`, options)
//             .then(response => response.json())
//             .then(response => {
//                 console.log(response);
//                 resolve(response.result)
//             })
//             .catch(err => console.error(err));
//     });
// }

// export const getResponse = async (opHash: string, token: string) : Promise<void>=> {

//     return new Promise((resolve, reject) => {
//         const interval = setInterval(async () => {
//             try {
//                 const { transactionHash } = await getUserOperationByHash([opHash], token)
//                 console.log(transactionHash);
//                 if(transactionHash != null) {
//                     resolve()
//                     clearInterval(interval);
//                 } 
//             } catch (err) {
//                 // console.log("within interval: " + err)
//                 reject
//             } 
//         }, 1000);
//     });
// }
