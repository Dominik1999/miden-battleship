---
name: rust-sdk-testing-patterns
description: Guide to testing the MASM contracts with miden-testing 0.17's MockChain. Covers the shared Game harness with private game accounts and public wallets, fee-charging chain setup, running transaction scripts with advice inputs, moves that consume notes and fire in one transaction, output notes created by account code, deadlines and forfeits, stake notes, storage assertions and matching MASM error messages. Use when writing, editing, or debugging integration tests in integration/tests/.
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
    let mut game = Game::new()?;                       // compiles the MASM, 3 players, fees on
    let (a, b) = (game.a.id, game.b.id);
    let shot = game.handshake(0, 0).await?;            // setup, challenge, accept; A fires turn 1 at (0, 0)
    let (result, defeat) = game.resolve(b, &shot).await?;   // B consumes the shot, creates the result note
    assert_eq!(game.cell(b, 0, 0)?, CELL_HIT);
    assert_eq!(game.state(b)?.ships_hit_count, 1);
    assert!(ResultNoteStorage::from_note(&result)?.result.is_hit);
    assert!(defeat.is_none());
    let next = game.answer(a, &result, 9, 9).await?;   // A consumes the result and fires turn 3
    assert_eq!(game.state(a)?.results_processed, 1);
    assert_eq!(ShotNoteStorage::from_note(&next)?.turn, 3);
    Ok(())
}
```

See [battleship_test.rs](../../../integration/tests/battleship_test.rs) for the success paths, [battleship_failure_test.rs](../../../integration/tests/battleship_failure_test.rs) for rejections and [stake_test.rs](../../../integration/tests/stake_test.rs) for the wallet-level stake flows.

## The `Game` Harness

| Member | What it does |
|--------|--------------|
| `Game::new()` | `MockChain::builder().verification_base_fee(BASE_FEE)`; players A, B and a stranger C, each with a PRIVATE game account (`game_account_builder(seed, component).build()`, funded by a genesis P2ID note of the fee asset) and a public owner wallet (`add_existing_wallet_with_assets`) |
| `Player { id, seed, wallet, account, deployed }` | The seed is carried in the handshake notes; `account` is the harness's copy of the private state |
| `state(id)`, `cell(id, row, col)`, `fee_balance(id)`, `wallet_balance(wallet)` | Read the harness copy via `GameState::from_account`, `read_board_cell`, the vault |
| `now()`, `deadline()`, `advance_time(secs)` | Latest block timestamp, a deadline exactly 12 h later, an empty block `secs` later |
| `execute(id, configure)` | `chain.build_transaction(account)` -> configure the `MockTransactionBuilder` -> `execute()` -> `add_pending_executed_transaction` -> `prove_next_block` -> `apply_patch` on the harness copy |
| `execute_wallet(wallet, configure)` | The same for a public wallet (no local copy needed) |
| `fund(id)` | Consumes the genesis funding note: deploys the game account |
| `run_script(id, script, arg, advice_map, expected)` | `tx_script` + `tx_script_args` + `add_advice_map_entry` + `expected_output_note` |
| `setup(id)` / `setup_with_rows(id, rows)` | Runs `setup_tx` with the classic board (or custom rows for failure tests), the owner wallet and the compiled roots; call `fund(id)` first |
| `publish(from, note)` | `SendNotesTransactionScript` from the account interface + `expected_output_note(RawOutputNote::Full(note))` — the client's `own_output_notes` path; used for handshake notes |
| `consume(id, &note)` / `consume_with(id, &note, args, expected, tx_script)` | `authenticated_input_note` (+ `extend_note_args`, `expected_output_note`, `tx_script`) |
| `challenge_note()`, `accept_note()`, `handshake_note(from, challenge)` | `make_game_note` with `handshake_storage(game id, sender, seed, wallet, roots)` and a fresh serial |
| `next_fire_turn(id)`, `shot_note_for(shooter, row, col, deadline)` | The turn the account fires next and the note `fire_shot` will create |
| `fire(shooter, row, col)` / `fire_with_deadline` | Runs `fire_tx` with `fire_args` and the predicted shot note as expected output |
| `handshake(row, col)` | Funds and sets up both, A challenges, B accepts, A consumes the acceptance and fires turn 1; returns the shot note |
| `accept_and_fire(&accept, row, col)` | A consumes the accept note and fires in the same transaction |
| `predict(defender, row, col)`, `resolve(defender, &shot)` / `resolve_with_deadline` | The defender consumes the shot with `shot_note_args(result_deadline)`, expecting the result note (and the defeat note on the 17th hit) |
| `answer(shooter, &result, row, col)` | The shooter consumes the result note and fires the next shot in one transaction |
| `reclaim(id, &note)` | The sender consumes its own note after the deadline; returns the forfeit note |
| `stake(player)` / `stake_custom(player, opp_game, expiry)` | The owner wallet publishes a stake note of `STAKE` fee-asset units |
| `claim(wallet, &[&note, ..])` | The wallet consumes the notes in one transaction (claim or refund) |
| `play_to_defeat()` | After the handshake, A sinks B's classic fleet while B misses; returns the defeat note |
| `is_committed(&note)` | Whether the chain holds the note |

## Step-by-Step Patterns

### 1. Chain with fees, private game accounts and wallets
```rust
let mut builder = MockChain::builder().verification_base_fee(100);
let wallet = builder.add_existing_wallet_with_assets(Auth::IncrNonce, [funds.into()])?.id();
let account = game_account_builder(seed, component).build()?;   // private, not yet on chain
builder.add_p2id_note_with_fee(account.id(), INITIAL_FEE_BALANCE)?;
let mut chain = builder.build()?;
```
With base fee 0 a transaction that changes nothing fails ("neither changed the account state, nor consumed any notes"); keep fees on. The chain only knows a private account's commitment: execute from your copy (`chain.build_transaction(account)`) and `apply_patch` afterwards, as `Game::execute` does.

### 2. Run a transaction script with an advice-map payload
```rust
let payload = build_setup_payload(word(GAME_ID), opponent, owner_wallet, &rows, &game.scripts.roots());
let key = setup_payload_commitment(&payload);
game.run_script(id, game.scripts.setup_tx.clone(), Some(key), vec![(key, payload)], vec![]).await?;
```

### 3. Publish and consume a handshake note
```rust
let challenge = game.challenge_note()?;            // carries A's seed, wallet and roots
game.publish(game.a.id, challenge.clone()).await?;  // committed in a new block
game.consume(game.b.id, &challenge).await?;         // verifies seed derivation and roots
assert_eq!(game.state(game.b.id)?.phase, PHASE_ACTIVE);
```

### 4. A move: consume the opponent's notes and fire in one transaction
```rust
let shot = game.handshake(0, 0).await?;                    // A fired turn 1
let (result, _) = game.resolve(game.b.id, &shot).await?;   // B: process_shot + result note
let next = game.answer(game.a.id, &result, 1, 1).await?;   // A: process_result + fire_shot
// under the hood: consume_with(shooter, &result, None, vec![next_shot], Some((fire_tx, fire_args(..))))
```
The component creates the output notes; the harness declares them with `expected_output_note(RawOutputNote::Full(note))` built from `expected_shot_note` / `expected_result_note` / `expected_defeat_note` / `expected_forfeit_note`, exactly like the client's `expected_output_recipients`.

### 5. Deadlines and forfeits
```rust
let shot = game.handshake(0, 0).await?;
game.advance_time(DEADLINE_DELTA + 1)?;             // past the 12 h deadline
let forfeit = game.reclaim(game.a.id, &shot).await?;
assert_eq!(game.state(game.a.id)?.outcome, OUTCOME_WON_BY_FORFEIT);
```
`game.deadline()` is exactly 12 h after the latest block; `fire_with_deadline` / `resolve_with_deadline` take a custom one for the "too short" rejections.

### 6. Stakes
```rust
let stake_a = game.stake(game.a.id).await?;
let stake_b = game.stake(game.b.id).await?;
let defeat = game.play_to_defeat().await?;
let before = game.wallet_balance(game.a.wallet)?;
game.claim(game.a.wallet, &[&defeat, &stake_a, &stake_b]).await?;
assert!(game.wallet_balance(game.a.wallet)? > before + 2 * STAKE - 10_000);   // both stakes minus the fee
```

### 7. Assert a rejection by its MASM message
```rust
let result = game.consume(game.c.id, &shot).await;   // stranger
assert_masm_error(result, "note sender prefix does not match the stored opponent");
```
`assert_masm_error` downcasts to `TransactionExecutorError::TransactionProgramExecutionFailed` and uses `MasmError::new(msg).matches_execution_error`. The message must equal the `ERR_...` constant in the MASM. Outside the harness (a client without the source manager) only the error code is printed: `masm_error_code(message)` / `is_masm_error(&err, message)`.

## Key Dependencies

See [integration/Cargo.toml](../../../integration/Cargo.toml): `miden-testing` 0.17.1, `miden-protocol` 0.17.1 (`testing`), `miden-standards` 0.17.1 (`testing`), `miden-client` 0.17.2 (`testing`, `tonic`), `blake3`, `tokio`, `anyhow`.

## Validation Checklist

- [ ] Test is `async` with `#[tokio::test]` and returns `anyhow::Result<()>`
- [ ] Uses the `Game` harness (fees on, three players with wallets) rather than a hand-built chain
- [ ] Every success test asserts storage (`state`, `cell`, `wallet_balance`) — not just `is_ok()`
- [ ] Every failure test uses `assert_masm_error` with the exact `ERR_...` message
- [ ] A transaction that creates a note from account code declares it with the `expected_*_note` predictor (`resolve`, `answer`, `fire`, `reclaim`)
- [ ] New harness helpers mirror what the client does (`own_output_notes`, `expected_output_recipients`, `Move`) so `helpers.rs` and the frontend can reuse the flow
