# Miden Battleship Contracts

This is the contract half of Miden Battleship: Miden Assembly (MASM) contracts plus a Rust integration crate that compiles them at runtime with `miden-client` 0.17.2's `CodeBuilder`.

## Project Structure

- `contracts/masm/` — MASM sources (no crates, no build step)
  - `battleship_account.masm` — the account component (`battleship::account`): storage layout, `set_board_rows`, `set_script_roots`, `finalize_board`, `assert_script_roots`, `accept_challenge`, `receive_acceptance`, `fire_shot`, `process_shot`, `process_result`, `claim_forfeit`, `get_cell`, `get_game_phase`. A template: `{{ISC0..3}}` is replaced by the initial storage commitment before assembling
  - `challenge_note.masm`, `accept_note.masm` — handshake note scripts (28 storage items: game id, sender, seed, wallet, four script roots); they `call` `assert_script_roots` then the handshake procedure
  - `shot_note.masm`, `result_note.masm` — created by the component (`fire_shot` / `process_shot`); the script runs `process_shot` / `process_result` on the opponent, or `claim_forfeit` when the sender consumes its own note after the deadline
  - `defeat_note.masm`, `forfeit_note.masm` — wallet-targeted proof notes created by the component (`[wallet_prefix, wallet_suffix]`); only the named wallet can consume them
  - `stake_note.masm` — conditional P2ID published by a wallet; a template with `{{DEFEATn}}` / `{{FORFEITn}}` placeholders for the roots it recognises
  - `scripts/setup_tx.masm`, `scripts/fire_tx.masm` — transaction scripts
- `integration/` — workspace member
  - `src/battleship.rs` — `include_str!`s the MASM, `init_storage_commitment()`, `BattleshipScripts::compile()`, storage slot names, board packing, payload/storage builders and parsers, `expected_*_note` predictors, `GameState`, `masm_error_code` / `is_masm_error`
  - `src/helpers.rs` — testnet client setup, account creation, faucet funding (proof of work), note discovery, `Move` / `submit_move`, `plan_shot`, `plan_resolution`, `reclaim`, `stake`, `claim`
  - `src/bin/validate_testnet.rs` — scripted full staked game on testnet (the gate)
  - `src/bin/battleship_cli.rs` — interactive two-terminal game on testnet (`--stake`)
  - `tests/common/mod.rs` — MockChain harness (`Game`); `tests/battleship_test.rs` (8), `tests/battleship_failure_test.rs` (12), `tests/stake_test.rs` (6)
- `rust-toolchain.toml` — Rust 1.98.1
- Dependencies (`integration/Cargo.toml`): `miden-client` 0.17.2 (`tonic`, `testing`), `miden-client-sqlite-store` 0.17.2, `miden-testing` 0.17.1, `miden-protocol` 0.17.1, `miden-standards` 0.17.1, `blake3`

## Build & Test

There is nothing to build ahead of time. The sources are assembled when `BattleshipScripts::compile()` runs:
```
cargo test -p integration --release --lib all_masm_compiles   # assemble everything (seconds)
cargo test -p integration --release                            # 31 tests on a fee-charging MockChain
cargo run --bin validate_testnet --release                     # full staked game on testnet, two clients
cargo run --bin battleship_cli --release -- --player alice --role challenger --game-id demo --stake 2000
```

Every MASM edit must be followed by the MockChain tests; the testnet binary is the gate before frontend work. The `.claude/hooks/build-contracts.sh` hook predates the migration and does nothing for `.masm` files.

## How the pieces fit

