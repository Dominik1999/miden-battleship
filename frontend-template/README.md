# Miden Frontend Template

Minimal Vite + React + TypeScript template for building Miden frontends. Includes a network counter demo that publishes an increment note via the MidenFi wallet adapter.

## Getting Started

```bash
yarn install
yarn dev
```

Open [http://localhost:5173](http://localhost:5173). Connect your MidenFi wallet and click the counter button to publish an increment note.

## Project Structure

```
src/
├── App.tsx                         # Root component
├── providers.tsx                   # MidenProvider + wallet adapter setup
├── config.ts                       # Constants (counter address, explorer URL, SDK config)
├── components/
│   ├── AppContent.tsx              # Page layout, logos, wallet button
│   └── Counter.tsx                 # Counter UI
├── hooks/
│   └── useIncrementCounter.ts      # Note construction, wallet submission, re-sync
└── lib/
    └── miden.ts                    # Shared Miden utilities
```

## Network Counter Demo

The template demonstrates the network note pattern on Miden testnet:

1. A **counter account** is deployed as a network account (`AccountStorageMode::Network`) at [`mtst1aru8adnrqspgcsr3drk2n990lyc070ll`](https://testnet.midenscan.com/account/mtst1aru8adnrqspgcsr3drk2n990lyc070ll)
2. On button click, the frontend constructs a **public note** targeting the counter and submits it through the wallet adapter
3. The **network operator** picks up the note and executes it against the counter account, incrementing the on-chain count
4. The frontend re-syncs and reads the updated count from the counter's `StorageMap`

Pre-compiled `.masp` packages for the counter account and increment note are in `public/packages/`.

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@miden-sdk/react` | React hooks for Miden (useAccount, useSyncState, useImportAccount, etc.) |
| `@miden-sdk/miden-sdk` | Core SDK types (Note, NoteScript, AccountId, Word, etc.) |
| `@miden-sdk/vite-plugin` | Vite plugin handling WASM loading, top-level await, and COOP/COEP |
| `@miden-sdk/miden-wallet-adapter` | MidenFi wallet adapter for transaction submission |

## Configuration

SDK settings can be overridden via environment variables (see `.env.example`):

```bash
VITE_MIDEN_RPC_URL=testnet    # "testnet" | "localhost" | custom URL
VITE_MIDEN_PROVER=testnet     # "testnet" | "local"
```

## AI Developer Experience

This template ships with `.claude/` skills for AI coding tools. Skills cover React SDK patterns, frontend pitfalls, Vite + WASM setup, signer integration, and Miden architecture. See `CLAUDE.md` for the full developer guide.
