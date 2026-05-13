# ABI: @s2s/neutralpress
> Generated: 2026-05-02T10:58:53.775Z
> tsconfig: `neutralpress/tsconfig.json`

**External deps:** obsidian, @s2s/soul2soul-shared, slugify, marked, crypto, viem, electron, src/main.ctrlr, turndown, @lens-protocol/metadata, @lens-chain/storage-client, @lens-protocol/client, path

## neutralpress/src/
### `main.ctrlr.ts`
- 🔷 **interface** `IMainController` — { basePath: string;; plugin: DSG;; oxo: any;; content: ContentController;; preview: PreviewCtrlr;; publications: any;; p…
- 🟦 **class** `MainController` — newPublication(tagName: string, file: TFile); previewNote(_file: TAbstractFile); grantLicense(_file: TAbstractFile); revokeLicense(subdomain: string, _file: TAbstractFile): Promise<void>; isValidForPublishing(file: TFile | null): file is TFile; getInitializedService(subdomain: string); publishToPublication(file: TFile, contentId: string, publicContent: any, toEncrypt: any, publication: string); proposeContent(_file: TAbstractFile); renderCalls(publication: string, streamIds: string[]); bulkrender(post_type: string, ensName: string, pubContract: string)

### `main.ts`
- 🟦 **class** `DSG` — colourTags(); extractTags(meta: CachedMetadata | null): string[]; getStreamID(meta: CachedMetadata | null): string; onload(); onunload(); loadSettings(); saveSettings()

### `preview.ctrlr.ts`
- 🟦 **class** `PreviewCtrlr` — display(html: string): Promise<void>; renderHTML(stream_id: string, publication: string): Promise<string>; injectStylesheet(url: string)

### `protocol.abi.ts`
- ⬜ **const** `protocolABI` — [

### `settings.ts`
- 🔷 **interface** `Settings` — { dev: boolean;; data_gateway: string;; arbiscan_key: string;; basescan_key: string;; publications: S2SPublication[];; c…
- 🟦 **class** `DSGSettingsTab` — display(): void
- ⬜ **const** `DEFAULT_SETTINGS` — Settings

## neutralpress/src/content/
### `content.ctrlr.ts`
- 🔷 **interface** `IContentController` — { main: IMainController; storeNoteOnLens : (file: TFile, contentId: string, publicContent: S2SPublicContent, toEncrypt: …
- 🟦 **class** `ContentController` — encryptContent(oxoCtrlr: any, contentId: string, publicationModule: string, toEncrypt: any): Promise<string>; storeNoteOnLens(file: TFile, contentId: string, publicContent: S2SPublicContent, toEncrypt: S2SToEncrypt, subdomain: string); extractTitleAndBase(raw: string, title: string): [string, string | undefined, string | undefined]; slug(title: string): string; removeCodeBlocks(text: string); removeMarkdownImages(text: string); skipDefault(fmcopy: Record<string, any>): Record<string, any>

### `images.ts`
- 🟩 **function** `distributeImages` — async (

## neutralpress/src/factories/
### `lens.factory.ts`
- 🟩 **function** `postToLens` — async (user: any, lens: any, item: any, publicationFeed: string) => {
- 🟩 **function** `updateToLens` — async (user: any, lens: any, item: any, streamId: string) => {

### `note.factory.ts`
- 🟩 **function** `slug` — (title: string): string => {
- 🟩 **function** `parseNote` — async (
- 🟩 **function** `distributeImages` — async (
- 🟩 **function** `followLink` — async (
- 🟩 **function** `saveRoot` — async (
- 🟩 **function** `saveRootDirectly` — async (
- 🟩 **function** `includeUrl` — async (

## neutralpress/src/publication/
### `abi.ts`
- ⬜ **const** `safeAbi` — [
- ⬜ **const** `publicationAbi` — [

### `config.ts`
- 🟩 **function** `uploadConfig` — async (
- 🟩 **function** `createConfig` — (

### `ens.ts`
- 🟩 **function** `isAvailableEnsName` — async (
- 🟩 **function** `getPublicationMultiSig` — async (main: IMainController, subdomain: string) => {

### `github.ts`
- 🟩 **function** `getGitHubFiles` — async (owner: string, repo: string, branch: string, path: string = ""): Promise<any[]> => {
- 🟩 **function** `getAllFilesRecursive` — async (owner: string, repo: string, branch: string, path: string = ""): Promise<any[]>  => {
- 🟩 **function** `getLatestCommitSHA` — async (publication: any) => {
- 🟩 **function** `fetchFileFromGithub` — async (url: string): Promise<string> => {

### `new.modal.ts`
- 🟦 **class** `NewPublicationModal` — onOpen(ensName?: string); onClose()

### `new.ts`
- 🟩 **function** `newPublicationSafe` — async (

### `publication.service.ts`
- 🔷 **interface** `IPublicationSrv` — { main: IMainController;; new: ( main: IMainController, name: string, owners: string[], authors: string[], devRepository…
- 🟦 **class** `PublicationService` — init(); new(main: IMainController, ensName: string, owners: string[], authors: string[], devRepository: string, branch: string); grantLicense(stream_id: string); revokeLicense(stream_id: string); isLicensed(stream_id: string); isLicensedBatch(stream_ids: string[]): Promise<Record<string, boolean>>; getMultiSig(); getPublicationMultiSigAddresses(tags: string[]); getModuleAdresses(); getPublicationFeedAddress()

## neutralpress/src/ui/
### `domain.modal.ts`
- 🟦 **class** `DomainModal` — onOpen(); onClose()

### `revoke.modal.ts`
- 🟦 **class** `RevokeModal` — onOpen(); onClose(publication?: string)
