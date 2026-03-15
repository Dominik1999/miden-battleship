# Miden Battleship — Architecture & Integration Plan

## Phase 1: Smart Contracts

### Account Component: `battleship-account`

Game state stored in a single Miden account component with 7 storage slots:

| Slot | Type | Contents |
|------|------|----------|
| `game_config` | Value | `[grid_size, num_placed, phase, expected_turn]` |
| `opponent` | Value | `[opponent_prefix, opponent_suffix, ships_hit_count, total_shots_received]` |
| `board_commitment` | Value | `[h0, h1, h2, h3]` — salted hash of ship placement |
| `opponent_commitment` | Value | `[h0, h1, h2, h3]` — opponent's board commitment |
| `game_id` | Value | `[gid0, gid1, gid2, gid3]` — unique game identifier |
| `reveal_status` | Value | `[my_revealed, opponent_verified, 0, 0]` |
| `my_board` | StorageMap | Cell states keyed by `(0,0,row,col)` + ship counts keyed by `(1,0,0,ship_id)` |

**Game phases**: `CREATED(0) → CHALLENGED(1) → ACTIVE(2) → REVEAL(3) → COMPLETE(4)`

**Cell states**: `WATER(0), SHIP_1..5(1-5), HIT(6), MISS(7)`

### Note Scripts

| Note | Direction | Purpose |
|------|-----------|---------|
| `setup-note` | Self-consume | Places 17 ship cells + calls `finalize_setup` |
| `challenge-note` | Challenger → Acceptor | Calls `accept_challenge` on acceptor's account |
| `accept-note` | Acceptor → Challenger | Calls `receive_acceptance` on challenger's account |
| `shot-note` | Attacker → Defender | Calls `process_shot`, creates `result-note` as output |
| `result-note` | Created by shot-note | Carries hit/miss result back to shooter |
| `reveal-note` | Player → Opponent | Calls `verify_opponent_reveal` |
| `action-note` | Test only | Dispatcher for testing individual methods |
| `shot-test-note` | Test only | Minimal shot processor (no output note creation) |

### Game Flow

```
  Player A (Challenger)                    Player B (Acceptor)
  ───────────────────                      ───────────────────
  1. Place ships → finalize_setup()        1. Place ships → finalize_setup()
     phase: CREATED → CHALLENGED              phase: CREATED → CHALLENGED

  2. Send challenge-note ──────────────►   3. accept_challenge()
                                              phase: CHALLENGED → ACTIVE

                                           4. Send accept-note ──────────────►
  5. receive_acceptance()
     phase: CHALLENGED → ACTIVE

  ─── Gameplay Loop (alternating turns) ───

  6. Send shot-note ───────────────────►   7. process_shot() → hit/miss
                                              creates result-note

  8. Read result-note ◄────────────────

  ... alternate until 17 ship cells hit ...

  ─── Reveal Phase ───

  9. enter_reveal() / mark_my_reveal()     9. verify_opponent_reveal()
     Send reveal-note ─────────────────►
                                           10. mark_my_reveal()
  10. verify_opponent_reveal() ◄───────        Send reveal-note

  Both verified → phase: COMPLETE
```

## Phase 2: Contract Integration Tests

MockChain-based tests validating all game logic:

- **Unit tests** — Board placement, shot processing, phase transitions
- **Note lifecycle tests** — setup → challenge → accept → shot → result → reveal
- **Integration tests** — Full 2-player game flow
- **Failure tests** — Wrong phase, out of bounds, duplicate shots, invalid ships

Local node validation via `validate_local.rs` binary.

## Phase 3: Battleship Frontend

### Implementation Steps

