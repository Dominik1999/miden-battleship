# Miden Battleship Contracts

This is the contract half of Miden Battleship: Miden Assembly (MASM) contracts plus a Rust integration crate that compiles them at runtime with `miden-client` 0.17.2's `CodeBuilder`.

## Project Structure

- `contracts/masm/` — MASM sources (no crates, no build step)
  - `battleship_account.masm` — the account component (`battleship::account`): storage layout, `set_board_rows`, `finalize_board`, `accept_challenge`, `receive_acceptance`, `process_shot`, `enter_reveal`, `mark_my_reveal`, `verify_opponent_reveal`
  - `challenge_note.masm`, `accept_note.masm`, `shot_note.masm`, `reveal_note.masm` — note scripts that load the note storage and `call` one component procedure
  - `result_note.masm` — no-op script; the note is a data carrier created by `process_shot`
  - `scripts/setup_tx.masm`, `scripts/enter_reveal_tx.masm`, `scripts/mark_my_reveal_tx.masm` — transaction scripts
- `integration/` — workspace member
  - `src/battleship.rs` — `include_str!`s the MASM, `BattleshipScripts::compile()`, storage slot names, board packing, note storage builders/parsers, `GameState`
  - `src/helpers.rs` — testnet client setup, faucet funding (proof of work), note discovery, transaction wrappers
  - `src/bin/validate_testnet.rs` — scripted full game on testnet (the gate)
  - `src/bin/battleship_cli.rs` — interactive two-terminal game on testnet
  - `tests/common/mod.rs` — MockChain harness (`Game`); `tests/battleship_test.rs`, `tests/battleship_failure_test.rs`, `tests/cycle_benchmark_test.rs`
- `rust-toolchain.toml` — Rust 1.98.1
- Dependencies (`integration/Cargo.toml`): `miden-client` 0.17.2 (`tonic`, `testing`), `miden-client-sqlite-store` 0.17.2, `miden-testing` 0.17.1, `miden-protocol` 0.17.1, `miden-standards` 0.17.1

## Build & Test

There is nothing to build ahead of time. The sources are assembled when `BattleshipScripts::compile()` runs:
```
cargo test -p integration --release --lib all_masm_compiles   # assemble everything (seconds)
cargo test -p integration --release                            # 31 tests on a fee-charging MockChain
cargo run --bin validate_testnet --release                     # full game on testnet, two clients
cargo run --bin battleship_cli --release -- --player alice --role challenger --game-id demo
```

Every MASM edit must be followed by the MockChain tests; the testnet binary is the gate before frontend work. The `.claude/hooks/build-contracts.sh` hook predates the migration and does nothing for `.masm` files.

## How the pieces fit

- The component is compiled under the module path `battleship::account` (`COMPONENT_PATH`). Note and tx scripts `use battleship::account as battleship` and `call.battleship::<proc>`; they are compiled with `CodeBuilder::with_dynamically_linked_package(component_code)` so the calls bind to the procedures installed on the account.
- A game account is `AccountBuilder` + battleship component + `BasicWallet` + `NoAuth`, type `Public` (`game_account_builder`). `build_existing()` in tests, `build()` for a new account that the first transaction deploys.
- Storage slot names are `miden_battleship_account::battleship_account::<slot>`; keep `battleship_account.masm`, `battleship.rs` and `frontend-template/src/config.ts` in sync.
- Setup runs as a transaction script: the 20-felt payload goes into the advice map under a key passed as the script argument (`setup_payload_commitment` = sequential hash of the payload; any word works).
- Notes are built with `make_game_note(script, sender, target, storage, serial)`: public, no assets, `NoteTag::with_account_target(target)`. The recipient's client finds them during sync without registering tags.
- The defender consumes a shot note with `expected_output_recipients([result_recipient])` (client) or `add_note_script(result_script)` (MockChain) so the executor can materialize the result note the component creates.

## Critical Pitfalls

**Stack discipline is the whole game.** Every `@account_procedure` is entered with `call` and sees a 16-element window; every note/tx script must leave `[pad(16)]`. Keep the `# => [...]` stack comments current on every line you touch, and end procedures with `exec.sys::truncate_stack`.

**Felt arithmetic is modular.** `sub` wraps around the field. Use `u32assert`/`u32lt`/`u32lte` for counts and coordinates (see `assert_in_bounds`, `count_row_cells`); never compare felts with `lt` for quantity logic.

**Assertion messages are the test contract.** Every rejection is a `const ERR_... = "..."` used with `assert.err=` / `assert_eq.err=` / `assertz.err=`. Failure tests match the message with `assert_masm_error(result, "...")`; add a constant and a test for every new check.

**Phase and sender checks come first.** Procedures called from notes start with `assert_sender_is_opponent` and a phase check; the tests `shot_rejected_from_stranger` and `*_rejected_in_*_phase` guard this.

**Fees are real.** The MockChain charges `BASE_FEE = 100` per transaction, so a procedure that changes nothing still costs; an account must hold the fee asset before its first transaction.

## Verification Workflow

After modifying contract code, always:
1. Write or update the test first in `integration/tests/` (success in `battleship_test.rs`, rejection in `battleship_failure_test.rs`)
2. Run `cargo test -p integration --release` — assembly errors surface here
3. For changes to transactions' size, check `cargo test -p integration --release --test cycle_benchmark_test -- --nocapture` (setup ~31k, shot ~18k, publish ~11k cycles today)
4. Before frontend work: `cargo run --bin validate_testnet --release`
5. Run `cargo clippy --all-targets` and `cargo fmt` before committing

## Advanced Development

For questions the skills do not answer (kernel procedure stack contracts, standard components, client APIs):

1. Clone the Miden source repos alongside this project (see the `rust-sdk-source-guide` skill for the repo list and what to read)
2. Use Plan Mode first — design the storage and note flow before writing MASM
3. Use sub-agents to explore repos without filling the main context
