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
│       ├── battleship_account.masm  # Account component (battleship::account)
│       ├── challenge_note.masm      # Note scripts: each calls one component procedure
│       ├── accept_note.masm
│       ├── shot_note.masm
│       ├── result_note.masm         # Data carrier created by process_shot (no-op script)
│       ├── reveal_note.masm
│       └── scripts/
│           ├── setup_tx.masm        # Board setup from an advice-map payload
│           ├── enter_reveal_tx.masm
│           └── mark_my_reveal_tx.masm
├── integration/                     # Workspace member
│   ├── src/
│   │   ├── battleship.rs            # MASM compilation, storage layout, note builders, GameState
│   │   ├── helpers.rs               # Testnet client, faucet funding, tx wrappers
│   │   ├── lib.rs
│   │   └── bin/
│   │       ├── validate_testnet.rs  # Scripted full game on testnet (the gate)
│   │       └── battleship_cli.rs    # Interactive two-terminal game on testnet
│   └── tests/
│       ├── common/mod.rs            # MockChain harness (Game)
│       ├── battleship_test.rs       # Success paths
│       ├── battleship_failure_test.rs # Rejections, matched by MASM error message
│       └── cycle_benchmark_test.rs  # Cycle counts per transaction
├── Cargo.toml                       # Workspace root (contracts/ is excluded: it holds no crates)
└── rust-toolchain.toml
```

## **Design**

### **Contracts — MASM only**

`contracts/masm/` holds plain `.masm` files. They are `include_str!`ed by `integration/src/battleship.rs` and assembled with `miden-client`'s `CodeBuilder` whenever `BattleshipScripts::compile()` runs (tests, binaries) — and, in the frontend, by the web SDK's `CodeBuilder` from the same files. There are no contract crates, no `cargo miden build` and no `.masp` artifacts.

The account component is compiled under the module path `battleship::account`; note and transaction scripts `call` into it and are compiled with the component code linked dynamically.

### **Integration crate — tests and testnet binaries**

- `battleship.rs` is the single source of truth for storage slot names, note storage layouts and the setup payload; `frontend-template/src/config.ts` mirrors it.
- `helpers.rs` builds a testnet client per player (`testnet-store-<name>.sqlite3`, `testnet-keystore-<name>/`), funds accounts from the public faucet (`/pow` + `/get_tokens` with a SHA-256 proof of work, 10,000 base units per claim) and wraps transactions (`publish_note`, `consume_notes`, `consume_shot_note`, `run_tx_script`).
- The MockChain harness charges a base fee of 100 per transaction so the `NoAuth` fee-payment path matches testnet.

## **Commands**

### Assemble the MASM

```bash
cargo test -p integration --release --lib all_masm_compiles
```

### Run the MockChain tests

```bash
cargo test -p integration --release                      # all 31 tests
cargo test -p integration --release --test battleship_failure_test
cargo test -p integration --release --test cycle_benchmark_test -- --nocapture
```

### Validate on testnet

```bash
cargo run --bin validate_testnet --release
```

Creates two game accounts, funds them from the faucet (which also deploys them), plays a full game with two independent clients and asserts the storage after every step. Takes about 8–9 minutes and ~4,200 base units of USDCx per account; state lives in `testnet-store-validate-{a,b}.sqlite3` and `testnet-keystore-validate-{a,b}/`.

### Play from the terminal

```bash
# terminal 1
cargo run --bin battleship_cli --release -- --player alice --role challenger --game-id demo
# terminal 2
cargo run --bin battleship_cli --release -- --player bob --role acceptor --game-id demo
```

Each run creates and funds a fresh game account and prints its `mtst1...` address; pass the other player's address with `--opponent <bech32>` or paste it when prompted. The challenger fires first; shots are entered as `A5`, `J10`.

## **Adding a Procedure or a Note**

1. Add the procedure to `contracts/masm/battleship_account.masm` with a `#!` doc comment (inputs, outputs, panics) and `const ERR_...` messages for every assertion.
2. For a new note, add `contracts/masm/<name>_note.masm`, a `*_MASM` constant and a field in `BattleshipScripts` (`battleship.rs`), plus a storage builder/parser.
3. Add a `Game` helper in `integration/tests/common/mod.rs` and tests in `battleship_test.rs` / `battleship_failure_test.rs`.
4. Mirror the layout in `frontend-template/src/config.ts`, `src/lib/masmSources.ts` and `src/lib/contracts.ts`.

## **Fees**

Testnet 0.17 charges every transaction a fee in USDCx (6 decimals): about 105 base units per battleship transaction. `ensure_funded` tops an account up from the faucet when its balance drops below `MIN_FEE_BALANCE` (2,000) in the binaries.

## AI Developer Experience

This project includes resources for AI-assisted development:
- `CLAUDE.md` / `AGENTS.md` — Project context loaded automatically by coding agents
- `.claude/skills/` — On-demand skills for MASM patterns, pitfalls, MockChain testing, testnet validation and source exploration
