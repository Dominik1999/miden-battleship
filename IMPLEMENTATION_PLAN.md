# Implementation Plan (Ordered, Dependency-Aware)

## Directory Convention

All new contracts go under `project-template/contracts/`. All tests go in `project-template/integration/tests/`. Helpers are extended in `project-template/integration/src/helpers.rs`.

```
project-template/contracts/
├── counter-account/          # existing (reference)
├── increment-note/           # existing (reference)
├── battleship-account/       # NEW - account component (6 Value slots + 1 StorageMap)
├── shot-note/                # NEW - note script (calls process_shot, creates result-note)
├── result-note/              # NEW - note script (P2ID only, minimal)
├── challenge-note/           # NEW - note script (calls accept_challenge)
├── accept-note/              # NEW - note script (calls receive_acceptance)
└── reveal-note/              # NEW - note script (calls verify_opponent_board)

project-template/integration/
├── src/
│   ├── helpers.rs            # MODIFY - add battleship-specific helpers
│   ├── lib.rs                # MODIFY - re-export new helpers
│   └── bin/
│       └── validate_local.rs # NEW (Phase 2)
└── tests/
    ├── counter_test.rs                # existing (reference)
    ├── battleship_unit_test.rs        # NEW - component method tests (1A, 1B, 1E)
    ├── battleship_notes_test.rs       # NEW - note script tests (1C, 1D, 1F)
    ├── battleship_integration_test.rs # NEW - victory + full game (1G, 1H)
    └── battleship_failure_test.rs     # NEW - negative/edge cases (1I-1N)
```

---

## SDK Constraints (discovered during planning)

1. **TX script args**: `#[tx_script] fn run(arg: Word)` — only a single Word (4 Felts). Cannot pass 62+ Felts for board setup.
2. **Component return types**: Single type only (no tuples). `process_shot` returns a single Felt encoding `result * 2 + game_over` (values 0-3).
3. **Note inputs**: Declared as struct fields on `#[note]` struct. Auto-deserialized from `active_note::get_inputs()`.
4. **Board setup approach**: Instead of a tx-script, call `place_ship()` 17 times + `finalize_setup()` once via `TransactionRequestBuilder`. Validation happens inside `finalize_setup()`.
5. **Grid size hardcoded**: `GRID_SIZE = 10` as constant in component. `place_ship()` validates bounds immediately. No dynamic grid_size needed for v1.
6. **Version pinning**: Copy exact versions from existing template (`miden = "0.10"` for contracts, integration deps as-is from `integration/Cargo.toml`). Do NOT guess or bump versions.

## Anti-Spoofing: Sender Validation

P2ID checks prevent wrong consumers but NOT fake notes from wrong senders. An attacker can create a spoofed accept-note or result-note addressed to the right account.

Each consuming method validates the sender against stored opponent:

| Method | Validates |
|--------|-----------|
| `accept_challenge()` | challenger_id in note inputs matches note sender |
| `receive_acceptance()` | acceptor_id matches sender, game_id matches stored |
| `verify_opponent_board()` | revealer_id == stored opponent_id |
| Client result-note trust | Only trust result-notes whose sender == stored opponent |

Tests: Spoofing tests — attacker creates fake notes addressed to victim → rejected by sender mismatch.

## Auth Component Composition

Every game account must include an auth component (e.g., `BasicAuth::SingleKey(Falcon512Rpo)`) from day one. Without it, no state-changing transaction can succeed (authentication + nonce increment required).

Test helper pattern (extends existing `create_testing_account_from_package`):
Game account = battleship-account component + BasicAuth component
This mirrors the existing `counter_test.rs` pattern where the sender wallet has auth. Game accounts need it too since they execute state-changing methods.

---

## Phase 0: Setup Batching Spike

### Task 0: Validate Multi-Method-Call TX

**Goal**: Confirm that `TransactionRequestBuilder` can batch 17 `place_ship()` + 1 `finalize_setup()` in a single transaction.

