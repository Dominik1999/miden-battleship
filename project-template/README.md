# Miden Battleship — Contracts and Integration Crate

The on-chain half of Miden Battleship: Miden Assembly contracts and a Rust crate that compiles them at runtime, tests them on a MockChain and plays the game on testnet.

## **Installation**

1. **Install Rust** from [rustup.rs](https://rustup.rs/). The toolchain is pinned by `rust-toolchain.toml` (1.98.1); rustup picks it up automatically.
2. **`curl`** must be on `PATH` — the testnet binaries use it to talk to the faucet.

No `midenup`, `cargo-miden` or local node is required.

## **Structure**

```text
project-template/
├── contracts/
│   └── masm/                        # Miden Assembly sources, compiled at runtime
│       ├── battleship_account.masm  # Account component (battleship::account); {{ISCn}} template
│       ├── challenge_note.masm      # Handshake notes: assert_script_roots + accept_challenge /
│       ├── accept_note.masm         #   receive_acceptance (seed, wallet and roots of the sender)
│       ├── shot_note.masm           # Created by fire_shot; process_shot or claim_forfeit
│       ├── result_note.masm         # Created by process_shot; process_result or claim_forfeit
│       ├── defeat_note.masm         # Loser's account -> winner's wallet
│       ├── forfeit_note.masm        # Reclaiming account -> own wallet
│       ├── stake_note.masm          # Conditional P2ID from a wallet; {{DEFEATn}}/{{FORFEITn}} template
│       └── scripts/
│           ├── setup_tx.masm        # Board setup from an advice-map payload
│           └── fire_tx.masm         # fire_shot(row, col, deadline)
├── integration/                     # Workspace member
│   ├── src/
│   │   ├── battleship.rs            # MASM compilation, storage layout, note builders, GameState
│   │   ├── helpers.rs               # Testnet client, faucet funding, moves, reclaims, stakes, claims
│   │   ├── lib.rs
│   │   └── bin/
│   │       ├── validate_testnet.rs  # Scripted full staked game on testnet (the gate)
│   │       └── battleship_cli.rs    # Interactive two-terminal game on testnet
│   └── tests/
│       ├── common/mod.rs            # MockChain harness (Game)
│       ├── battleship_test.rs       # Success paths
│       ├── battleship_failure_test.rs # Rejections, matched by MASM error message
│       └── stake_test.rs            # Stake notes: claims and refunds
├── Cargo.toml                       # Workspace root (contracts/ is excluded: it holds no crates)
└── rust-toolchain.toml
```

## **Design**

### **Contracts — MASM only**

`contracts/masm/` holds plain `.masm` files. They are `include_str!`ed by `integration/src/battleship.rs` and assembled with `miden-client`'s `CodeBuilder` whenever `BattleshipScripts::compile()` runs (tests, binaries) — and, in the frontend, by the web SDK's `CodeBuilder` from the same files. There are no contract crates, no `cargo miden build` and no `.masp` artifacts.

The account component is compiled under the module path `battleship::account`; note and transaction scripts `call` into it and are compiled with the component code linked dynamically. Two sources are templates: the component embeds its initial storage commitment (`{{ISCn}}`, filled by `account_masm()`), the stake note the roots of the defeat and forfeit scripts (`stake_note_masm`).

Game accounts are private. The handshake notes carry the sender's account seed, and the consuming account checks that the seed derives the opponent's id from this very code and initial storage, and that the opponent pinned the same note script roots — so both players provably run the same contract. Every shot and result note is created by the account component with a deterministic serial, carries a deadline, and can be reclaimed by its sender after the deadline (forfeit).

### **Integration crate — tests and testnet binaries**

- `battleship.rs` is the single source of truth for storage slot names, note storage layouts, the setup payload and the predicted component notes (`expected_*_note`); `frontend-template/src/config.ts` and `src/lib/notes.ts` mirror it.
- `helpers.rs` builds a testnet client per player (`testnet-store-<name>.sqlite3`, `testnet-keystore-<name>/`), creates the private game account and the public wallet, funds them from the public faucet (`/pow` + `/get_tokens` with a SHA-256 proof of work, 10,000 base units per claim) and wraps the protocol: `Move` / `submit_move` (consume the opponent's notes and fire in one transaction), `plan_shot`, `plan_resolution`, `reclaim`, `stake`, `claim`.
- The MockChain harness charges a base fee of 100 per transaction so the `NoAuth` fee-payment path matches testnet; it keeps a copy of each private account's state and applies every transaction's patch.

## **Commands**

### Assemble the MASM

```bash
cargo test -p integration --release --lib all_masm_compiles
```

### Run the MockChain tests

```bash
cargo test -p integration --release                      # all 31 tests
cargo test -p integration --release --test battleship_failure_test
cargo test -p integration --release --test stake_test
```

### Validate on testnet

```bash
cargo run --bin validate_testnet --release
```

Creates two private game accounts and two wallets, funds them from the faucet (four claims; the first transaction deploys each account), publishes both stakes, performs the handshake, checks that an early reclaim is rejected, plays a full game with one transaction per move (33 shots) and has the winner's wallet claim the defeat note with both stakes. It prints `DONE in <n>s: full staked game validated on testnet` after about 6 minutes; state lives in `testnet-store-validate-{a,b}.sqlite3` and `testnet-keystore-validate-{a,b}/`. The forfeit path needs 12 hours to pass and is covered by the MockChain tests only.

### Play from the terminal

```bash
# terminal 1
cargo run --bin battleship_cli --release -- --player alice --role challenger --game-id demo --stake 2000
# terminal 2
cargo run --bin battleship_cli --release -- --player bob --role acceptor --game-id demo --stake 2000
```

Each run creates and funds a fresh game account and a wallet and prints the game account's `mtst1...` address; pass the other player's address with `--opponent <bech32>` or paste it when prompted. `--stake` is optional (0 = friendly game) and must match on both sides. The challenger fires first; shots are entered as `A5`, `J10`. When the opponent's deadline passes without an answer, the CLI reclaims the pending note and lets the wallet claim the forfeit. The CLI can also play against the web frontend.

## **Adding a Procedure or a Note**

1. Add the procedure to `contracts/masm/battleship_account.masm` with a `#!` doc comment (inputs, outputs, panics) and `const ERR_...` messages for every assertion.
2. For a new note, add `contracts/masm/<name>_note.masm`, a `*_MASM` constant and a field in `BattleshipScripts` (`battleship.rs`), plus a storage builder/parser and, if the component creates it, an `expected_*_note` predictor and a stored root.
3. Add a `Game` helper in `integration/tests/common/mod.rs` and tests in `battleship_test.rs` / `battleship_failure_test.rs` / `stake_test.rs`.
4. Mirror the layout in `frontend-template/src/config.ts`, `src/lib/masmSources.ts`, `src/lib/contracts.ts` and `src/lib/notes.ts`.

A new storage slot changes the initial storage commitment and with it every game account id; keep `all_storage_slots()` and the frontend's `battleshipStorageSlots()` identical (compare with `cargo test -p integration --release --lib print_init_storage_commitment -- --nocapture`).

## **Fees**

Testnet 0.17 charges every transaction a fee in USDCx (6 decimals): about 105 base units per battleship transaction. `ensure_funded` tops an account up from the faucet when its balance drops below `MIN_FEE_BALANCE` (2,000) in the binaries. Stakes are paid in the same asset from the wallets (`TESTNET_STAKE` = 2,000 in the validator).

## AI Developer Experience

This project includes resources for AI-assisted development:
- `CLAUDE.md` / `AGENTS.md` — Project context loaded automatically by coding agents
- `.claude/skills/` — On-demand skills for MASM patterns, pitfalls, MockChain testing, testnet validation and source exploration
