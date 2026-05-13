# ABI: @s2s/0xobsidian
> Generated: 2026-05-02T10:58:53.774Z
> tsconfig: `0xobsidian/tsconfig.json`

**External deps:** obsidian, dotenv, ethers, src/main.ctrlr.js, viem/chains, ethers/providers, permissionless/accounts, permissionless, permissionless/clients/pimlico, viem, viem/accounts, ethers5, @safe-global/relay-kit, @human.tech/waap-sdk, fs, path, base-path-converter, src/types/ipld.js, electron.js, os (+20 more)

## 0xobsidian/src/
### `main.ctrlr.ts`
- 🔷 **interface** `IMainController` — { user: IOXOUser;; basePath: string;; env: { [key: string]: string | undefined };; account: { [key: string]: IPermission…
- 🟦 **class** `MainController` — init(); hasActiveUser(); hasAccounts(); initChains(chains: string[]); initChain(chain: string); newAuthor(name: string, type: string); toggleAuthor(_user: IOXOUser); safeInstance(chain: string)

### `main.ts`
- 🟦 **class** `OxO` — onload(); onunload(); loadSettings(); clearSettings(); saveSettings()

### `settings.factory.ts`
- 🟩 **function** `safeField` — (chain: string, author: IOXOUser, containerEl: HTMLElement) => {

### `settings.ts`
- 🔷 **interface** `IOxOSettings` — { authors: IOXOUser[];; updates: { [key: string]: IUpdate[] };; invites: IInvite[];; updatesIncludeMyOwn: boolean;; list…
- 🟦 **class** `OxOAuthorsTab` — display(): Promise<void>
- ⬜ **const** `DEFAULT_SETTINGS` — IOxOSettings

### `utils.ts`
- 🟩 **function** `slugify` — (text: string): string

## 0xobsidian/test/
### `setup.ts`

## 0xobsidian/src/eth/
### `base.account.service.ts`
- 🔷 **interface** `IBaseAccountService` — { main: IMainController;; chainId: number;; signer: any;; provider: any;; address: string; }
- 🟦 **class** `BaseAccountService` — (no public methods)

### `chains.factory.ts`
- 🟩 **function** `getViemChainByName` — (chainName: string)  => {
- 🟩 **function** `getViemChainById` — (id: number)  => {
- 🟩 **function** `getChainName` — (chainId: number): string => {
- 🟩 **function** `getChainId` — (chain: string): number => {
- 🟩 **function** `getNetwork` — (chainId: number)  => {
- 🟩 **function** `getRPCUrl` — (chainId: number, alchemy_key: string): string => {
- 🟩 **function** `getScanApi` — (chainId: number): string => {

### `constants.ts`
- ⬜ **const** `ACCOUNT_FACTORY_ADDRESS` — "0x000000e92D78D90000007F0082006FDA09BD5f11"

### `eth_utils.ts`
- 🟩 **function** `blockTime` — async (block_number: string, provider: JsonRpcProvider) : Promise<string> =>  {
- 🟩 **function** `getInternalTransactions` — async (chain: string,txHash: string, token: string) : Promise<any[]> => {

### `nft_abi.ts`
- ⬜ **const** `nft_abi` — [

### `permissionless.safe.service.ts`
- 🔷 **interface** `IPermissionlessSafeService` — { main: IMainController;; chainId: number;; signer: any;; smartAccount: any;; smartAccountClient: any;; provider: any;; …
- 🟦 **class** `PermissionlessSafeService` — updateSigner(pk: string); isDeployed(address?: string): Promise<boolean>; connectToFreshSafe(salt: string); connectToExistingSafe(safe_address: `0x${string}`); setSafe(smartAccount: any): Promise<`0x${string}`>; getSafeAddress(salt: string): Promise<`0x${string}`>; genericRead(address: `0x${string}`, abi: string, method: string, args: string[]): Promise<any>; genericTx(address: `0x${string}`, abi: string, method: string, args: string[], deploy: boolean, wait = false): Promise<string>; valueTx(to: `0x${string}`, amount: string): Promise<string>; batchGenericTx(calls: Array<{
      address: `0x${string}`;
      abi: string;
      method: string;
      args: any[];
      deploy?: boolean; // ← Add this
  }>): Promise<string[]>; getInternalTransactions(chainId: number, txHash: string, apiKey: string): Promise<InternalTransaction[]>

### `provider.factory.ts`
- 🟩 **function** `getProvider` — (
- 🟩 **function** `getRPC` — (chain: string, alchemy_key: string): string => {

### `safe_factory.abi.ts`
- ⬜ **const** `SAFE_FACTORY_ABI` — any[]

### `safe_implementation.abi.ts`
- ⬜ **const** `SAFE_IMPLEMENTATION_ABI` — any[]

### `tx.factory.ts`
- 🟩 **function** `sendTx` — async (

### `waap.service.ts`
- 🔷 **interface** `IWaapService` — { login: () => Promise<void> }
- 🟦 **class** `WaapService` — initWaap(); login()

## 0xobsidian/src/helpers/
### `retries.ts`
- 🟩 **function** `withRetry` — async <T>(

### `timeout.ts`
- 🟩 **function** `callWithTimeout` — async <T>(

## 0xobsidian/src/ipfs/
### `formdata.ts`
- 🟩 **function** `directoryFormData` — (sourcePath: string): Promise<any>
- 🟩 **function** `singleFileFormData` — (filename: string, content: Buffer): Promise<any>
- 🟩 **function** `singleFileFormDataFromPath` — (filePath: string): any
- 🟩 **function** `directoryFormDataStream` — (sourcePath: string): Promise<any>
- 🟩 **function** `assembleFormData` — (assets: any[]): Promise<any>

### `ipfs.ctrlr.ts`
- 🔷 **interface** `IpfsCtrlr` — { add: (note: string, ipfs_endpoint: string) => Promise<string>;; addFile: (path: string, ipfs_endpoint: string) => Prom…
- ⬜ **const** `ipfsController` — IpfsCtrlr

### `ipld.factory.ts`
- 🟩 **function** `podToDag` — async (app: App, folderPath: string) : Promise<string> => {
- 🟩 **function** `formatNote` — async (app: App, file: TFile) => {
- 🟩 **function** `parseFrontMatter` — async (app: App, file: TFile) : Promise<{[key:string]:any}> => {
- 🟩 **function** `isolateBody` — (content: string) => {

### `pin.factory.ts`
- 🟩 **function** `pinFile` — async (path: any): Promise<string> => {

### `pinata.ctrlr.ts`
- 🟦 **class** `PinataService` — upload(filePath: string, onlyHash: boolean = false): Promise<string>; fetchUrl(url: string): Promise<{ data: Buffer; contentType?: string }>; getContentType(fileExt: string, mimeType?: string): string; pinCidFromRemote(cid: string, remote: string): Promise<boolean>; uploadFileFromUrl(url: string, onlyHash: boolean = false, cid_version: number = 0): Promise<string>; uploadFileFromContent(filePath: string, data: string, onlyHash: boolean = false): Promise<string>; uploadDirectoryStructure(files: Array<{ path: string; content: any }>, options?: any): Promise<any>

### `pinata.factory.ts`
- 🟩 **function** `calculateIPFSHash` — async (filePath: string): Promise<string> => {
- 🟩 **function** `calculateIPFSHashFromContent` — async (content: string | Buffer, fileName?: string, contentType: string = 'application/octet-stream'): Promise<string> =…
- 🟩 **function** `upload` — async(main: MainController, filePath: string, onlyHash: boolean = false): Promise<string> => {

### `remotekubo.service.ts`
- 🟩 **function** `addRecursive` — async (
- 🟩 **function** `addAsFolder` — async (
- 🟩 **function** `getJsonLike` — async (
- 🟩 **function** `getRecursive` — async (
- 🟩 **function** `add` — async (
- 🟩 **function** `addFile` — async (
- 🟩 **function** `addFileFromUrl` — async (
- 🟩 **function** `pinFile` — async (
- 🟩 **function** `dagPut` — async (
- 🟩 **function** `dagGet` — async (
- 🟩 **function** `getFile` — async (
- 🟩 **function** `addFormData` — async (
- 🟩 **function** `addFilesInDir` — async (

## 0xobsidian/src/lens/
### `lens.ctrlr.ts`
- 🟦 **class** `LensService` — auth(mode?: string); lensUsername(); getAddress(); checkProfile(); registerProfile(user: any)

## 0xobsidian/src/lit/
### `_lit.service.ts`
- 🟦 **class** `LitService` — init(); getAuthContext(); runAction(action_cid: string, params: any); encryptWithUcc(content: string, unifiedAccessControlConditions: any[]); encryptWithAcc(content: string, conditions: any[])

### `lit.service.ts`
- 🟦 **class** `LitService` — getChainConfig(); getActionCid(code: string): Promise<string>; createPkp(); listPKPInGroup(groupId: number); listAllPKPs(); createGroup(name: string, description?: string, pkpIds?: string[], cidHashes?: string[]); registerAction(cid: string, name: string): Promise<{ success: boolean; hashedCid: string }>; addActionToGroup(groupId: number, actionCid: string); addPkpToGroup(groupId: number, pkpId: string); createUsageKey(params: { executeInGroups: number[] }); removeUsageKey(usageKey: string); executeAction(poolId: string, code: string, jsParams: Record<string, unknown> = {}, key: string | undefined = undefined); encrypt(key: string, pkpId: string, message: string): Promise<string>; decrypt(key: string, pkpId: string, ciphertext: string, userAddress: string, signature: string, action: string): Promise<string>

## 0xobsidian/src/paymaster/
### `constants.ts`
- ⬜ **const** `ENTRYPOINT_ADDRESS` — "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"

### `paymaster.factory.ts`
- 🟩 **function** `paymasterAddress` — (chain: string) => {
- 🟩 **function** `checkPaymasterBalance` — async (entrypoint: ethers.Contract, address: string) : Promise<boolean> => {
- 🟩 **function** `logPaymasterBalance` — async (entrypoint: ethers.Contract, address: string)  => {

## 0xobsidian/src/types/
### `ipld.ts`
- 🔷 **interface** `IpldNote` — { body: string,; path: string,; slug: string,; title: string,; [key:string] : any }
- 🔷 **interface** `IpldLink` — { [key:string] : string }
- 🔷 **interface** `IpldPod` — { Links: IpldLink[] }

### `oxo.ts`
- 🔷 **interface** `IUpdate` — { accepted: boolean,; block_number: string,; datetime: string,; cid: string,; contract: string,; from: string,; name: st…
- 🔷 **interface** `IInvite` — { accepted: boolean,; block_number: string,; datetime: string,; cid: string,; contract: string,; from: string,; name: st…

### `sg.ts`
- 🔷 **interface** `SGContentItem` — { args: string,; author: string,; categories: string[],; content: string,; creation_date: string,; modified_date: string…
- 🔷 **interface** `SGTask` — { author: string,; payload: any,; post_type: string,; publication: string,; slug: string }

## 0xobsidian/src/user/
### `author.modal.ts`
- 🟦 **class** `AuthorModal` — onOpen(); onClose()

### `ens.ts`

### `user.ts`
- 🔷 **interface** `IPKPInfo` — { name: string;; tokenId: string;; publicKey: string; }
- 🔷 **interface** `IOXOUser` — { name: string,; active: boolean,; eoa: string,; private_key: string,; lens: string | undefined,; safe: string | undefin…
- 🟦 **class** `OXOUser` — _generatePK(); __address(privateKey: string); setSafeAddress(safe: string); checkLensProfile(main: IMainController); addLensAccount(main: IMainController)

## 0xobsidian/src/ipfs/multi-part-lite-adopted/
### `main.js`
- 🟦 **class** `MultipartLite` — [init](); [generate](field, value, { filename, contentType }); getLength(cb); getBoundary(); getHeaders(chunked = true); append(field, value, options = {}); stream(); buffer()

## 0xobsidian/src/lit/actions/
### `encrypt.ts`
- ⬜ **const** `encryptAction` — `

## 0xobsidian/src/ipfs/multi-part-lite-adopted/lib/
### `combine.js`
- 🟦 **class** `CombinedStream` — _append(...data); _read(); [forward](); [next](); [nextStream](stream); destroy(e)
