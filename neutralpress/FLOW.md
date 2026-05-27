# FLOW: NeutralPress Publication Workflow

## Debugging-Ready Method Call Sequence
*(Trigger: user creates a new publication via Obsidian command)*

---

## 1. Plugin Init Sequence
*(Trigger: NeutralPress plugin loads)*

1. **MainController constructor()**
   - Sets `this.plugin`
   - Creates `this.preview = new PreviewCtrlr(this)`
   - Creates `this.content = new ContentController(this)`
   - Initializes `this.publications = {}` (cache of active PubService instances)
   - Calls `this.initializeOxo()`

2. **MainController.initializeOxo()**
   - Waits up to 10s for `plugin.app.plugins.plugins["oxo-core"]` to load
   - Checks for active user via `oxo.ctrlr.hasActiveUser()`
   - If no active user → **init ends here** (user needs to select account manually)
   - If active user → calls `oxo.ctrlr.initChains(["ETH_MAINNET", "BASE"])`
   - On success → calls `getProtocolInfo(dev, L1_PUBLIC_CLIENT, L2_PUBLIC_CLIENT)` → stores in `this.protocolInfo`
   - **Chain init complete.**

---

## 2. New Publication Trigger
*(Trigger: user invokes "Create new publication" command in Obsidian)*

1. **MainController.newPublication(tagName, file)**
   - Derives `ensName` = `tagName.toLowerCase().replace("--s2s", "") + ".soul2soul.eth"`
   - Derives `subdomain` = `ensName.split(".")[0]`
   - **Case A: Subdomain already exists** (`this.publications[subdomain]`)
     - Calls `this.grantLicense(file)` → returns
   - **Case B: Name is already taken** (`!isAvailable`)
     - Calls `this.publications[subdomain].init()` → fetches existing multisig/config/modules
     - **Returns after fetching config only** (existing publication loaded)
   - **Case C: Name is available** (`isAvailable`)
     - Creates `this.publications[subdomain] = new PublicationService(this, subdomain)`
     - Opens `NewPublicationModal` for user to fill in:
       - Name, GitHub repo, branch, owners, authors
     - On submit → calls `this.publications[subdomain].new(...)` → see section 3

2. **isAvailableEnsName(main, tagName)**
   - Extracts `label` from `tagName.replace("--s2s", "")`
   - Calls `L1.genericRead(ens_registry, abi, "isSubdomainAvailable", [label])`

3. **getPublicationMultiSig(main, subdomain)**
   - Reads `nameWrapper` and `parentNode` from `ens_registry` contract
   - Computes `subdomainLabel = keccak256(toBytes(subdomain))`
   - Computes `subdomainNode = keccak256(parentNode + subdomainLabel)`
   - Calls `nameWrapper.ownerOf(subdomainNode)` → returns manager address
   - Returns `{ addr: manager, chainId: 1 }`

---

## 3. New Publication Creation (Modal Path)
*(Trigger: user submits NewPublicationModal with details)*

1. **PublicationService.new(main, ensName, owners, authors, devRepository, branch)**
   - Creates `S2SPublication` object (contract/feed/configCid = undefined)
   - Calls `newPublicationSafe(main, publication)` → returns immediately (async runs in background)

2. **newPublicationSafe(main, publication)**
   1. Updates signer on L1 & L2 Safe instances
   2. Creates fresh Safe accounts on both chains (same salt: `"publication_safe_" + name`)
      - `publicationAddress1` = L1 Safe
      - `publicationAddress2` = L2 Safe
   3. **Parallel**:
      - **L1**: Registers ENS subdomain
        - `ens_registry.registerSubdomain(subdomain, publicationAddress1)`
      - **L2**: Batch creates both modules
        - `S2SRecordsModuleFactory.createModule(publicationAddress2)` (deploy: true)
        - `S2SPublicationModuleFactory.createModule(publicationAddress2, authors, [])` (deploy: true)
   4. Enables both modules on new Safe: `safe.enableModule(recordsModule)`, `safe.enableModule(publicationModule)`
   5. **Verifies** modules enabled (polling up to 20 retries, 2s interval + 5s initial delay + 3s buffer)
   6. Uploads config via `uploadConfig(main, publication)` → **stores configCid**
   7. Creates Lens feed: `lens.createFeed(ensName, description, publicationAddress2)`
   8. **Sets records** on config (configurable, with 3-retry logic):
      - Sets name, config, repo, branch, feed
   9. If owners provided:
      - Calls `addOwnerWithThreshold(owner, 1)` on both L1 & L2
      - **Verifies** owners added
      - **Removes initial signer** (the temporary address used for creation)
   10. **Publication creation complete.** Stores `pubAddress1` in log.

