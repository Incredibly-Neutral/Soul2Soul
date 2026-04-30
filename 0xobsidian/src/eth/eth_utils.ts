import { JsonRpcProvider } from "ethers/providers";

export const blockTime = async (block_number: string, provider: JsonRpcProvider) : Promise<string> =>  {

    const block = await provider.getBlock(block_number);
    if (block != null) {
        const blockTime = new Date(block.timestamp * 1000); 
        return blockTime.toLocaleDateString('nl') + " " + blockTime.toLocaleTimeString('nl'); //   toLocaleDateTimeString('nl')
    } else {
        return '-'
    }
}

export const getInternalTransactions = async (chain: string,txHash: string, token: string) : Promise<any[]> => {

    const ETHERSCAN_ENDPOINTS = {
        SEPOLIA: 'https://api-sepolia.etherscan.io/api',
        MAINNET: 'https://api.etherscan.io/api',
        POLYGON: 'https://api.polygonscan.com/api',
        BASE_SEPOLIA: 'https://api-sepolia.basescan.org/'
    };

    return new Promise( (resolve, reject) : any => {

        let url = `${ETHERSCAN_ENDPOINTS[chain]}?module=account&action=txlistinternal&txhash=${txHash}&apikey=${token}`;

        console.log(url)
    
        fetch(url)
            .then(response => response.json())  
            .then(response => {
                resolve(response.result)
            })
            .catch(err => console.error(err));

    });
}