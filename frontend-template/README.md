# Miden Battleship Frontend

Vite + React + TypeScript frontend for Miden Battleship on testnet. It compiles the game's MASM contracts in the browser with the web SDK, creates a self-funded game account per match and plays the whole game through notes — no wallet extension involved.

## Getting Started

```bash
yarn install
yarn dev
```

Open [http://localhost:5173](http://localhost:5173). One browser profile per player (the app clears its IndexedDB state on every page load). The starter places ships, clicks *Start Game* and shares the game account address; the joiner places ships, pastes the address and clicks *Join*. The joiner fires first.

## Project Structure

```
src/
├── main.tsx / boot.tsx             # Clears Miden storage, then mounts the app
├── App.tsx                         # Root component
├── providers.tsx                   # MidenProvider (testnet RPC + remote prover, no signer provider)
├── config.ts                       # Storage slot names, note sizes, timing, fee/faucet constants
├── components/
│   ├── AppContent.tsx              # Screen state machine: lobby → placement → waiting → play
│   ├── LobbyScreen.tsx             # Start / join
│   ├── ShipPlacement.tsx           # 10x10 placement of the 5 classic ships
│   ├── WaitingScreen.tsx           # Handshake progress, address sharing
│   ├── GamePlay.tsx                # Both boards, firing, game over
│   ├── GameBoard.tsx, Cell.tsx     # Grid rendering
│   └── GameStatus.tsx              # Phase, turn, hits, fee balance
├── hooks/
│   ├── useStartGame.ts             # Starter (acceptor) flow
│   ├── useJoinGame.ts              # Joiner (challenger) flow
│   ├── useGameplaySync.ts          # 3 s loop: incoming notes, results, fee top-ups, reveal
│   ├── useFireShot.ts              # Publishes a shot note
│   ├── useGameState.ts, useBoardState.ts   # Read account storage
│   ├── useGameContext.ts           # Client + MASM compiler + prover + runExclusive
│   └── useSoundEffects.ts
├── lib/
│   ├── masmSources.ts              # `@masm/*.masm?raw` imports of the contract sources
│   ├── contracts.ts                # ContractCompiler: web SDK CodeBuilder, dynamic linking
│   ├── game.ts                     # Client-level flow, mirrors validate_testnet.rs
│   ├── notes.ts                    # Payload/storage builders, note + account construction
│   ├── funding.ts                  # Faucet HTTP API, proof of work, top-up policy
│   ├── board.ts                    # Packed board rows
│   └── gameplay.ts                 # Enemy board from the shot log, turn arithmetic
└── __tests__/                      # SDK mocks and fixtures for vitest
```

## How It Works

1. `vite.config.ts` aliases `@masm` to `../project-template/contracts/masm`; `masmSources.ts` imports every `.masm` file as raw text.
2. `ContractCompiler` compiles the account component with `CodeBuilder.compileAccountComponentCodeWithPath("battleship::account", source)` and links its code into the note and transaction scripts (`linkDynamicAccountComponentCode`).
3. `createGameAccount` builds a public account: battleship component + `BasicWallet` + `NoAuth`. The account is funded from the faucet and deployed by its first transaction.
4. Setup, challenge/accept, shots, results and reveal follow `project-template/integration/src/bin/validate_testnet.rs` step for step (`lib/game.ts`).

No `.masp` files, no `public/packages/`, no wallet adapter.

## Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@miden-sdk/miden-sdk` | 0.17.1 | WebClient, `CodeBuilder`, `AccountBuilder`, notes, transaction requests |
| `@miden-sdk/react` | 0.17.0 | `MidenProvider`, `useMiden` (`runExclusive`, prover), `useAccount`, `useSyncState`, `clearMidenStorage` |
| `@miden-sdk/vite-plugin` | 0.17.0 | WASM loading, top-level await, pre-bundling exclusions |
| `vite` / `vitest` | 6 / 4 | Build and test |
| `coi-serviceworker` | | COOP/COEP headers on static hosting (loaded from `index.html`) |

## Fees and Funding

Every transaction pays a fee in USDCx (6 decimals). The app claims 10,000 base units per request from the faucet HTTP API (`/pow` + `/get_tokens`, SHA-256 proof of work solved in the browser) and tops up when the balance falls below `FEE_TOP_UP_THRESHOLD` (3,000). A transaction costs ~105 base units.

## Configuration

Environment variables read in `src/config.ts` (`.env.example` lists the first two):

```bash
VITE_MIDEN_RPC_URL=testnet                             # "testnet" | "localhost" | custom URL
VITE_MIDEN_PROVER=testnet                              # "testnet" | "local" (local WASM proving is slow)
VITE_MIDEN_FAUCET_URL=https://faucet-api.testnet.miden.io
```

## Commands

```bash
yarn dev       # dev server
yarn test      # vitest --run (54 tests)
yarn build     # tsc -b && vite build
yarn lint      # eslint
```

## AI Developer Experience

This project ships with `.claude/` skills for AI coding tools covering React SDK patterns, frontend pitfalls, Vite + WASM setup, testing and Miden architecture. See `CLAUDE.md` for the developer guide.
