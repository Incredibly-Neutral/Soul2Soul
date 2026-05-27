import { uploadToPinata } from './pinata';
import SafeApiKit from '@safe-global/api-kit'
import { MetaTransactionData, OperationType } from '@safe-global/safe-core-sdk-types'
import Safe from '@safe-global/protocol-kit';
import { ethers } from 'ethers';
require('dotenv').config();

const publication = "unamore.--web.eth";
const safeAddress = "0xd065d8C47994cAC57e49785aCEE04FcA495afac4";


const main = async (filePath: string) => {

    const res = await uploadToPinata(filePath);
    const cid = res.IpfsHash;

    console.log(cid);

    // const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!);

    // const protocolKit = await Safe.init({
    //     provider: process.env.BASE_SEPOLIA_RPC_URL!,
    //     signer: process.env.PRIVATE_KEY!,
    //     safeAddress: process.env.PROTOCOL_SAFE_ADDRESS!
    // })

    // const apiKit = new SafeApiKit({
    //     chainId: 84532n
    // })



     // Als je dit doet dan op de publicatie .... 

}

// Get the file path from command line arguments
const filePath = process.argv[2];
// if (!filePath) {
//     console.error('Please provide a file path');
//     process.exit(1);
// }

main(filePath);