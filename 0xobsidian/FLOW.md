# FLOW: Plugin Init Sequence (Debug-Ready Format)

## Debugging-Ready Method Call Sequence
*(Trigger: `OxO.onload()`)*

1. **`OxO.onload()`**
   - Calls `this.loadSettings()` → Loads plugin settings.
   - Creates `this.authorsTab` → Registers settings UI tab.
   - Registers `this.authorsTab` with Obsidian.
   - Initializes `this.ctrlr = new MainController(this)`.

2. **`MainController.init()`**
   - Initializes `this.account` (chain → `PermissionlessSafeService` map).
   - Creates `this.pinata` (PinataService).
   - Creates `this.lit` (LitService, prod environment).
   - Creates `this.lens` (LensService).
   - Searches for an active user via `plugin.settings.authors.find(a => a.active)`.

3. **If NO ACTIVE USER**
   - Shows `new Notice("no active 0xObsidian user", 3000)`.
   - **Initialization ends here.**

4. **If ACTIVE USER FOUND**
   - Creates `this.user = new OXOUser(...)` → Generates keypair if missing.
   - Calls `this.user.checkLensProfile(this)` → Authenticates with Lens.
     - If profile missing, calls `this.user.addLensAccount(this)` → Registers profile.
   - **Initialization complete.**

5. **Deferred Chain Initialization**
   - Triggered by `newAuthor()` or `toggleAuthor()`.
   - Calls `MainController.newAuthor()` → Initializes blockchain accounts (ETH/BASE).
   - Calls `MainController.initChain(chain)` → Sets up `PermissionlessSafeService` for the chain.

## New User Trigger Flow
*(Trigger: `newAuthor()` or `toggleAuthor()`)*

1. **`MainController.newAuthor()`**
   - Creates `this.user = new OXOUser(...)` → Generates keypair if missing.
   - If no existing accounts: `await this.initChains(['ETH_MAINNET','BASE'])`
   - Else: Updates signer for existing chains.
   - If type == "safe": Connects to a fresh Safe account via `connectToFreshSafe()`.
   - Registers Lens account via `this.user.addLensAccount(this)`.
   - Updates plugin settings and UI via `saveSettings()` and `display()`.

2. **`MainController.initChain(chain)`**
   - Initializes `PermissionlessSafeService` for the chain.
   - Sets up `publicClient` and `pimlicoClient` for blockchain interactions.
   - Updates signer with user's private key.
   - Connects to existing Safe or creates a new one via `connectToFreshSafe()`.

3. **Lens Profile Registration**
   - `this.user.addLensAccount(this)` → Handles profile creation via LensService.
     - Authenticates with `LensService.auth("new")`.
     - Uploads profile metadata via `storageClient.uploadAsJson()`.
     - Registers account with `createAccountWithUsername()`.
     - Waits for transaction confirmation via `waitForTransaction()`.