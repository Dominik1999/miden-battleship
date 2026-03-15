# Miden Battleship

A fully on-chain Battleship game built on [Miden](https://0xmiden.com/) — a zero-knowledge rollup. Ship placements are private (committed as hashes), shots and results are exchanged as Miden notes, and board integrity is verified via ZK proofs at game end.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Yarn](https://yarnpkg.com/) v1
- [Rust](https://rustup.rs/) stable toolchain (only for contract development)
- [midenup](https://github.com/0xMiden/midenup) toolchain (only for contract development)

## Quick Start (Frontend)

```bash
cd frontend-template
yarn install
yarn dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser. You'll need the [MidenFi wallet extension](https://chromewebstore.google.com/detail/midenfi/okgfhmbifkhgpfnlojkhapbjbamalggo) installed to connect and play.

## How to Play

1. **Connect wallet** — Click "Connect Wallet" to link your MidenFi wallet
2. **Place ships** — Arrange your 5 ships (Carrier, Battleship, Cruiser, Submarine, Destroyer) on the 10x10 grid
3. **Challenge or join** — Create a new game or accept an opponent's challenge
4. **Take turns** — Fire shots at your opponent's grid; hits and misses are revealed via on-chain notes
5. **Win** — Sink all 17 of your opponent's ship cells to win. Both boards are revealed and verified at game end.

## Project Structure

```
miden-battleship/
├── frontend-template/           # React + TypeScript web UI
│   ├── src/
│   │   ├── components/          # GameBoard, ShipPlacement, GamePlay, etc.
│   │   ├── hooks/               # useGameState, useFireShot, useBoardState, etc.
│   │   ├── lib/                 # Miden SDK utilities, note helpers
│   │   └── types/               # Game types and constants
│   └── public/packages/         # Compiled contract artifacts (.masp)
│
└── project-template/            # Miden smart contracts (Rust SDK)
    ├── contracts/
    │   ├── battleship-account/  # Main game account component
    │   ├── setup-note/          # Board placement note
    │   ├── challenge-note/      # Challenge an opponent
    │   ├── accept-note/         # Accept a challenge
    │   ├── shot-note/           # Fire a shot
    │   ├── result-note/         # Hit/miss result
    │   └── reveal-note/         # End-game board reveal
    └── integration/             # Tests and deployment scripts
```

## Building Contracts

```bash
# Build a single contract
cargo miden build --manifest-path project-template/contracts/battleship-account/Cargo.toml --release

# Run integration tests
cd project-template && cargo test -p integration --release
```

## Running Tests

```bash
# Frontend tests
cd frontend-template && npx vitest --run

# Contract integration tests
cd project-template && cargo test -p integration --release
```

## License

See [LICENSE](project-template/LICENSE).
