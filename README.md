# Miden Battleship

A fully on-chain Battleship game built on [Miden](https://0xmiden.com/) — a zero-knowledge rollup. Each player's board lives in the private storage of a per-match game account, shots and results are exchanged as public Miden notes, and the defender's hit/miss answer is produced inside a ZK-proven transaction, so it cannot be faked.

The contracts are written in **Miden Assembly (MASM)** and compiled at runtime — by `miden-client` in Rust and by the web SDK in the browser. There are no build artifacts to copy around.

There are three ways to play: **MockChain tests** (offline, automated), the **CLI on testnet** (two terminals), and the **web frontend** (browser-based, testnet).

## Prerequisites

- [Rust](https://rustup.rs/) — the toolchain is pinned by `project-template/rust-toolchain.toml` (1.98.1)
- `curl` on `PATH` (the Rust binaries call the testnet faucet with it)
- [Node.js](https://nodejs.org/) v18+ and [Yarn](https://yarnpkg.com/) v1 (frontend only)

No `midenup`, `cargo-miden` or local `miden-node` is needed.

## 1. MockChain Tests (Offline)

```bash
cd project-template
cargo test -p integration --release
```

Runs 31 tests on a fee-charging MockChain (3 unit tests in `integration/src/battleship.rs` plus 28 integration tests):

- **`battleship_test`** (11) — setup, handshake, shots and result notes, alternating turns, the 17th hit, a full game, reveal in either order, fee payment
- **`battleship_failure_test`** (16) — every rejection asserted against its MASM error message: wrong ship set, second setup, wrong game id, shot from a stranger, wrong phase/turn/bounds, already-shot cell, wrong reveal commitment
- **`cycle_benchmark_test`** (1) — prints cycle counts per transaction (`-- --nocapture`)

## 2. Testnet Validation (Automated)

Plays a complete game between two independent clients on testnet and asserts the on-chain state after every step. This is the gate for frontend work (see `CLAUDE.md`).

```bash
cd project-template
cargo run --bin validate_testnet --release
```

Both game accounts are created fresh, funded from the public faucet and deployed by their first transaction. A run takes roughly 8–9 minutes and about 4,200 base units of USDCx per account.

## 3. CLI (Testnet, two terminals)

```bash
# Terminal 1 — challenger (fires first)
cd project-template
cargo run --bin battleship_cli --release -- --player alice --role challenger --game-id myGame1

# Terminal 2 — acceptor
cd project-template
cargo run --bin battleship_cli --release -- --player bob --role acceptor --game-id myGame1
```

Each run creates and funds a fresh game account and prints its `mtst1...` address; paste the other player's address when prompted (or pass `--opponent <bech32>`). Both players use the classic ship placement. Enter shots as `A5`, `B10`, `J1`. State lives in `testnet-store-<player>.sqlite3` and `testnet-keystore-<player>/`.

## 4. Web Frontend (Testnet)

```bash
cd frontend-template
yarn install
yarn dev
```

Open [http://localhost:5173](http://localhost:5173). No wallet extension is needed: the app creates a public game account with `NoAuth`, funds it from the faucet and pays its own fees. Use two browser profiles (or two machines) for two players.

1. **Start a game** — place your 5 ships, click *Start Game*, share the game account address
2. **Join a game** — place your ships, paste the starter's address, click *Join*; the joiner sends the challenge and fires first
3. **Take turns** — click a cell on the enemy grid; results arrive as notes and are reflected on both boards
4. **Win** — sink all 17 enemy ship cells; both accounts then run the reveal ceremony and end in `COMPLETE`

## Fees

Testnet 0.17 charges a fee in USDCx (6 decimals) on every transaction, including the one that deploys an account. The clients claim 10,000 base units (0.01 USDCx) per request from `https://faucet-api.testnet.miden.io` (`/pow` + `/get_tokens`, SHA-256 proof of work) and top up automatically when the balance runs low. A transaction costs about 105 base units, a full game roughly 4,200 per account.

## Project Structure

```
miden-battleship/
├── project-template/                # Contracts + Rust integration crate
│   ├── contracts/masm/
│   │   ├── battleship_account.masm  # Game account component
│   │   ├── challenge_note.masm      # Challenger -> acceptor (accept_challenge)
│   │   ├── accept_note.masm         # Acceptor -> challenger (receive_acceptance)
│   │   ├── shot_note.masm           # Shooter -> defender (process_shot)
│   │   ├── result_note.masm         # Created by the defender's account; data carrier
│   │   ├── reveal_note.masm         # Player -> opponent (verify_opponent_reveal)
│   │   └── scripts/                 # setup_tx, enter_reveal_tx, mark_my_reveal_tx
│   └── integration/
│       ├── src/battleship.rs        # MASM compilation, storage layout, note builders
│       ├── src/helpers.rs           # Testnet client, faucet funding, tx wrappers
│       ├── src/bin/                 # validate_testnet, battleship_cli
│       └── tests/                   # MockChain tests (common/mod.rs is the harness)
│
└── frontend-template/               # React + TypeScript web UI
    └── src/
        ├── lib/                     # contracts (CodeBuilder), game flow, notes, funding, board
        ├── hooks/                   # useStartGame, useJoinGame, useGameplaySync, ...
        ├── components/              # Lobby, ShipPlacement, GamePlay, GameBoard, ...
        └── types/                   # Game types and constants
```

The frontend imports the MASM sources directly from `project-template/contracts/masm` (Vite alias `@masm`, `?raw` imports) and compiles them with the web SDK's `CodeBuilder` at runtime.

## Frontend Commands

```bash
cd frontend-template
yarn test     # vitest (54 tests)
yarn build    # tsc -b && vite build
yarn lint     # eslint
```

## Further Reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — game model, notes, storage layout, state machine
- [`project-template/README.md`](project-template/README.md) — contract and integration crate layout
- [`frontend-template/README.md`](frontend-template/README.md) — frontend structure and configuration

## License

See [LICENSE](project-template/LICENSE).
