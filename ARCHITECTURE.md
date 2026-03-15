# Final Architecture Plan

## Context

Two-player Battleship on Miden. Each player has a private board, takes turns firing shots, and gets hit/miss feedback. Miden's private account storage plus ZK-proven execution makes the defender's shot resolution trustworthy without revealing the board during play.

## Core Model

- Each match uses two fresh per-match game accounts.
- Each game account includes the battleship-account component plus an auth component.
- The board is stored in private StorageMap state; only commitments and note metadata are public.
- Grid size is fixed at 10x10 for v1.
- Ships are the classic set: 5, 4, 3, 3, 2 cells, 17 total.
- Ship occupancy is immutable after setup. Gameplay only changes cell markers from ship/water to hit/miss.

## Board Commitment

- Commitment format: `H(game_id || player_id || salt || canonical_board)`.
- `salt` is 4 felts, generated client-side and kept local until reveal.
- `canonical_board` is the list of 17 ship cells sorted by (row, col) and encoded as `(row, col, ship_id)`.

## Transaction Model

- Miden transactions are single-account. Cross-player interaction is note-based.
- Setup uses one batched transaction on the player's own account:
  - `place_ship(...)` repeated for all ship cells
  - `finalize_setup(...)` once at the end
- Active play uses 2 transactions per shot cycle:
  - Shooter creates a private shot-note via Note Transport.
  - Defender consumes the shot-note, runs `process_shot(...)`, and creates a public result-note.
- Game end adds extra transactions:
  - winner calls `enter_reveal()`
  - each player sends a reveal-note
  - each player consumes the opponent's reveal-note
- Clients must serialize transactions per account with a queue/lock to avoid nonce races.

## Notes

### challenge-note
- Public
- Sent by challenger to acceptor
- Carries target account, challenger account, game_id, grid params, challenger commitment
- Enforces target account with P2ID-style check
- Validates sender metadata against challenger identity

### accept-note
- Public
- Sent by acceptor to challenger
- Carries target account, acceptor account, game_id, acceptor commitment
- Enforces target account with P2ID-style check
- Validates sender metadata against acceptor identity

### shot-note
- Private
- Delivered via Note Transport
- Carries game_id, target account, row, col, turn_number, result-note recipient data, shooter identity/tag
- Enforces target account with P2ID-style check

### result-note
- Public
- Created inside the defender's shot-note consumption transaction
- Carries game_id, target shooter account, turn_number, result, game_over
- Does not carry row or col
- Enforces target account with P2ID-style check
- Trusted by the shooter only if sender metadata matches the stored opponent

### reveal-note
- Public
- Carries target account, game_id, revealer identity, salt, and the full 17 ship cells
- Enforces target account with P2ID-style check
- Validates sender metadata against the stored opponent

## Public Note Security

- `NoteTag` is for discovery/filtering only, not access control.
- Every public note uses:
  - target-account enforcement to stop hostile consumption
  - sender validation to stop spoofed notes
- For result-note, spoof protection is primarily client-side because the note script is intentionally minimal.

## Gameplay Rules

- Turn ownership is encoded by `expected_turn` in account storage.
- Challenger A fires first.
- Acceptor B starts with expected incoming turn 1.
- Challenger A starts with expected incoming turn 2.
- `process_shot(...)` enforces:
  - `phase == ACTIVE`
  - `turn == expected_turn`
  - targeted cell has not already been shot
- After a valid shot:
  - result is miss or hit
  - board cell is updated to `CELL_MISS` or `CELL_HIT`
  - `total_shots_received` increments
  - `ships_hit_count` increments on new hits
  - `expected_turn += 2`

## Victory and Reveal

- When `ships_hit_count == 17`, the losing account automatically moves to REVEAL.
- The result-note includes `game_over = 1`.
- The winner detects game_over and calls `enter_reveal()` on their own account.
- Reveal is optional for correctness.
- The actual game result is final at game_over.
- REVEAL -> COMPLETE is a post-game transparency ceremony only.
- If a player never reveals, the game result still stands; the account may remain in REVEAL.

## State Machine

On-chain phases: `CREATED -> CHALLENGED -> ACTIVE -> REVEAL -> COMPLETE`

`ABANDONED` is UI-only and never written on-chain.

**Challenger flow**:
1. setup complete → CHALLENGED
2. consume accept-note → ACTIVE
3. defend incoming shots during ACTIVE
4. call `enter_reveal()` after opponent is defeated
5. consume opponent reveal → COMPLETE if already revealed

**Acceptor flow**:
1. setup + consume challenge-note → ACTIVE
2. defend incoming shots during ACTIVE
3. auto-enter REVEAL on loss, or call `enter_reveal()` on win
4. consume opponent reveal → COMPLETE if already revealed

## Account Storage

| Slot | Contents |
|------|----------|
| `game_config` | `[grid_size, num_ships, phase, expected_turn]` |
| `opponent` | `[opponent_prefix, opponent_suffix, ships_hit_count, total_shots_received]` |
| `board_commitment` | Salted hash of ship placement |
| `opponent_commitment` | Opponent's board commitment |
| `game_id` | Unique game identifier |
| `reveal_status` | `[my_revealed, opponent_verified, 0, 0]` |
| `my_board[(row,col)]` | `0` water, `1..5` ship_id, `6` hit, `7` miss |

## Core Component Methods

- `place_ship(row, col, ship_id)`
- `finalize_setup(game_id, opponent_prefix, opponent_suffix, salt)`
- `accept_challenge(game_id, opponent_prefix, opponent_suffix, opponent_commitment)`
- `receive_acceptance(game_id, opponent_prefix, opponent_suffix, opponent_commitment)`
- `process_shot(row, col, turn) -> encoded_result`
- `enter_reveal()`
- `mark_my_reveal()`
- `verify_opponent_board(game_id, player_id, salt, board_data)`
- getters such as `get_cell()` and `get_game_phase()`

## Anti-Cheat Model

- **Layer 1**: setup validation runs in ZK, so invalid ship placement cannot be committed.
- **Layer 2**: shot resolution and result-note creation happen in the same ZK-proven defender transaction, so hits/misses cannot be faked.
- **Layer 3**: reveal proves the committed board matches the actual ship layout, but this is for transparency, not correctness.
- Refusal to reveal is a social/UX issue only, not a correctness failure.

## Persistence and Recovery

Network sync can recover:
- account existence
- nonce
- public note data
- note consumption/nullifier state

Network sync **cannot** recover:
- private board state
- salt
- local turn-to-coordinate mapping
- pending private shot-notes

CLI and web clients must persist full local game state. Export/backup is required for device-loss recovery.

## Frontend Model

- **Pages**: Lobby, Setup, Play, Game Over
- **Main flows**:
  - create/join game
  - place ships
  - send private shot-note
  - consume incoming shot-note
  - discover public result-note and update local UI
  - reveal board after game end
- Auto-processing is supported where the signer allows silent/background transactions.
- If the wallet requires approval per transaction, web falls back to manual "Process shot".

## Account Lifecycle

- Accounts are per-match and single-game.
- After completion, they are simply abandoned.
- No multi-game storage layout is needed for v1.

## Key Technical Risk Gates

1. Validate that a single transaction can batch repeated method calls (`place_ship` x17 + `finalize_setup`).
2. Validate that `output_note::create()` works from inside a note script for the shot → result flow.
3. Validate whether the web wallet supports silent/background transaction submission for auto-processing.
