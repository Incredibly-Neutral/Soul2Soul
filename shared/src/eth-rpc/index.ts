// import { createPublicClient, http } from 'viem';
// import { mainnet, base } from 'viem/chains';

// export const getProviders = async (alchemy_key: string) => {

//     const rpc = `https://eth-mainnet.g.alchemy.com/v2/${alchemy_key}`;
    
//     const l1Provider = createPublicClient({
//         chain: mainnet,
//         transport: http(rpc)
//     });

//     const rpc2 = `https://base-mainnet.g.alchemy.com/v2/${alchemy_key}`;
    
//     const l2Provider = createPublicClient({
//         chain: base,
//         transport: http(rpc2)
//     });

//     return { l1Provider, l2Provider };
// }
