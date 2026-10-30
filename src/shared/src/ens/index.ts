import { ensRegistryABI, resolverABI } from './abi';
import { PublicClient, getContract } from 'viem';
import { namehash as viemNamehash } from 'viem/ens';

const ENSREGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as `0x${string}`;

export const getContractAddressFromEnsName = async (
  ensName: string,
  viemProvider: PublicClient
) => {
  try {
    const node = viemNamehash(ensName);

    const registry = getContract({
      address: ENSREGISTRY,
      abi: ensRegistryABI,
      client: viemProvider,
    });

    const resolverAddress = (await registry.read.resolver([
      node,
    ])) as `0x${string}`;

    const resolver = getContract({
      address: resolverAddress,
      abi: resolverABI,
      client: viemProvider,
    });

    return (await resolver.read.text([node, 'contract.address'])) as string;
  } catch (error) {
    console.error('Error getting contract address:', error);
    return 'false';
  }
};