**Approach**: Use the existing counter-account. Build a test that calls `increment_count()` 3 times in one TX via `TransactionRequestBuilder`. If it works, the batching pattern is validated.

**Files**: `project-template/integration/tests/battleship_unit_test.rs` (first test in the file)

**If it fails**: Board setup needs a tx-script with advice inputs, or multiple transactions. Redesign before continuing.

- **Dependencies**: None (first task)
- **Gate**: Multiple method calls succeed in one TX

---

## Phase 1: Contracts + MockChain Tests

### Task 1A: battleship-account Component — Storage & Basic Methods

**Goal**: Implement the core account component with storage layout and board placement.

**Files to create**:

| File | Purpose |
|------|---------|
| `project-template/contracts/battleship-account/Cargo.toml` | `crate-type = ["cdylib"]`, depends on `miden = "0.10"` |
| `project-template/contracts/battleship-account/src/lib.rs` | `#[component]` with all storage slots and methods |

**Component implementation**:

Storage:
- `game_config`: Value — `[grid_size, num_ships, phase, expected_turn]`
- `opponent`: Value — `[opponent_prefix, opponent_suffix, ships_hit_count, total_shots_received]`
- `board_commitment`: Value — `[h0, h1, h2, h3]`
- `opponent_commitment`: Value — `[h0, h1, h2, h3]`
- `game_id`: Value — `[gid0, gid1, gid2, gid3]`
- `reveal_status`: Value — `[my_revealed, opponent_verified, 0, 0]`
- `my_board`: StorageMap — `key=(0,0,row,col)` → cell state

