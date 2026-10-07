---
name: rust-sdk-testing-patterns
description: Guide to testing the MASM contracts with miden-testing 0.17's MockChain. Covers the shared Game harness, fee-charging chain setup, running transaction scripts with advice inputs, publishing and consuming notes, output notes created by account code, storage assertions, matching MASM error messages, and cycle measurements. Use when writing, editing, or debugging integration tests in integration/tests/.
---

# MockChain Testing Patterns (miden-testing 0.17)

## Test File Setup

Tests go in `integration/tests/`. All tests are async (`#[tokio::test]`) and use the shared harness in [tests/common/mod.rs](../../../integration/tests/common/mod.rs):

```rust
mod common;
use anyhow::Result;
use common::*;
use integration::battleship::*;

#[tokio::test]
async fn shot_hit_marks_cell_and_counts() -> Result<()> {
    let mut game = Game::new()?;          // compiles the MASM, 3 funded accounts, fees on
    game.handshake().await?;              // both ACTIVE
    let (_, result) = game.fire(game.a, game.b, 0, 0, 1).await?;
    assert_eq!(game.cell(game.b, 0, 0)?, CELL_HIT);
    assert_eq!(game.state(game.b)?.ships_hit_count, 1);
    assert_eq!(ResultNoteStorage::from_items(result.recipient().storage().items())?.result.encode(), 2);
    Ok(())
}
```

See [battleship_test.rs](../../../integration/tests/battleship_test.rs) for the success paths and [battleship_failure_test.rs](../../../integration/tests/battleship_failure_test.rs) for rejections.

## The `Game` Harness

| Member | What it does |
|--------|--------------|
| `Game::new()` / `with_base_fee(n)` | `MockChain::builder().verification_base_fee(BASE_FEE)`; accounts A, B (players) and C (stranger) built with `game_account_builder(seed, component).with_assets([fee asset]).build_existing()` |
| `state(id)`, `cell(id, row, col)`, `fee_balance(id)` | Read committed storage via `GameState::from_account`, `read_board_cell`, the vault |
| `execute(id, configure)` | `chain.build_transaction(id)` -> configure the `MockTransactionBuilder` -> `build()?.execute().await?` -> `add_pending_executed_transaction` -> `prove_next_block` |
| `run_script(id, script, arg, advice_map)` | `tx_script` + `tx_script_args` + `add_advice_map_entry` |
| `setup(id, opponent, commitment)` / `setup_with_rows` | Runs `setup_tx` with the classic board (or custom rows for failure tests) |
| `publish(from, note)` | `SendNotesTransactionScript` from the account interface + `expected_output_note(RawOutputNote::Full(note))` — the same path as the client's `own_output_notes` |
| `consume(id, &note)` | `authenticated_input_note(note.id())` |
| `consume_shot(id, &shot)` | adds `add_note_script(result_script)` so the executor can build the result note the component creates |
| `consume_shot_expecting(id, &shot, expected)` | declares the exact result note (`expected_output_note`) — the client's `expected_output_recipients` path |
| `challenge_note()`, `accept_note()`, `shot_note(..)`, `reveal_note(..)` | `make_game_note` with fresh serials |
| `handshake()`, `fire(shooter, defender, row, col, turn)` | Multi-step flows; `fire` returns the defender's tx and the result note |
| `result_note_of(&executed)` | Finds the output note whose script root is the result script |

## Step-by-Step Patterns

### 1. Chain with fees and funded accounts
```rust
let mut builder = MockChain::builder().verification_base_fee(100);
let fee_asset = FungibleAsset::new(fee_faucet_id(), 10_000_000)?;   // ACCOUNT_ID_FEE_FAUCET
let account = game_account_builder(seed, component).with_assets([fee_asset.into()]).build_existing()?;
builder.add_account(account.clone())?;
let mut chain = builder.build()?;
```
With base fee 0 a transaction that changes nothing fails ("neither changed the account state, nor consumed any notes"); keep fees on.

### 2. Run a transaction script with an advice-map payload
```rust
let payload = build_setup_payload(word(GAME_ID), opponent, word(commitment), &rows);
let key = setup_payload_commitment(&payload);
game.run_script(id, game.scripts.setup_tx.clone(), Some(key), vec![(key, payload)]).await?;
```

### 3. Publish and consume a note
```rust
let challenge = game.challenge_note()?;
game.publish(game.a, challenge.clone()).await?;   // committed in a new block
game.consume(game.b, &challenge).await?;
assert_eq!(game.state(game.b)?.phase, PHASE_ACTIVE);
```

### 4. Output note created by account code
```rust
let (executed, result) = game.fire(game.a, game.b, 5, 5, 1).await?;   // consume_shot under the hood
assert_eq!(result.metadata().tag(), NoteTag::with_account_target(game.a));
// or declare it up front:
let expected = expected_result_note(game.scripts.result_note.clone(), game.b, game.a, 1, ShotResult { is_hit: false, game_over: false }, result_serial)?;
game.consume_shot_expecting(game.b, &shot, expected).await?;
```

### 5. Assert a rejection by its MASM message
```rust
let result = game.consume(game.c, &shot).await;   // stranger
assert_masm_error(result, "note sender prefix does not match the stored opponent");
```
`assert_masm_error` downcasts to `TransactionExecutorError::TransactionProgramExecutionFailed` and uses `MasmError::new(msg).matches_execution_error`. The message must equal the `ERR_...` constant in the MASM.

### 6. Measure cycles
```rust
let m = executed.measurements();
println!("{} cycles, 2^{} trace, fee {}", m.total_cycles(), m.total_cycles().next_power_of_two().trailing_zeros(), executed.compute_fee().as_u64());
```
Run `cargo test -p integration --release --test cycle_benchmark_test -- --nocapture`.

## Key Dependencies

See [integration/Cargo.toml](../../../integration/Cargo.toml): `miden-testing` 0.17.1, `miden-protocol` 0.17.1 (`testing`), `miden-standards` 0.17.1 (`testing`), `miden-client` 0.17.2 (`testing`, `tonic`), `tokio`, `anyhow`.

## Validation Checklist

- [ ] Test is `async` with `#[tokio::test]` and returns `anyhow::Result<()>`
- [ ] Uses the `Game` harness (fees on, three accounts) rather than a hand-built chain
- [ ] Every success test asserts storage (`state`, `cell`) — not just `is_ok()`
- [ ] Every failure test uses `assert_masm_error` with the exact `ERR_...` message
- [ ] A transaction that creates a note from account code uses `consume_shot` / `consume_shot_expecting`
- [ ] New harness helpers mirror what the client does (`own_output_notes`, `expected_output_recipients`) so `validate_testnet.rs` can reuse the flow