- The component is compiled under the module path `battleship::account` (`COMPONENT_PATH`). Note and tx scripts `use battleship::account as battleship` and `call.battleship::<proc>`; they are compiled with `CodeBuilder::with_dynamically_linked_package(component_code)` so the calls bind to the procedures installed on the account.
- A game account is PRIVATE: `AccountBuilder` + battleship component + `BasicWallet` + `NoAuth`, `AccountType::Private` (`game_account_builder`), always `build()`; the first transaction (consuming the funding note) deploys it. The chain only knows the account commitment, so the MockChain harness keeps a copy of each account and applies every transaction's patch.
- **Code anchoring.** The component embeds its initial storage commitment (`init_storage_commitment()` substituted into `{{ISCn}}` by `account_masm()`). The handshake notes carry the sender's account seed (`account.seed()`), and `accept_challenge` / `receive_acceptance` recompute the opponent's id from (seed, own code commitment, pinned initial storage commitment) and compare the carried script roots with the ones stored at setup. The browser must build accounts with `buildWithoutSchemaCommitment()` to produce the same commitment; `init_storage_commitment_matches_a_built_account` and `print_init_storage_commitment` keep both sides honest.
- Storage slot names are `miden_battleship_account::battleship_account::<slot>`; keep `battleship_account.masm`, `battleship.rs` (`all_storage_slots()`, order matters for the commitment) and `frontend-template/src/config.ts` / `contracts.ts` in sync.
- Setup runs as a transaction script: the 36-felt payload (`build_setup_payload`: game id, opponent, owner wallet, rows, four roots, padding) goes into the advice map under a key passed as the script argument (`setup_payload_commitment` = sequential hash of the payload; any word works).
- Handshake notes are built with `make_game_note(script, sender, target, storage, serial)`: public, no assets, `NoteTag::with_account_target(target)`. Every other game note is created by the component with deterministic serials `[prefix, suffix, turn, kind]` (`own_serial`); `expected_shot_note` / `expected_result_note` / `expected_defeat_note` / `expected_forfeit_note` predict them so the client can pass them as `expected_output_recipients`.
- A move is one transaction (`Move`: input notes with optional note args, expected output notes, optional `fire_args`): `submit_move` consumes the opponent's notes, then runs `fire_tx`. The defender passes `shot_note_args(result_deadline)` as the shot note's argument.
- Deadlines are block timestamps at least `DEADLINE_DELTA` (43,200 s) after the reference block (`helpers::deadline`). `reclaim` consumes an own unanswered note after its deadline and returns the forfeit note; the wallet's `claim` consumes the defeat/forfeit note with both stake notes.
- A client without the source manager reports a MASM assertion only as a bare error code: `blake3(message)[0..8]` little-endian (`masm_error_code`); `is_masm_error` matches either form.

## Critical Pitfalls

**Stack discipline is the whole game.** Every `@account_procedure` is entered with `call` and sees a 16-element window; every note/tx script must leave `[pad(16)]`. Keep the `# => [...]` stack comments current on every line you touch, and end procedures with `exec.sys::truncate_stack`.

**Felt arithmetic is modular.** `sub` wraps around the field. Use `u32assert`/`u32lt`/`u32lte`/`u32gte` for counts, coordinates and timestamps (see `assert_in_bounds`, `assert_deadline`, `count_row_cells`); never compare felts with `lt` for quantity logic.

**Assertion messages are the test contract.** Every rejection is a `const ERR_... = "..."` used with `assert.err=` / `assert_eq.err=` / `assertz.err=`. Failure tests match the message with `assert_masm_error(result, "...")`; add a constant and a test for every new check. Error codes are not part of the MAST root: two scripts that differ only in messages get the same root (that is why `defeat_note.masm` / `forfeit_note.masm` carry a structural `NOTE_KIND`).

**Phase and sender checks come first.** Procedures called from notes start with `assert_sender_is_opponent` and a phase check; `claim_forfeit` checks that the note is the account's own and carries a stored root. The tests `shot_rejected_with_wrong_turn_and_from_stranger`, `forfeit_rejected_by_non_sender` and `*_rejected_*` guard this.

**The initial storage commitment is part of the protocol.** Adding, removing or reordering a storage slot changes `init_storage_commitment()`, the embedded `{{ISCn}}` values and therefore every account id; the frontend recomputes it from a throwaway account, so the slot list in `battleshipStorageSlots()` must match `all_storage_slots()` exactly.

**Fees are real.** The MockChain charges `BASE_FEE = 100` per transaction, so a procedure that changes nothing still costs; an account must hold the fee asset before its first transaction. Stakes are paid in the fee asset from the owner wallets.

## Verification Workflow

After modifying contract code, always:
1. Write or update the test first in `integration/tests/` (success in `battleship_test.rs`, rejection in `battleship_failure_test.rs`, wallet/stake flows in `stake_test.rs`)
2. Run `cargo test -p integration --release` — assembly errors surface here
3. Before frontend work: `cargo run --bin validate_testnet --release` (the forfeit path needs 12 hours and is covered by the MockChain tests only)
4. Run `cargo clippy --all-targets` and `cargo fmt` before committing

## Advanced Development

For questions the skills do not answer (kernel procedure stack contracts, standard components, client APIs):

1. Clone the Miden source repos alongside this project (see the `rust-sdk-source-guide` skill for the repo list and what to read)
2. Use Plan Mode first — design the storage and note flow before writing MASM
3. Use sub-agents to explore repos without filling the main context
