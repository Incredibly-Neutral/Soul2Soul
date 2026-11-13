// Gates — the RULES live in @s2s/soul2soul-shared/gates; this file is the
// adapter that binds them to this action runtime's EVM interface.
//
// Two things are Lit-specific and therefore stay here:
//   - `evmRead` (./evm) — the action-scoped chain interface, including the RPC
//     list handling and the L1/L2 split
//   - `extractSignerAddress` — uses the `ethers` v5 global that the Lit Action
//     runtime injects; it is a signature utility, not a gate
//
// Call signatures are unchanged so existing callers and their mocks keep
// working; what moved is the decision logic.
//
// Note userAddress is added as a parameter since :userAddress was a Lit placeholder for the connected wallet — you'll need to pass that explicitly now.

import { evmRead } from './evm';
import {
    canPublish as gateCanPublish,
    canRead as gateCanRead,
    canReset as gateCanReset,
    canReview as gateCanReview,
    isOutOfForce as gateIsOutOfForce,
    isOwnerAt as gateIsOwnerAt,
    resolveAuthorModules as gateResolveAuthorModules,
    type AuthorModules,
    type GateRead,
    type GateValueRead,
} from '@s2s/soul2soul-shared/gates';

export const extractSignerAddress = (messageHash: string, signature: string): string => {
    return ethers.utils.recoverAddress(messageHash, signature);
};

/** Bind the injected GateRead to this runtime's evmRead (L2 + optional RPC list). */
const bindRead = (rpcs?: string[]): GateRead => (target, abi, fn, args) =>
    evmRead('L2', target, abi, fn, args, rpcs);

/**
 * The same binding for the gate's value reads. `evmRead` answers `unknown`
 * (contract tuples and uints come back as ethers shapes the gate narrows), so
 * the declared return is what the gate expects, not what the runtime knows.
 */
const bindValueRead = (rpcs?: string[]): GateValueRead => (target, abi, fn, args) =>
    evmRead('L2', target, abi, fn, args, rpcs);

export const canRead = (
    contentId: string,
    safeAddress: string,
    publicationModule: string,
    signerAddress: string,
    rpcs: string[],
): Promise<boolean> =>
    gateCanRead(
        bindRead(rpcs),
        bindValueRead(rpcs),
        contentId,
        safeAddress,
        publicationModule,
        signerAddress,
    );

export const canPublish = (
    authorSafeAddress: string,
    publicationModule: string,
    signerAddress: string,
    rpcs?: string[],
): Promise<boolean> =>
    gateCanPublish(bindRead(rpcs), authorSafeAddress, publicationModule, signerAddress);

export const canReview = (
    contentId: string,
    publicationModule: string,
    signerAddress: string,
    rpcs?: string[],
): Promise<boolean> =>
    gateCanReview(bindRead(rpcs), contentId, publicationModule, signerAddress);

export const canReset = (
    multisig: string,
    signerAddress: string,
    rpcs?: string[],
): Promise<boolean> =>
    gateCanReset(bindRead(rpcs), multisig, signerAddress);

/**
 * Is this genesis out of force on this publication? `genesis` is already
 * bytes32 — the caller normalises, this gate hashes nothing.
 */
export const isOutOfForce = (
    genesis: string,
    publicationModule: string,
    rpcs?: string[],
): Promise<boolean> =>
    gateIsOutOfForce(bindRead(rpcs), genesis, publicationModule);

/**
 * Which two modules this author Safe runs. The decrypt action needs the answer
 * rather than a verdict: it reads the drafts log and the owner history itself.
 */
export const resolveAuthorModules = (
    authorSafe: string,
    rpcs?: string[],
): Promise<AuthorModules> =>
    gateResolveAuthorModules(bindRead(rpcs), bindValueRead(rpcs), authorSafe);

/**
 * Was `who` an owner of `safe` at `blockNumber`? No block is the present tense;
 * a block above 0 needs the Safe's `ownerHistory` module to judge against.
 */
export const isOwnerAt = (
    safe: string,
    who: string,
    blockNumber: number | undefined,
    ownerHistory: string | undefined,
    rpcs?: string[],
): Promise<boolean> =>
    gateIsOwnerAt(bindRead(rpcs), safe, who, blockNumber, ownerHistory);