3. **uploadConfig(main, publication)** — *from config.ctrl*
   - Creates config JSON from publication details
   - Uploads to IPFS (Pinata) → returns CID
   - Stores as `publication.configCid`

---

## 4. Grant License
*(Trigger: subdomain already has a publication, user licenses existing content)*

1. **MainController.grantLicense(file)**
   - Retrieves `TFile` from path
   - Parses note via `content.parseNote(file)` → `{ contentId, publicContent, toEncrypt }`
   - Iterates `publicContent.publications`:
     - Derives `subdomain` from publication URL
     - If no PubService exists → `new PublicationService` + `init()`
     - Checks `service.isLicensed(contentId)`
     - If not licensed → `service.grantLicense(contentId)`
     - If granted → calls `renderCalls(publication, [contentId], litUsageKey, publish)`

2. **PublicationService.grantLicense(contentId)**
   - L2 Safe call on `publicationModule`:
     - `grantLicense(publicationModule, contentId)`

---

## 5. Publish Content (Propose → Render → Pin)
*(Trigger: user publishes a note)*

1. **MainController.proposeContent(file, publish)**
   - Validates file extension `.base` or `.md`
   - Calls `content.parseNote(file)` → `{ contentId, publicContent, toEncrypt }`
   - If no encryption on file: merges `toEncrypt` into `publicContent`
   - Iterates `publicContent.publications`:
     - Calls `publishToPublication(file, contentId, publicContent, toEncrypt, publication, publish)`

2. **MainController.publishToPublication(file, contentId, publicContent, toEncrypt, publication, publish)**
   - Gets/initializes `PublicationService` for subdomain
   - Shows Notice `"1/5 storing item ..."`
   - Calls `content.storeNoteOnLens(file, protocolInfo, contentId, publicContent, toEncrypt, subdomain)`
   - Shows Notice `"2/5 registering permission to publish on {subdomain} ..."`
   - Checks `service.isLicensed(contentId)`
   - If not licensed → `service.grantLicense(contentId)`
   - Shows Notice `"3/5 Authorizing ..."`
   - If licensed → calls `renderCalls(publication, [contentId], litUsageKey, publish)`

3. **MainController.renderCalls(publication, streamIds, litUsageKey, publish)**
   - Shows Notice `"4/5 Rendering ... (~30sec)"`
   - Calls `renderwithLitActions(oxo.ctrlr, litUsageKey, protocolInfo, notice, safe, publication, streamIds, true, dev, debug)`
     - This invokes the Lit Action pipeline:
       - **Prep action** (serverless or on-chain) → generates `jobs` array
       - **Update/merge action** (Lit Action) → renders HTML, returns `{ cid, path, jobs }`
   - Shows Notice `"5/5 Pinning ..."`
   - If result has CID → `pinCidFromRemote(cid, gateway, pinataJwt)`
   - Hides notice
   - Shows final notice with:
     - Link to IPFS view: `https://neutralpress.mypinata.cloud/ipfs/{cid}/{path}`
     - If publish: link to `{publication}.link{path}`

4. **MainController.getInitializedService(subdomain)**
   - If no PubService exists → `new PublicationService` + `init()`
   - Returns the initialized service

5. **PublicationService.getModuleAdresses()**
   - Queries L2 Safe for all enabled modules via `getModulesPaginated`
   - For each module, calls `NAME()` to identify it
   - Returns `{ configModule, publicationModule }`

---

## 6. Revoke License
*(Trigger: user revokes publishing permission for existing content)*

1. **MainController.revokeLicense(subdomain, file)**
   - Parses note → extracts `streamId`
   - Checks `service.isLicensed(streamId)`
   - If licensed → `service.revokeLicense(streamId)`

2. **PublicationService.revokeLicense(contentId)**
   - L2 Safe call: `revokeLicense(contentId)`

---

## Component Index

| File | Role |
|------|------|
| `src/main.ctrlr.ts` | Main entry — `newPublication`, `proposeContent`, `renderCalls`, `grantLicense`, `revokeLicense` |
| `src/publication/publication.service.ts` | Publication lifecycle — init, Safe instances, module lookup, license management |
| `src/publication/new.ts` | Publication creation — Safe deployment, ENS registration, module enablement, owner management |
| `src/publication/new.modal.ts` | UI — modal for new publication details (name, owners, repo, branch) |
| `src/publication/ens.ts` | ENS utilities — `isAvailableEnsName`, `getPublicationMultiSig` |
| `src/publication/config.ctrl.ts` | Config handling — `uploadConfig`, `getTaskConfig` |
| `src/content/content.ctrlr.ts` | Content handling — `parseNote`, `storeNoteOnLens`, `encryptContent` |
| `src/preview.ctrlr.ts` | Preview rendering |
