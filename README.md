# Miden Battleship

A fully on-chain Battleship game built on [Miden](https://0xmiden.com/) — a zero-knowledge rollup. Ship placements are private (committed as hashes), shots and results are exchanged as Miden notes, and board integrity is verified via ZK proofs at game end.

There are three ways to play: **MockChain tests** (offline, automated), **CLI against a local node** (two terminals), and the **web frontend** (browser-based).

## Prerequisites

- [Rust](https://rustup.rs/) stable toolchain
- [midenup](https://github.com/0xMiden/midenup) toolchain (provides `cargo-miden` and `miden-node`)
- [Node.js](https://nodejs.org/) v18+ and [Yarn](https://yarnpkg.com/) v1 (for frontend only)

## 1. MockChain Tests (Offline)

Run a complete Battleship game entirely offline using MockChain — no node required. This exercises the full game lifecycle: board setup, challenge/accept handshake, 17 shots with hit/miss results, and reveal/verification.

```bash
cd project-template
cargo test -p integration --release
```

This runs 18 tests across 4 test files:

- **`battleship_unit_test`** (7 tests) — Account creation, board placement, shot processing (hit/miss), challenge/accept flow, enter/mark reveal, verify opponent reveal
- **`battleship_integration_test`** (2 tests) — Full game: 17 hits trigger victory detection; complete 2-player game through all phases (CREATED → CHALLENGED → ACTIVE → REVEAL → COMPLETE)
- **`battleship_notes_test`** (4 tests) — Note lifecycle: challenge/accept handshake via notes, shot-note creates result-note output, reveal-note verifies opponent commitment
- **`battleship_failure_test`** (5 tests) — Rejects: wrong phase, wrong turn number, duplicate cell placement, wrong-phase enter_reveal, wrong commitment in reveal

## 2. CLI (Local Node)

Play an interactive Battleship game in the terminal against another player, with both connected to a local Miden node. Each player runs in a separate terminal.

### Start the local node

```bash
cd project-template
rm -rf local-node-data/
miden-node bundled bootstrap --data-directory local-node-data --accounts-directory .
miden-node bundled start --data-directory local-node-data --rpc.url http://0.0.0.0:57291
```

### Start Player A (Challenger)

```bash
cd project-template
cargo run --bin battleship_cli --release -- --player alice --role challenger --game-id myGame1
```

### Start Player B (Acceptor) — in a second terminal

```bash
cd project-template
cargo run --bin battleship_cli --release -- --player bob --role acceptor --game-id myGame1
```

Both players will print their account ID at startup. Copy-paste each ID into the other terminal when prompted. Then:

1. Both boards are automatically set up with classic ship placement
2. The challenger fires first — enter coordinates like `A5`, `B10`, `J1`
3. Players alternate turns, with shots processed on-chain and results returned via notes
4. The game ends when all 17 of one player's ship cells are hit

There is also a scripted validation binary that plays a full game automatically:

```bash
cd project-template
cargo run --bin validate_local --release
```

## 3. Web Frontend

> **Note:** The frontend is currently buggy due to a known SDK issue with note consumption in the browser WASM client — see [miden-client#1901](https://github.com/0xMiden/miden-client/issues/1901). Ship placement and game setup work, but gameplay transactions may fail.

```bash
cd frontend-template
yarn install
yarn dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser. You'll need the [MidenFi wallet extension](https://chromewebstore.google.com/detail/midenfi/okgfhmbifkhgpfnlojkhapbjbamalggo) installed to connect and play.

### How to play (frontend)

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
        ├── tests/               # MockChain integration tests
        └── src/bin/             # CLI, local-node validation, testnet deploy
```

## Building Contracts

```bash
# Build a single contract
cargo miden build --manifest-path project-template/contracts/battleship-account/Cargo.toml --release

# Build all contracts (via integration tests, which compile them automatically)
cd project-template && cargo test -p integration --release
```

## License

See [LICENSE](project-template/LICENSE).
