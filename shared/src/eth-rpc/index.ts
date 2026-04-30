import * as ethers from 'ethers';

export const getProviders = async (alchemy_key: string) => {

    const rpc = `https://eth-mainnet.g.alchemy.com/v2/${alchemy_key}`;
    const network = { name: "ethereum", chainId: 1 }; 

    const l1Provider = new ethers.JsonRpcProvider(rpc, network)

    const rpc2 = `https://base-mainnet.g.alchemy.com/v2/${alchemy_key}`;
    const network2 = { name: "base", chainId: 8453 }; 

    const l2Provider = new ethers.JsonRpcProvider(rpc2, network2)

    return { l1Provider, l2Provider }
}