- [x] 1. Create `deploy_testnet.rs` — deploy game accounts on testnet
- [x] 2. Copy `shot_note.masp`, remove old counter artifacts
- [x] 3. Types (`src/types/game.ts`) + config (`src/config.ts`)
- [x] 4. Test fixtures (`src/__tests__/fixtures/battleship.ts`)
- [x] 5. `useGameState` hook + test
- [x] 6. `useBoardState` hook + test
- [x] 7. `useSoundEffects` hook (Web Audio API)
- [x] 8. `Cell` + `GameBoard` components + tests
- [x] 9. `GameStatus` component
- [x] 10. `useFireShot` hook + test
- [x] 11. `useAutoSync` hook
- [x] 12. `GamePlay` component + test
- [x] 13. `GameSelect` component + test
- [x] 14. `AppContent` rewrite + `App.tsx` update
- [x] 15. CSS styling (index.css + component CSS)
- [x] 16. Verification (typecheck + tests + browser)

### Results

- TypeScript: compiles clean (`npx tsc -b --noEmit`)
- Tests: 38 passed, 10 test files (`npx vitest --run`)
- Old counter code removed, shot_note.masp copied

### Pending (requires testnet deployment)

- Run `deploy_testnet.rs` to get real game account addresses
- Update `config.ts` with deployed addresses and result_script_root
- Browser verification with Playwright MCP

## Lessons Learned

### Miden SDK: Note scripts with branching and return values

**Problem**: When a `#[note_script]` has if/else branches where one branch calls a component method returning a `Felt` and other branches call void methods, the Miden WASM-to-MASM compiler generates invalid code. The transaction fails with `assertion failed at clock cycle N with error code: 0`.

**Root cause**: Mismatched stack effects across if/else branches in compiled MASM.

**Fix**: Use separate dedicated note scripts for methods that return values (e.g., `process_shot` → `shot-test-note`). Do NOT mix returning and void method calls in the same if/else dispatcher note.

### Miden SDK: CLI cargo-miden v0.4.0 broken with nightly-2025-12-10

The CLI `cargo miden build` panics with `panic_immediate_abort is now a real panic strategy!`. Use the cargo-miden library v0.7 (`build_project_in_dir()`) instead. The build hook fires on every contract edit and fails — this is ignorable.

### MockChain: Notes must be added before build()

`MockChainBuilder.add_output_note()` must be called BEFORE `builder.build()`. There is no `mock_chain.add_output_note()` method on the built MockChain.

### Miden SDK: Felt::new() vs Felt::from_u64_unchecked()

In contract code (`#![no_std]`), `Felt::new(x)` returns `Result<Felt, FeltError>` — use `Felt::from_u64_unchecked(x)` for runtime values and `felt!(N)` for compile-time constants. In test code (std), `Felt::new(x)` returns `Felt` directly.

### MockChain: output_note::create requires extend_expected_output_notes

When a note script calls `output_note::create()` to create an output note, the transaction kernel needs the full NoteScript details in the advice provider. Pre-construct the expected output note and pass it via `build_tx_context(...).extend_expected_output_notes(vec![OutputNote::Full(expected_note)])`. The sender in NoteMetadata is the executing account (defender), not the original note sender.

### MockChain: Unique seeds for multi-account tests

`create_testing_account_from_package` uses hardcoded seed `[3u8; 32]`. Two accounts with the same component and storage get the same AccountId. Use `AccountBuilder::new(unique_seed)` directly.

### MockChain: create_testing_note_from_package uses zero serial numbers

`create_testing_note_from_package()` uses `[0u64; 4]` as the serial number. Two notes with the same script and inputs will collide. Differentiate notes by adding unique inputs or using different scripts.

### Real Node: expected_output_recipients replaces extend_expected_output_notes

On MockChain, use `extend_expected_output_notes(vec![OutputNote::Full(note)])`. On a real node with `TransactionRequestBuilder`, use `expected_output_recipients(vec![NoteRecipient])` instead.

### Real Node: Binary working directory vs test working directory

Tests run from `integration/` so contract paths use `../contracts/<name>`. Binaries run from workspace root (`project-template/`) so they need `contracts/<name>`.

### Real Node: Accounts need AuthFalcon512Rpo (not NoAuth)

MockChain tests use `NoAuth` for game accounts. On a real node, accounts need `AuthFalcon512Rpo` auth.

### MockChain: All Value storage slots must be initialized

When creating test accounts, ALL Value storage slots declared in the component must be listed in `storage_slots`, even if they're just defaults. Missing slots cause `StorageSlotNameNotFound` errors.
