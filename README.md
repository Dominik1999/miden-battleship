# Miden Battleship

A fully on-chain Battleship game built on [Miden](https://0xmiden.com/) — a zero-knowledge rollup. Each player's board lives in a **private** per-match game account and never leaves it: shots and results are exchanged as public Miden notes created by the account code itself, and the defender's hit/miss answer is produced inside a ZK-proven transaction, so it cannot be faked. A handshake proves that both players run the same contract, deadlines turn a walk-away into a forfeit, and optional stakes are paid out to the winner's wallet.

The contracts are written in **Miden Assembly (MASM)** and compiled at runtime — by `miden-client` in Rust and by the web SDK in the browser. There are no build artifacts to copy around.

There are three ways to play: **MockChain tests** (offline, automated), the **CLI on testnet** (two terminals), and the **web frontend** (browser-based, testnet). A Rust CLI player and a browser player can play each other.

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

Runs 31 tests on a fee-charging MockChain (5 unit tests in `integration/src/battleship.rs` plus 26 integration tests):

- **`battleship_test`** (8) — deploy by funding note, setup (board, wallet, roots), seed-anchored handshake, a shot round trip, the 17th hit with its defeat note, the winner's wallet consuming it, a forfeit after the deadline, a late answer landing before the reclaim
- **`battleship_failure_test`** (12) — every rejection asserted against its MASM error message: wrong seed, foreign script roots, wrong ship set, firing out of turn / twice at a cell / out of bounds / with a short deadline, wrong turn or stranger's shot, wrong result turn, reclaim before or at the deadline, reclaim by a non-sender, reclaiming a final result, a defeat note consumed by the wrong wallet
- **`stake_test`** (6) — the winner's wallet claims both stakes with a defeat or a forfeit note, the loser cannot, a defeat note from another game does not count, refund only after expiry, the winner recovers its own stake

## 2. Testnet Validation (Automated)

Plays a complete staked game between two independent clients on testnet and asserts the state after every step. This is the gate for frontend work (see `CLAUDE.md`).

```bash
cd project-template
cargo run --bin validate_testnet --release
```

Each player gets a fresh private game account and a public wallet, both funded from the public faucet (four claims) and deployed by their first transaction. The run publishes both stakes, performs the handshake, checks that an early reclaim is rejected, plays 33 shots (17 hits by A, 16 misses by B) with one transaction per move, processes the final result and has A's wallet claim the defeat note together with both stakes. It ends with `DONE in <n>s: full staked game validated on testnet`; a run takes about 6 minutes.

## 3. CLI (Testnet, two terminals)

```bash
# Terminal 1 — challenger (fires first)
cd project-template
cargo run --bin battleship_cli --release -- --player alice --role challenger --game-id myGame1

# Terminal 2 — acceptor
cd project-template
cargo run --bin battleship_cli --release -- --player bob --role acceptor --game-id myGame1
```

Each run creates and funds a fresh private game account and a public wallet and prints the game account's `mtst1...` address; paste the other player's address when prompted (or pass `--opponent <bech32>`). Add `--stake <base units>` on both sides to play for a stake. Both players use the classic ship placement. Enter shots as `A5`, `B10`, `J1`. Every move is one transaction; if the opponent does not answer within 12 hours the CLI reclaims the pending note and lets the wallet claim the forfeit. State lives in `testnet-store-<player>.sqlite3` and `testnet-keystore-<player>/`.

## 4. Web Frontend (Testnet)

```bash
cd frontend-template
yarn install
yarn dev
```

Open [http://localhost:5173](http://localhost:5173). No wallet extension is needed: the app creates a private game account with `NoAuth` and a local public wallet, funds both from the faucet and pays its own fees. Use two browser profiles (or two machines) for two players.

1. **Start a game** — pick a stake tier (or none), place your 5 ships, click *Start Game*, share the game account address
2. **Join a game** — pick the same stake, place your ships, paste the starter's address, click *Join*; the joiner sends the challenge and fires first
3. **Take turns** — once both stakes are locked, click a cell on the enemy grid; each move consumes the opponent's notes and fires in one transaction. While you wait, the status shows when the opponent forfeits; after the deadline you can *Claim the win by forfeit*
4. **Win** — sink all 17 enemy ship cells (or claim a forfeit); the winner's wallet collects the defeat/forfeit note and both stakes

An interrupted game can be resumed from the lobby (*Resume game* / *Discard*); the session is kept in `localStorage` and the client store in IndexedDB.

## Fees

Testnet 0.17 charges a fee in USDCx (6 decimals) on every transaction, including the one that deploys an account. The clients claim 10,000 base units (0.01 USDCx) per request from `https://faucet-api.testnet.miden.io` (`/pow` + `/get_tokens`, SHA-256 proof of work) and top up automatically when the balance runs low. A transaction costs about 105 base units; a full game is 18–19 transactions per game account. Testnet stake tiers are tiny for the same reason (`VITE_STAKE_TIERS`, default `1000,2000,5000` base units; the CLI's `--stake`).

## Project Structure

```
miden-battleship/
├── project-template/                # Contracts + Rust integration crate
│   ├── contracts/masm/
│   │   ├── battleship_account.masm  # Game account component ({{ISCn}} = initial storage commitment)
│   │   ├── challenge_note.masm      # Challenger -> acceptor (assert_script_roots + accept_challenge)
│   │   ├── accept_note.masm         # Acceptor -> challenger (assert_script_roots + receive_acceptance)
│   │   ├── shot_note.masm           # Created by fire_shot; process_shot, or claim_forfeit after the deadline
│   │   ├── result_note.masm         # Created by process_shot; process_result, or claim_forfeit
│   │   ├── defeat_note.masm         # Loser's account -> winner's wallet (17th hit)
│   │   ├── forfeit_note.masm        # Own account -> own wallet (reclaim)
│   │   ├── stake_note.masm          # Conditional P2ID published by a wallet ({{DEFEATn}}/{{FORFEITn}})
│   │   └── scripts/                 # setup_tx, fire_tx
│   └── integration/
│       ├── src/battleship.rs        # MASM compilation, storage layout, note builders, GameState
│       ├── src/helpers.rs           # Testnet client, faucet funding, moves, reclaims, stakes, claims
│       ├── src/bin/                 # validate_testnet, battleship_cli
│       └── tests/                   # MockChain tests (common/mod.rs is the harness)
│
└── frontend-template/               # React + TypeScript web UI
    └── src/
        ├── lib/                     # contracts (CodeBuilder), game flow, notes, session, funding, board
        ├── hooks/                   # useGameSession, useStartGame, useJoinGame, useGameplaySync, ...
        ├── components/              # Lobby, ShipPlacement, GamePlay, GameBoard, GameStatus, ...
        └── types/                   # Game types and constants
```

The frontend imports the MASM sources directly from `project-template/contracts/masm` (Vite alias `@masm`, `?raw` imports) and compiles them with the web SDK's `CodeBuilder` at runtime.

## Frontend Commands

```bash
cd frontend-template
yarn test     # vitest (76 tests)
yarn build    # tsc -b && vite build
yarn lint     # eslint
```

## Further Reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — game model, notes, storage layout, code anchoring, forfeits and stakes, state machine
- [`project-template/README.md`](project-template/README.md) — contract and integration crate layout
- [`frontend-template/README.md`](frontend-template/README.md) — frontend structure and configuration

## License

See [LICENSE](project-template/LICENSE).
