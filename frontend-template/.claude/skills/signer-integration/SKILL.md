---
name: signer-integration
description: Guide to integrating external signers (Para, Turnkey, MidenFi wallet adapter) and building custom signers for Miden React frontends. Covers provider setup, passkey authentication, unified signer interface, custom SignerContext implementation, and custom account components. Use when adding wallet connection, authentication, or external key management to a Miden frontend.
---

# Miden Signer Integration

## This App Uses No Signer

Miden Battleship renders `MidenProvider` without any signer provider (`src/providers.tsx`). Its per-match game accounts are public accounts composed of the battleship component, `BasicWallet` and `NoAuth`; they are funded from the public faucet and pay their own fees, so transactions are submitted directly from the raw client with no signature and no popup. The wallet adapter that an earlier version used has been removed: `MidenProvider` never initializes behind a signer provider that is not connected, and the game needs no user-held keys. Read the rest of this skill only if you are adding a feature that genuinely needs the user's own account (for example moving real assets).

## Overview

By default, MidenProvider uses a **local keystore** (keys in IndexedDB, no wallet connection needed). For apps that need user-held keys, wrap MidenProvider with a signer provider to use external key management.

Signer providers must wrap MidenProvider (outer → inner):
```
<SignerProvider>      ← manages keys + auth
  <MidenProvider>     ← manages Miden client
    <App />
  </MidenProvider>
</SignerProvider>
```

## Pre-Built Signer Providers

### Para (EVM Wallets)
```tsx
import { ParaSignerProvider } from "@miden-sdk/para";

<ParaSignerProvider apiKey="your-api-key" environment="PRODUCTION">
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</ParaSignerProvider>

const { para, wallet, isConnected } = useParaSigner();
```

### Turnkey (Passkey Authentication)
```tsx
import { TurnkeySignerProvider } from "@miden-sdk/miden-turnkey-react";

// Config is optional — defaults to https://api.turnkey.com
// and reads VITE_TURNKEY_ORG_ID from environment
<TurnkeySignerProvider>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</TurnkeySignerProvider>

// Or with explicit config:
<TurnkeySignerProvider config={{
  apiBaseUrl: "https://api.turnkey.com",
  defaultOrganizationId: "your-org-id",
}}>
  ...
</TurnkeySignerProvider>
```

Connect via passkey:
```tsx
import { useSigner } from "@miden-sdk/react";
import { useTurnkeySigner } from "@miden-sdk/miden-turnkey-react";

const { isConnected, connect, disconnect } = useSigner();
await connect();  // triggers passkey flow, auto-selects account

// Turnkey-specific extras
const { client, account, setAccount } = useTurnkeySigner();
```

### MidenFi Wallet Adapter (Browser Extension)
Not installed in this project (the package was removed with the wallet flow); shown for reference.
```tsx
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter";

<MidenFiSignerProvider
  appName="My App"                              // passed to MidenWalletAdapter
  network="testnet"                             // "testnet" | "devnet" | "localhost"
  autoConnect                                   // reconnect on mount. Default: false
  accountType="RegularAccountImmutableCode"     // Default: "RegularAccountImmutableCode"
  storageMode="public"                          // "private" | "public" | "network". Default: "public"
  customComponents={[myComponent]}              // optional: custom AccountComponents
  privateDataPermission={permission}            // optional: private data access level
  allowedPrivateData={allowedData}              // optional: allowed private data types
>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</MidenFiSignerProvider>
```

With `MidenFiSignerProvider` in place, use `useSigner()` from the React SDK to manage connection state. The regular React SDK hooks (`useSend`, `useConsume`, etc.) automatically sign via the connected wallet — no additional wiring needed.

## Unified Signer Interface

Works with any signer provider above:
```tsx
import { useSigner } from "@miden-sdk/react";

const { isConnected, connect, disconnect, name } = useSigner();

if (!isConnected) {
  return <button onClick={connect}>Connect {name}</button>;
}
```

## Building a Custom Signer

Implement `SignerContextValue` via `SignerContext.Provider`:

```tsx
import { SignerContext } from "@miden-sdk/react";

<SignerContext.Provider value={{
  name: "MyWallet",
  storeName: `mywallet_${userAddress}`,  // unique per user for DB isolation
  isConnected: true,
  accountConfig: {
    publicKey: userPublicKeyCommitment,  // Uint8Array
    storageMode: "private",
  },
  signCb: async (pubKey, signingInputs) => {
    // Route to your signing service
    return signature;  // Uint8Array
  },
  connect: async () => { /* trigger wallet connection */ },
  disconnect: async () => { /* clear session */ },
}}>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</SignerContext.Provider>
```

**Required fields:**
- `name` — Display name for the signer
- `storeName` — Unique string per user (isolates IndexedDB data between users)
- `accountConfig` — Public key commitment + storage mode
- `signCb` — Callback that signs transaction data with your key management service
- `connect` / `disconnect` — Session lifecycle handlers

## Custom Account Components

Attach application-specific `AccountComponent` instances to accounts created by the signer. With the 0.17 web SDK a component is compiled from MASM at runtime (no `.masp` packages):

```tsx
import { type SignerAccountConfig } from "@miden-sdk/react";
import { AccountComponent, StorageSlot, StorageMap } from "@miden-sdk/miden-sdk";

const builder = await client.createCodeBuilder();
const code = builder.compileAccountComponentCodeWithPath("battleship::account", masmSource);
const myComponent = AccountComponent.compile(code, [
  StorageSlot.emptyValue("my_app::state"),
  StorageSlot.map("my_app::board", new StorageMap()),
]).withSupportsAllTypes();

const accountConfig: SignerAccountConfig = {
  publicKeyCommitment: userPublicKeyCommitment,
  accountType: "RegularAccountUpdatableCode",
  storageMode: myStorageMode,
  customComponents: [myComponent],
};
```

Components are appended to the `AccountBuilder` after the default basic wallet component. The field is optional — omitting it preserves default behavior. Note that a component handle is moved into the builder (wasm-bindgen by-value semantics), so compile a fresh one per account; see `ContractCompiler` in `src/lib/contracts.ts`.

## Which Signer to Choose

| Signer | Auth Method | Keys Stored | Best For |
|--------|-------------|-------------|----------|
| None (this app) | None (`NoAuth` game accounts) | No keys | Per-match accounts that pay their own fees |
| Local keystore (default) | None | Browser IndexedDB | Development, demos |
| Para | EVM wallet | Para servers | Apps with existing EVM users |
| Turnkey | Passkey (biometric) | Turnkey servers | Consumer apps, no seed phrases |
| MidenFi Wallet | Browser extension | Extension | Power users with MidenFi wallet |
| Custom | Your choice | Your infrastructure | Enterprise, custom auth flows |

**Key trade-off**: Local keystore requires no setup but keys are lost if the user clears browser data. External signers persist keys server-side but add a dependency.
