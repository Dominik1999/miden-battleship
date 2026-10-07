# Miden Battleship Frontend

Vite + React + TypeScript frontend for Miden Battleship on testnet. It compiles the game's MASM contracts in the browser with the web SDK, creates a private self-funded game account and a local wallet per match and plays the whole game through notes — no wallet extension involved.

## Getting Started

```bash
yarn install
yarn dev
```

Open [http://localhost:5173](http://localhost:5173). One browser profile per player. Both pick the same stake tier (or none); the starter places ships, clicks *Start Game* and shares the game account address; the joiner places ships, pastes the address and clicks *Join*. The joiner fires first. A game survives a reload: the lobby offers *Resume game* / *Discard*, and *Reset Client Data* wipes the client store.

## Project Structure

```
src/
├── main.tsx / boot.tsx             # Clears the extension's Dexie symbol, then mounts the app (the store is kept)
├── App.tsx                         # Root component
├── providers.tsx                   # MidenProvider (testnet RPC + remote prover, no signer provider)
├── config.ts                       # Storage slot names, note sizes/kinds, deadlines, stake tiers, timing, fees
├── components/
│   ├── AppContent.tsx              # Screen state machine: lobby → placement → waiting → play
│   ├── LobbyScreen.tsx             # Start / join, stake tier, resume / discard, reset
│   ├── ShipPlacement.tsx           # 10x10 placement of the 5 classic ships
│   ├── WaitingScreen.tsx           # Handshake progress, address sharing
│   ├── GamePlay.tsx                # Both boards, firing, game over
│   ├── GameBoard.tsx, Cell.tsx     # Grid rendering
│   └── GameStatus.tsx              # Turn, forfeit countdown and claim, stake status, fee balance
├── hooks/
│   ├── useGameSession.ts           # Persisted session as React state
│   ├── useStartGame.ts             # Starter (acceptor) flow, resumable
│   ├── useJoinGame.ts              # Joiner (challenger) flow, resumable
│   ├── useGameplaySync.ts          # 3 s loop: pending notes, moves, forfeits, stakes, fee top-ups
│   ├── useGameState.ts, useBoardState.ts   # Read account storage
│   ├── useGameContext.ts           # Client + MASM compiler + prover + runExclusive
│   └── useSoundEffects.ts
├── lib/
│   ├── masmSources.ts              # `@masm/*.masm?raw` imports of the contract sources, template substitution
│   ├── contracts.ts                # ContractCompiler: initial storage commitment, CodeBuilder, dynamic linking
│   ├── game.ts                     # Client-level flow, mirrors integration/src/helpers.rs
│   ├── notes.ts                    # Payload/storage builders, predicted notes, note + account construction
│   ├── session.ts                  # localStorage session (seed, ships, shot log, stake)
│   ├── state.ts                    # Game state from account storage
│   ├── funding.ts                  # Faucet HTTP API, proof of work, top-up policy
│   ├── board.ts                    # Packed board rows
│   ├── gameplay.ts                 # Enemy board from the shot log, countdown formatting
│   └── syncHeight.ts               # Latest synced block height for the UI
└── __tests__/                      # SDK mocks and fixtures for vitest
```

## How It Works

1. `vite.config.ts` aliases `@masm` to `../project-template/contracts/masm`; `masmSources.ts` imports every `.masm` file as raw text.
2. `ContractCompiler` compiles the account component with `CodeBuilder.compileAccountComponentCodeWithPath("battleship::account", source)` and links its code into the note and transaction scripts (`linkDynamicAccountComponentCode`). The component embeds its initial storage commitment, which the compiler reads from a throwaway account built with the placeholder component.
3. `createGameAccount` builds a **private** account: battleship component + `BasicWallet` + `NoAuth` (`buildWithoutSchemaCommitment()`, so the commitment matches the Rust builder); `createLocalWallet` builds a public `NoAuth` wallet. Both are funded from the faucet and deployed by their first transaction.
4. Setup, challenge/accept (carrying the seed and script roots the opponent verifies on-chain), stakes, moves (one transaction each: consume the opponent's notes, fire), forfeits and the final claim follow `project-template/integration/src/helpers.rs` step for step (`lib/game.ts`).

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

Every transaction pays a fee in USDCx (6 decimals). The app claims 10,000 base units per request from the faucet HTTP API (`/pow` + `/get_tokens`, SHA-256 proof of work solved in the browser) and tops up when the balance falls below `FEE_TOP_UP_THRESHOLD` (3,000). A transaction costs ~105 base units. Stakes are paid from the local wallet in the same asset; the testnet tiers are tiny because of the faucet cap.

## Configuration

Environment variables read in `src/config.ts` (`.env.example` lists the first two):

```bash
VITE_MIDEN_RPC_URL=testnet                             # "testnet" | "localhost" | custom URL
VITE_MIDEN_PROVER=testnet                              # "testnet" | "local" (local WASM proving is slow)
VITE_MIDEN_FAUCET_URL=https://faucet-api.testnet.miden.io
VITE_STAKE_TIERS=1000,2000,5000                        # stake tiers in fee-asset base units
```

## Commands

```bash
yarn dev       # dev server
yarn test      # vitest --run (76 tests)
yarn build     # tsc -b && vite build
yarn lint      # eslint
```

## AI Developer Experience

This project ships with `.claude/` skills for AI coding tools covering React SDK patterns, frontend pitfalls, Vite + WASM setup, testing and Miden architecture. See `CLAUDE.md` for the developer guide.