Methods (implement in this task):
- `place_ship(row: Felt, col: Felt, ship_id: Felt)` → basic validation: bounds, overlap, phase==CREATED
- `finalize_setup(game_id: Word, opponent_prefix: Felt, opponent_suffix: Felt, salt: Word)` → validates full board (correct ship counts/sizes, contiguity), computes salted commitment `H(game_id||player_id||salt||canonical_board)`, stores commitment, `grid_size=10` (constant), sets `phase=CHALLENGED`
- `get_cell(row: Felt, col: Felt) -> Felt`
- `get_game_phase() -> Felt`
- `accept_challenge(game_id: Word, opponent_prefix: Felt, opponent_suffix: Felt, opponent_commitment: Word)` → store opponent info, set `phase=ACTIVE`, `expected_turn=1` (B defends A's first shot which is turn 1)

Methods (stub only, implement in 1B):
- `process_shot(row: Felt, col: Felt, turn: Felt) -> Felt` → returns encoded result: `result * 2 + game_over` (0=miss, 2=hit, 1=miss+gameover, 3=hit+gameover)
- `enter_reveal()`
- `mark_my_reveal()`
- `verify_opponent_board(...)`

Constants:
```
GRID_SIZE = 10 (hardcoded for v1, no dynamic grid)
PHASE_CREATED = 0, PHASE_CHALLENGED = 1, PHASE_ACTIVE = 2, PHASE_REVEAL = 3, PHASE_COMPLETE = 4
CELL_WATER = 0, CELL_SHIP_1..5 = 1..5, CELL_HIT = 6, CELL_MISS = 7
```

Account composition: Game accounts MUST include `BasicAuth::SingleKey(Falcon512Rpo)` alongside the battleship component. Without auth, no state-changing TX succeeds. Test helper should create composed accounts from the start.

**Tests to write** (`project-template/integration/tests/battleship_unit_test.rs`):
- `test_create_account_with_battleship_component` — build package, create account with auth, verify default storage (all zeros)
- `test_place_ship_valid` — place ship cells, verify storage map entries
- `test_place_ship_out_of_bounds` — row/col >= 10 → TX fails
- `test_place_ship_overlap` — place on occupied cell → TX fails
- `test_finalize_setup` — place 17 cells + finalize → commitment stored, phase=CHALLENGED
- `test_accept_challenge` — call accept_challenge, verify phase transitions to ACTIVE

- **Dependencies**: Task 0 (batching spike)
- **Gate**: All storage reads/writes work correctly on MockChain

---

### Task 1B: Shot Logic & State Machine

**Goal**: Implement `process_shot()` with full validation, turn enforcement, and victory detection.

**Files to modify**:

| File | Change |
|------|--------|
| `project-template/contracts/battleship-account/src/lib.rs` | Implement `process_shot()`, `enter_reveal()` |

`process_shot(row, col, turn) -> Felt` logic:
1. Assert `phase == ACTIVE`
2. Assert `turn == expected_turn`
3. Read cell at `(row, col)` from `my_board`
4. Assert cell is not `CELL_HIT` and not `CELL_MISS` (not already shot)
5. If cell is `CELL_SHIP_1..5` → set to `CELL_HIT`, increment `ships_hit_count`, `result = 1`
6. If cell is `CELL_WATER` → set to `CELL_MISS`, `result = 0`
7. Increment `total_shots_received` and `expected_turn` (+2, since turns alternate)
8. If `ships_hit_count == 17` → set `phase = PHASE_REVEAL`, `game_over = 1`
9. Return `result * 2 + game_over` as single Felt (0=miss, 1=miss+gameover, 2=hit, 3=hit+gameover)

`enter_reveal()` logic:
1. Assert `phase == ACTIVE` (winner calls this after detecting game_over from result-note)
2. Set `phase = PHASE_REVEAL`

**Tests to write** (extend `battleship_unit_test.rs`):
- `test_process_shot_hit` — shot on ship cell → returns (1, 0), cell becomes HIT
- `test_process_shot_miss` — shot on water → returns (0, 0), cell becomes MISS
- `test_process_shot_wrong_turn` — turn != expected_turn → TX fails
- `test_process_shot_wrong_phase` — phase != ACTIVE → TX fails
- `test_process_shot_duplicate_cell` — shot on already-hit cell → TX fails
- `test_process_shot_increments_counters` — ships_hit_count and total_shots_received updated
- `test_enter_reveal` — phase transitions ACTIVE → REVEAL

- **Dependencies**: Task 1A
- **Gate**: process_shot correctly handles all valid/invalid inputs

---

### Task 1C: shot-note + result-note Scripts

**Goal**: Implement the shot and result note scripts. Shot-note calls `process_shot()` and creates a result-note via `output_note::create()`.

**Files to create**:

| File | Purpose |
|------|---------|
| `project-template/contracts/shot-note/Cargo.toml` | Note contract, depends on battleship-account component |
| `project-template/contracts/shot-note/src/lib.rs` | `#[note_script]`: P2ID check → `process_shot()` → `output_note::create()` |
| `project-template/contracts/result-note/Cargo.toml` | Note contract (minimal) |
| `project-template/contracts/result-note/src/lib.rs` | `#[note_script]`: P2ID check only (consumption cleans up UTXO) |

shot-note struct fields (auto-deserialized from note inputs):
```rust
#[note]
struct ShotNote {
    game_id: Word,                    // 4 Felts
    target_account_prefix: Felt,      // 1
    target_account_suffix: Felt,      // 1
    row: Felt,                        // 1
    col: Felt,                        // 1
    turn_number: Felt,                // 1
    result_serial: Word,              // 4
    result_script_digest: Word,       // 4
    shooter_account_prefix: Felt,     // 1
    shooter_account_suffix: Felt,     // 1
    shooter_tag: Felt,                // 1
}                                     // Total: 20 Felts
```

shot-note `run()` implementation:
1. P2ID check: assert `account::get_id()` matches `(self.target_account_prefix, self.target_account_suffix)`
2. Call `battleship_account::process_shot(self.row, self.col, self.turn_number)` → `encoded_result: Felt`
3. Decode: `result = encoded_result / 2`, `game_over = encoded_result % 2`
4. Build `recipient = Recipient::compute(self.result_serial, self.result_script_digest, [self.game_id, self.shooter_account_prefix, self.shooter_account_suffix, self.turn_number, result, game_over])`
5. `output_note::create(self.shooter_tag, NoteType::Public, recipient)`

result-note struct fields:
```rust
#[note]
struct ResultNote {
    game_id: Word,                    // 4 Felts
    target_account_prefix: Felt,      // 1
    target_account_suffix: Felt,      // 1
    turn_number: Felt,                // 1
    result: Felt,                     // 1 (0=miss, 1=hit)
    game_over: Felt,                  // 1 (0=no, 1=yes)
}                                     // Total: 9 Felts
```

result-note `run()` implementation:
1. P2ID check: assert `account::get_id()` matches `(self.target_account_prefix, self.target_account_suffix)`
2. Minimal logic — consumption cleans up UTXO. Primary path: shooter reads public note data during sync.

Anti-spoofing for result-notes: Primarily client-side filtering. The client only trusts result-notes whose sender metadata matches the stored opponent. A spoofed result-note from an unknown sender is ignored during sync. No on-chain consume method validates sender (result-note script is minimal).

**Tests to write** (`project-template/integration/tests/battleship_notes_test.rs`):
- `test_shot_note_creates_result_note` — A sends shot-note to B, B consumes it, result-note appears in TX outputs
- `test_result_note_contains_correct_result` — result-note inputs match process_shot return value
- `test_shot_note_p2id_enforcement` — wrong account consumes shot-note → TX fails
- `test_result_note_consumable_by_shooter` — shooter can consume result-note

- **Dependencies**: Tasks 1A, 1B
- **Gate**: Full shot→result cycle works on MockChain. **THIS IS THE KEY RISK GATE** — validates note-creates-note pattern with real contracts. If `output_note::create()` fails from note scripts, stop and redesign.

---

### Task 1D: challenge-note + accept-note Scripts

**Goal**: Implement the game handshake notes.

**Files to create**:

| File | Purpose |
|------|---------|
| `project-template/contracts/challenge-note/Cargo.toml` | Note contract, depends on battleship-account |
| `project-template/contracts/challenge-note/src/lib.rs` | P2ID check → `accept_challenge()` on consuming account |
| `project-template/contracts/accept-note/Cargo.toml` | Note contract, depends on battleship-account |
| `project-template/contracts/accept-note/src/lib.rs` | P2ID check → store acceptor's commitment, set phase=ACTIVE |

challenge-note `run()`:
1. Read inputs: `[target_prefix, target_suffix, challenger_prefix, challenger_suffix, game_id_0..3, grid_size, commitment_h0..h3, ship_set_id]`
2. P2ID: assert `account::get_id()` matches target
3. Sender validation: `accept_challenge()` verifies challenger_id matches note sender
4. Call `battleship_account::accept_challenge(game_id, challenger_prefix, challenger_suffix, commitment)`

accept-note `run()`:
Needs a new component method: `receive_acceptance(game_id, acceptor_prefix, acceptor_suffix, acceptor_commitment)`
1. Read inputs: `[target_prefix, target_suffix, acceptor_prefix, acceptor_suffix, game_id_0..3, commitment_h0..h3]`
2. P2ID: assert `account::get_id()` matches target
3. Sender validation: `receive_acceptance()` verifies acceptor_id matches note sender AND game_id matches
4. Call `battleship_account::receive_acceptance(...)` → stores opponent info, sets `phase=ACTIVE`, `expected_turn=2` (A fires turn 1, so A's first INCOMING shot from B is turn 2)

**Files to modify**:

| File | Change |
|------|--------|
| `project-template/contracts/battleship-account/src/lib.rs` | Add `receive_acceptance()` method |

**Tests to write** (`project-template/integration/tests/battleship_notes_test.rs`):
- `test_challenge_accept_flow` — A sends challenge to B, B consumes it, B sends accept to A, A consumes it, both in ACTIVE phase
- `test_challenge_note_p2id` — wrong account consumes challenge → fails
- `test_accept_note_p2id` — wrong account consumes accept → fails
- `test_game_id_mismatch` — accept-note with wrong game_id → fails

- **Dependencies**: Task 1A (component must have setup_game, accept_challenge, receive_acceptance)
- **Gate**: Full handshake works, both accounts reach ACTIVE with correct state

---

### Task 1E: Board Setup Flow (No TX Script — Component Methods Only)

**Goal**: Validate board placement + compute salted commitment, using component methods called via `TransactionRequestBuilder`.

**Why no tx-script**: `#[tx_script]` only accepts `arg: Word` (4 Felts). Board setup needs 62+ Felts. Instead, the client calls `place_ship()` 17 times, then `finalize_setup()` once. All validation happens inside `finalize_setup()` (within ZK proof).

No new contracts needed. This task extends battleship-account with `finalize_setup()`.

**Files to modify**:

| File | Change |
|------|--------|
| `project-template/contracts/battleship-account/src/lib.rs` | `finalize_setup()` already planned in 1A — flesh out validation logic |

`finalize_setup(game_id, opponent_prefix, opponent_suffix, salt)` validation:
1. Assert `phase == CREATED`
2. Scan `my_board` StorageMap: collect all non-zero cells
3. Validate exactly 17 ship cells placed
4. Validate ship counts: ship_id 1 → 5 cells, 2 → 4, 3 → 3, 4 → 3, 5 → 2
5. Validate contiguity: for each ship_id, cells form a horizontal or vertical line
6. Sort cells canonically (by row, then col)
7. Compute commitment = `hash_elements([game_id, account_id, salt, sorted_cells...])`
8. Store commitment, game_id, opponent, grid_size
9. Set `phase = CHALLENGED`

Client-side flow (`TransactionRequestBuilder`):
```
for each ship cell (row, col, ship_id):
    tx.add_method_call("place_ship", [row, col, ship_id])
tx.add_method_call("finalize_setup", [game_id, opponent_prefix, opponent_suffix, grid_size, salt])
// All in ONE transaction → atomic
```

**Tests to write** (`project-template/integration/tests/battleship_unit_test.rs`):
- `test_valid_board_setup` — place 17 cells + finalize → succeeds, commitment stored
- `test_invalid_ship_sizes` — wrong number of cells for a ship_id → finalize fails
- `test_overlapping_ships` — two ships on same cell → place_ship fails
- `test_out_of_bounds` — row/col >= grid_size → place_ship fails
- `test_non_contiguous_ship` — ship cells not in a line → finalize fails
- `test_commitment_deterministic` — same board + salt → same commitment
- `test_finalize_without_enough_ships` — only 10 cells placed → finalize fails

- **Dependencies**: Task 1A (place_ship method)
- **Gate**: Board validation rejects all invalid placements, commitment is deterministic

Prerequisite: Task 0 (batching spike) validates multi-method-call TX. If it fails, board setup needs a tx-script with advice inputs or multiple transactions.

---

### Task 1F: Reveal Flow (Send + Receive)

**Goal**: Implement the full reveal flow: sending a reveal-note (`mark_my_reveal`) AND consuming one (`verify_opponent_board`).

The reveal-sender flow (missing from earlier drafts):
A player who wants to reveal must:
1. Call `enter_reveal()` on own account (if winner; loser auto-transitions in process_shot)
2. Create a reveal-note addressed to opponent (client builds the note with salt + board data)
3. Call `mark_my_reveal()` on own account → sets `my_revealed = 1`

Steps 2+3 happen in the same TX (the sender's TX that creates the outgoing reveal-note).

**Files to create**:

| File | Purpose |
|------|---------|
| `project-template/contracts/reveal-note/Cargo.toml` | Note contract, depends on battleship-account |
| `project-template/contracts/reveal-note/src/lib.rs` | P2ID + sender validation → `verify_opponent_board()` |

reveal-note `run()`:
1. Read struct fields: `target_prefix, target_suffix, game_id, player_prefix, player_suffix, salt, (row, col, ship_id) × 17` → 63 Felts
2. P2ID: assert `account::get_id()` matches target
3. Sender validation: assert `(player_prefix, player_suffix) == stored opponent_id`
4. Call `battleship_account::verify_opponent_board(game_id, player_id, salt, board_data)`

**Files to modify**:

| File | Change |
|------|--------|
| `project-template/contracts/battleship-account/src/lib.rs` | Implement `verify_opponent_board()`, `mark_my_reveal()` |

`verify_opponent_board()` logic:
1. Assert `phase == REVEAL`
2. Re-hash: `H(game_id || player_id || salt || canonical_board)`
3. Compare to stored `opponent_commitment`
4. Assert match
5. Set `opponent_verified = 1`
6. If `my_revealed == 1` → set `phase = COMPLETE`

`mark_my_reveal()` logic:
1. Assert `phase == REVEAL`
2. Set `my_revealed = 1`
3. If `opponent_verified == 1` → set `phase = COMPLETE`

**Tests to write** (`project-template/integration/tests/battleship_notes_test.rs`):
- `test_valid_reveal` — correct board + salt → verification passes, opponent_verified=1
- `test_tampered_board_reveal` — modified board → verification fails
- `test_wrong_salt_reveal` — wrong salt → verification fails
- `test_reveal_sender_flow` — player calls mark_my_reveal → my_revealed=1
- `test_reveal_completes_game` — both players: mark_my_reveal + consume opponent's reveal → phase=COMPLETE
- `test_reveal_note_p2id` — wrong account consumes → fails
- `test_reveal_note_wrong_sender` — spoofed reveal from non-opponent → rejected

- **Dependencies**: Tasks 1A, 1E (commitment must be stored first)
- **Gate**: Full reveal flow works: send reveal (mark_my_reveal) + receive reveal (verify_opponent_board) → COMPLETE

---

### Task 1G: Victory Detection Integration

**Goal**: Test that the 17th hit triggers game_over and phase transitions.

**Tests to write** (`project-template/integration/tests/battleship_integration_test.rs`):
- `test_17th_hit_triggers_reveal` — fire 17 shots hitting all ship cells → phase=REVEAL, game_over=1 in last result
- `test_game_over_flag_in_result_note` — result-note from 17th hit contains game_over=1
- `test_winner_enters_reveal` — after game_over, winner calls enter_reveal() → phase=REVEAL

- **Dependencies**: Tasks 1B, 1C (process_shot + shot-note + result-note)
- **Gate**: Victory correctly detected and propagated

---

### Task 1H: Full Game Integration Test

**Goal**: End-to-end test of a complete game: setup → handshake → all shots → victory → reveal → COMPLETE.

**Tests to write** (`project-template/integration/tests/battleship_integration_test.rs`):
- `test_full_game_a_wins` — Player A wins: setup both accounts, handshake, A fires shots until B's ships sunk, reveal, COMPLETE
- `test_full_game_b_wins` — Player B wins: same but B sinks A's ships first

This is the most complex test. It orchestrates:
1. Build all 6 contract packages (battleship-account + 5 note scripts)
2. Create 2 game accounts with battleship component + BasicAuth
3. Setup boards via batched `place_ship()` + `finalize_setup()` on each account
4. Exchange challenge/accept notes
5. Alternating shot→result cycles (minimize: hit all B's ships in ~17 shots, skip A's defending turns or have B miss)
6. Detect game_over
7. Both accounts enter reveal phase + send reveal-notes (`mark_my_reveal`)
8. Both consume opponent's reveal-note (`verify_opponent_board`)
9. Both accounts reach COMPLETE

- **Dependencies**: All of 1A-1G
- **Gate**: Complete game lifecycle works on MockChain

---

### Task 1I-1N: Failure & Edge Case Tests

**Goal**: Negative tests for robustness.

**Tests to write** (`project-template/integration/tests/battleship_failure_test.rs`):
- `test_wrong_turn_number_rejected` (1k) — shot with turn != expected → fails
- `test_duplicate_cell_rejected` (1l) — same cell shot twice → fails
- `test_shot_wrong_phase_rejected` (1m) — shot during CREATED/CHALLENGED → fails
- `test_hostile_consumption_challenge` (1n) — third account consumes challenge-note → fails (P2ID)
- `test_hostile_consumption_accept` (1n) — third account consumes accept-note → fails (P2ID)
- `test_hostile_consumption_result` (1n) — third account consumes result-note → fails (P2ID)
- `test_hostile_consumption_reveal` (1n) — third account consumes reveal-note → fails (P2ID)
- `test_spoofed_accept_note` — attacker creates fake accept-note addressed to A → rejected (sender != stored challenger)
- `test_spoofed_result_note` — attacker creates fake result-note addressed to A → rejected (sender != stored opponent)
- `test_spoofed_reveal_note` — attacker creates fake reveal-note addressed to A → rejected (revealer != stored opponent)

- **Dependencies**: Tasks 1A-1F (all contracts built, including reveal-note for spoofing tests)
- **Gate**: All invalid operations correctly rejected

---

## Config Changes

`project-template/integration/Cargo.toml` — No changes needed for test discovery (Cargo auto-discovers `tests/*.rs`). May need to add dev-dependencies if new crates are required.

No migrations needed — Miden uses account storage, not databases.

Each new contract needs:
1. `Cargo.toml` with `crate-type = ["cdylib"]`, `miden = "0.10"`
2. Cross-component references in `Cargo.toml` `[package.metadata.miden.dependencies]` section (e.g., shot-note depends on battleship-account)
3. `src/lib.rs` with `#![no_std]` and appropriate macros

---

## Execution Order Summary

```
0   Spike: multi-method-call TX batching
    │
1A  battleship-account (storage + basic methods + finalize_setup) ◄── 0
    │
    ├── 1B  Shot logic (process_shot, enter_reveal) ◄── 1A
    ├── 1D  challenge-note + accept-note ◄── 1A (parallel with 1B)
    └── 1E  Board setup tests (place_ship + finalize) ◄── 1A (parallel with 1B, 1D)
        │
1C  shot-note + result-note ◄── 1A, 1B
    │   *** KEY RISK GATE: validates note-creates-note pattern ***
    │
1F  reveal-note + verification ◄── 1A, 1E
    │
1G  Victory detection tests ◄── 1B, 1C
    │
1H  Full game integration ◄── ALL above
    │
1I-1N  Failure + spoofing tests ◄── 1A-1F (needs all contracts including reveal-note)
```

Two risk gates:
1. **Task 0**: Can we batch method calls? (If no → redesign board setup)
2. **Task 1C**: Does note-creates-note work? (If no → redesign shot→result flow)

Test file consolidation (fewer files, shared setup):

| File | Contains |
|------|----------|
| `battleship_unit_test.rs` | 1A, 1B, 1E tests (component methods only, no notes) |
| `battleship_notes_test.rs` | 1C, 1D, 1F tests (note scripts, handshake, reveal) |
| `battleship_integration_test.rs` | 1G, 1H tests (victory, full game) |
| `battleship_failure_test.rs` | 1I-1N tests (all negative cases) |

---

## Verification

After each task:
```bash
# Build the contract
cargo miden build --manifest-path project-template/contracts/<name>/Cargo.toml --release

# Run specific test
cd project-template && cargo test -p integration --release --test <test_file> -- <test_name>
```

After Phase 1 complete:
```bash
# Run all integration tests
cd project-template && cargo test -p integration --release

# All tests must pass with 0 failures
```

**Phase 1 exit criteria**:
- All 7 contracts compile to `.masp`
- All MockChain tests pass (positive + negative)
- Full game test completes (setup → shots → victory → reveal → COMPLETE)
- All P2ID enforcement tests pass (hostile consumption rejected)
