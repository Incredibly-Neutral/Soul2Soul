# ABI: @s2s/soul2soul-shared
> Generated: 2026-05-02T10:58:53.776Z
> tsconfig: `shared/tsconfig.json`

**External deps:** viem, viem/ens, viem/chains, @lens-protocol/metadata, @lens-chain/storage-client, @lens-protocol/client, zod

## shared/src/content/
### `types.ts`
- 🔷 **interface** `S2SPublicContent` — { creationDate: number,; modifiedDate: number,; language: string,; parent: number,; position: number,; postType: string,…
- 🔷 **interface** `S2SToEncrypt` — { content: string,; custom: string,; title: string,; slug: string }
- 🔷 **interface** `S2SContentItem` — { encrypted: string }

## shared/src/contracts/
### `ens.ts`
- ⬜ **const** `registrarABI` — [
- ⬜ **const** `nameWrapperABI` — [
- ⬜ **const** `resolverABI` — [
- ⬜ **const** `ensRegistryABI` — [
- ⬜ **const** `ensSubdomainRegistryAbi` — [
- ⬜ **const** `ensRecordsAbi` — [{"inputs":[{"internalType":"address","name":"initialOwner","type":"address"}],"stateMutability":"nonpayable","type":"co…

### `publication_module_factory.ts`
- ⬜ **const** `publicationModuleFactoryAbi` — [{"inputs":[],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"interna…

### `publication_module_implementation.ts`
- ⬜ **const** `publicationModuleAbi` — [{"inputs":[],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[],"name":"InvalidAuthorAddress","type":"er…

### `records_module_factory.ts`
- ⬜ **const** `recordsModuleFactoryAbi` — [{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"safe","type":"address"},{"indexed":true,"…

### `records_module_implementation.ts`
- ⬜ **const** `recordsModuleAbi` — [

### `safe_factory.ts`
- ⬜ **const** `safeFactoryAbi` — [{"inputs":[{"internalType":"address","name":"_proxyFactory","type":"address"},{"internalType":"address","name":"_single…

### `safe_implementation.ts`
- ⬜ **const** `safeAbi` — [{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"owner","type":"address"}],"name":"AddedOw…

## shared/src/ens/
### `abi.ts`
- ⬜ **const** `ensRegistryABI` — [
- ⬜ **const** `resolverABI` — [

### `index.ts`
- 🟩 **function** `getContractAddressFromEnsName` — async (

## shared/src/eth-rpc/
### `index.ts`
- 🟩 **function** `getProviders` — async (alchemy_key: string) => {

## shared/src/ipfs/
### `index.ts`
- 🟦 **class** `S2SIPFSMethods` — fetchFromKubo(cid: string): Promise<any>; addToKubo(fileContent: string, name: string, onlyHash?: boolean): Promise<string>; dagPut(fileContent: string, name: string): Promise<string>; uploadToPinata(content: string | Blob, filename: string): Promise<string>; fixEndpoint(endpoint: string)

## shared/src/lens/
### `index.ts`
- 🟩 **function** `postToLens` — async (user: any, lens: any, item: any, publicationFeed: string) => {
- 🟩 **function** `updateToLens` — async (user: any, lens: any, item: any, streamId: string) => {
- 🟩 **function** `fetchAuthorInfo` — async (lensId: string) => {

## shared/src/lit/
### `acc.ts`
- 🟩 **function** `canRead` — (
- 🟩 **function** `canPublish` — (authorSafeAddress: string, publicationModule: string) => [

## shared/src/metadata/
### `types.ts`
- 🔷 **interface** `S2SContentInfo` — { author?: { lens: string; address: string; createdAt?: string; // Lens profile creation timestamp };; publisher?: { ens…

## shared/src/pin/
### `index.ts`
- 🟩 **function** `pinCidFromRemote` — async (cid: string, remote: string, pinata_jwt: string): Promise<boolean> => {

## shared/src/protocol/
### `constants.ts`
- ⬜ **const** `ENS_NAMEWRAPPER` — "0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401"

### `index.ts`
- 🔶 **type** `ViemProvider` — PublicClient
- 🟩 **function** `getProtocolInfo` — async (
- 🟩 **function** `tokenIDFromBytes` — (bytes: string): string => {
- 🟩 **function** `publicKeyFromBytes` — (bytes: string): string => {
- 🟩 **function** `getRecords` — async (
- 🟩 **function** `getProtocolControllerAndModules` — async (

### `types.ts`
- 🔷 **interface** `PKP` — { tokenId: string;; publicKey: string;; ethAddress: string; }
- 🔷 **interface** `S2SProtocolInfo` — { addr: string | undefined,; recordsModule: string,; dataGateway: string,; assetsGateway: string,; lensApp: string,; ens…

## shared/src/publication/
### `config-builder.ts`
- 🟦 **class** `S2SConfigBuilder` — parseGitHubUrl(githubUrl: string): { owner: string; repo: string; branch: string }; getGitHubFiles(owner: string, repo: string, branch: string, path: string = ""): Promise<GitHubFile[]>; fetchGitHubFile(downloadUrl: string): Promise<string>; getAllFilesRecursive(owner: string, repo: string, branch: string, path: string = ""): Promise<GitHubFile[]>; getLatestCommitSHA(owner: string, repo: string, branch: string): Promise<string>; uploadFromUrl(url: string): Promise<string>; insertStylesheetLink(templateContent: string, cid: string): string; insertAssetImageCids(templateContent: string, assets: Array<{ path: string; cid: string }>): string; buildConfig(github_account: string, repo: string, branch: string, publicationName: string, contractAddress: string, existingConfigCid?: string): Promise<{ config: S2SPublicationConfig; cid: string }>

### `index.ts`
- 🟩 **function** `getPublicationBySubdomain` — (subdomain: string) => {

### `types.ts`
- 🔶 **type** `S2SPublicationConfig` — {
    assets: S2SAsset[],
    assetsGateway: string,
    contract: string,
    dataGateway: string,
    mapping: S2SMapp…
- 🔶 **type** `S2SAsset` — {
    path: string,
    cid: string
}
- 🔶 **type** `S2SPublication` — {
    name: string,
    owners: string[],
    authors: string[],
    contract?: string,
    configCid?: string, // ipfs …

### `validation.ts`
- 🟩 **function** `validateConfig` — (config: S2SPublicationConfig): void => {
- 🟩 **function** `validateMapping` — (templateConfig: S2STemplateConfig, rippleConfigs: S2SRipple[]): void => {
- 🟩 **function** `validateProtocol` — (protocol: any): void => {
- 🟩 **function** `validateBody` — (body: any): void => {

## shared/src/rendering/
### `index.ts`
- 🟩 **function** `renderwithLitActions` — async (litNodeClient: any, authContext: any, protocolInfo: S2SProtocolInfo, notice: any, authorSafeAddress: string, publ…

### `types.ts`
- 🔷 **interface** `S2SBody` — { id: string;; author: string;; content?: string;; locale: string;; parent: string;; position: string;; postType: string…
- 🔷 **interface** `S2STemplateData` — { id: string;; controller: string;; tags: string[];; parent: number;; language: string;; position: number;; encrypted: s…
- 🔷 **interface** `S2SCollection` — { source: string;; query: any;; filters?: any[];; key: string;; value: string;; slug: string; }
- 🔷 **interface** `S2SRipple` — { origins: string[];; destination: string;; reference: string;; query: any; }
- 🔷 **interface** `S2STemplateConfig` — { reference: string;; file: string;; path: string;; collections?: S2SCollection[]; }
- 🔷 **interface** `IMapping` — { templateConfig: S2STemplateConfig[];; ripples: S2SRipple[]; }
- 🔷 **interface** `S2SJob` — { id: string;; templateConfig: S2STemplateConfig;; path?: string;; templateData?: S2STemplateData;; html?: string;; revo…
