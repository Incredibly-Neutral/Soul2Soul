// import { expect } from 'chai';
// import { describe, it, beforeEach } from 'mocha';
// import { ethers } from 'ethers';
// import { config } from 'dotenv';
// import { resolve } from 'path';
// import { IMainController } from '../../src/main.ctrlr.js';
// import { ISafeService } from '../../src/eth/safe_service.js';
// import { SafeService } from '../../src/eth/safe_service.js';
// import { IOXOUser } from '../../src/user/user.js';
// import { IMSCAService } from '../../src/eth/msca_service.js';
// import { IpfsCtrlr } from '../../src/ipfs/ipfs.ctrlr.js';
// import { IOrbisService } from '../../src/orbis/orbis.service.js';
// import OxO from '../../src/main.js';
// import { PluginSettingTab } from 'obsidian';
// import { LitAAService } from 'src/lit/lit-aa-service.js';

// // Load test environment variables
// config({ path: resolve(process.cwd(), '.env.test') });

// // Test constants
// const TEST_PRIVATE_KEY = '0x1234567890123456789012345678901234567890123456789012345678901234';
// const TEST_EOA = '0x1234567890123456789012345678901234567890';
// const TEST_CHAIN = '534351'; // Base Sepolia
// const TEST_CONTRACT = '0x1234567890123456789012345678901234567890';
// const TEST_ABI = ['function balanceOf(address) view returns (uint256)'];

// // Mock provider that returns dummy values
// const mockProvider = {
//     getNetwork: async () => ({ chainId: TEST_CHAIN }),
//     getBalance: async () => ethers.parseEther('1'),
//     call: async () => '0x0000000000000000000000000000000000000000000000000000000000000000',
//     estimateGas: async () => ethers.parseEther('0.001'),
//     getGasPrice: async () => ethers.parseEther('0.00001'),
//     getBlockNumber: async () => 1,
//     getBlock: async () => ({ timestamp: Math.floor(Date.now() / 1000) }),
//     on: () => {},
//     removeListener: () => {},
//     waitForTransaction: async () => ({ status: 1 })
// };

// // Mock Safe4337Pack for relay tests
// const mockRelay = {
//     protocolKit: {
//         getAddress: async () => TEST_EOA,
//         connect: async () => ({
//             getAddress: async () => TEST_EOA
//         })
//     },
//     relayPack: {
//         getAddress: async () => TEST_EOA
//     }
// };

// describe('SafeService Integration Tests', () => {
//     let safeService: ISafeService;
//     let mockMain: IMainController;

//     beforeEach(async () => {
//         // Setup mock main controller with all required properties
//         mockMain = {
//             user: {
//                 name: 'Test User',
//                 active: true,
//                 eoa: TEST_EOA,
//                 private_key: TEST_PRIVATE_KEY,
//                 msca: undefined,
//                 safe: undefined,
//                 pkps: [],
//                 deployMSCA: async () => {},
//                 setSafeAddress: () => {},
//                 addPKP: () => {}
//             } as IOXOUser,
//             basePath: '/test/path',
//             env: {
//                 ALCHEMY_KEY: process.env.TEST_ALCHEMY_KEY || 'test_key',
//                 PIMLICO_KEY: process.env.TEST_PIMLICO_KEY || 'test_key',
//                 // ARBISCAN_KEY: process.env.TEST_ARBISCAN_KEY || 'test_key',
//                 // BASESCAN_KEY: process.env.TEST_BASESCAN_KEY || 'test_key',
//                 // PINATA_API_KEY: process.env.TEST_PINATA_API_KEY || 'test_key',
//                 // PINATA_SECRET_KEY: process.env.TEST_PINATA_SECRET_KEY || 'test_key',
//                 // PINATA_JWT: process.env.TEST_PINATA_JWT || 'test_key'
//             },
//             msca: {} as IMSCAService,
//             evm: {} as {[key: string]: ISafeService},
//             safe: {} as ISafeService,
//             ipfs: {} as IpfsCtrlr,
//             lit: {},
//             litAA: {} as LitAAService,
//             orbis: {} as IOrbisService,
//             plugin: {
//                 settings: {
//                     alchemy_key: 'test_key',
//                     pimlico_key: 'test_key'
//                 },
//                 authorsTab: {},
//                 updatesTab: {},
//                 ctrlr: {} as IMainController,
//                 onload: async () => {},
//             } as OxO,
//             init: async () => {},
//             initChains: async (chains: string[]) => {},
//             initChain: async (chain: string) => {},
//             newAuthor: async () => {},
//             toggleAuthor: async () => {},
//             mintPKP: async () => {},
//             mintAuthorPKP: async () => {},
//             mintPublicationPKP: async () => {}
//         } as IMainController;

//         safeService = new SafeService(mockMain, mockProvider as any);
        
//         // Mock the relay methods
//         safeService.setRelay = async (chain: string, eoa: string) => {
//             return mockRelay as any;
//         };

//         safeService.setActiveRelay = async (chain: string, eoa: string) => {
//             safeService.relay = mockRelay as any;
//             const address = await mockRelay.protocolKit.getAddress();
//             safeService.address = address;
//             return mockRelay as any;
//         };
        
//         safeService.getAddress = async (chain: string, eoa: string) => {
//             const relay = await safeService.setRelay(chain, eoa);
//             return relay.protocolKit.getAddress();
//         };
//     });

//     describe('Signer Management', () => {
//         it('should update signer with new private key', async () => {
//             const newPrivateKey = '0x9876543210987654321098765432109876543210987654321098765432109876';
//             const expectedAddress = new ethers.Wallet(newPrivateKey).address;
//             safeService.updateSigner(newPrivateKey);
//             expect(safeService.signer).to.exist;
//             expect(await safeService.signer.getAddress()).to.equal(expectedAddress);
//         });
//     });

//     describe('Relay Management', () => {
//         it('should set active relay for chain and EOA', async () => {
//             await safeService.setActiveRelay(TEST_CHAIN, TEST_EOA);
//             expect(safeService.relay).to.exist;
//             expect(safeService.address).to.equal(TEST_EOA);
//         });

//         it('should get address for chain and EOA', async () => {
//             await safeService.setActiveRelay(TEST_CHAIN, TEST_EOA);
//             const address = await safeService.getAddress(TEST_CHAIN, TEST_EOA);
//             expect(address).to.exist;
//             expect(address).to.equal(TEST_EOA);
//         });
//     });

//     describe('Contract Interactions', () => {
//         it('should perform generic read operation', async () => {
//             const result = await safeService.genericRead(
//                 TEST_CONTRACT,
//                 JSON.stringify(TEST_ABI),
//                 'balanceOf',
//                 [TEST_EOA]
//             );
//             expect(result).to.exist;
//         });

//         it('should perform generic transaction', async () => {
//             const result = await safeService.genericTx(
//                 TEST_CONTRACT,
//                 JSON.stringify(TEST_ABI),
//                 'transfer',
//                 [TEST_EOA, ethers.parseEther('1').toString()],
//                 false
//             );
//             expect(result).to.exist;
//         });
//     });
// });
