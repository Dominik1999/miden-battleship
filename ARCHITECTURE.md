# Architecture

## Context

Two-player Battleship on Miden. Each player has a private board, takes turns firing shots, and gets hit/miss feedback. Miden's private account storage plus ZK-proven execution makes the defender's shot resolution trustworthy without revealing the board during play.

The contracts are Miden Assembly (`project-template/contracts/masm/`): one account component, five note scripts and three transaction scripts. They are compiled at runtime by `miden-client` 0.17 (`BattleshipScripts::compile` in `integration/src/battleship.rs`) and by the web SDK 0.17 (`ContractCompiler` in `frontend-template/src/lib/contracts.ts`). Note and transaction scripts `call` into the component and are compiled with the component code linked dynamically, so their `call`s resolve to the exact procedures installed on the game account.

## Core Model

- Each match uses two fresh per-match game accounts.
- A game account is public and composed of the battleship component, `BasicWallet` (to receive the fee asset) and `NoAuth` (no keys; the account pays its own fees).
- A fresh account exists on chain only after its first transaction, which is the consumption of its faucet funding note.
- The board is stored in a private `StorageMap`; only commitments and note data are public.
- Grid size is fixed at 10x10. Ships are the classic set: 5, 4, 3, 3, 2 cells, 17 total.
- Ship occupancy is immutable after setup. Gameplay only changes cell markers from ship/water to hit/miss.

## Board Commitment

- The commitment is an opaque word (4 felts) chosen by the player's client before setup: random in the CLI and the frontend, constants in the tests.
- It is stored in the player's own account at setup and in the opponent's account during the handshake.
- The reveal note carries that word; `verify_opponent_reveal` checks it against the stored opponent commitment.
- Hashing the board into the commitment (`H(game_id || player || salt || board)`) is not implemented in this version: the web SDK exposes no Poseidon2 hash, and the result note is already ZK-proven, so the reveal is a transparency step, not a correctness requirement (see *Anti-Cheat Model*).

## Transaction Model

- Miden transactions are single-account. Cross-player interaction is note-based; every game note is public and tagged with `NoteTag::with_account_target(recipient)`, so the recipient's client discovers it during sync without registering tags.
- Setup is one transaction script (`scripts/setup_tx.masm`) on the player's own account. The 20-felt payload `[GAME_ID(4), opponent_prefix, opponent_suffix, COMMITMENT(4), packed_rows(10)]` is supplied through the advice map under a key passed as the script argument; the script calls `set_board_rows` then `finalize_board`.
- A shot cycle is 2 transactions:
  - the shooter publishes a shot note from its game account (`BasicWallet` send-notes path, `own_output_notes`);
  - the defender consumes the shot note; `process_shot` updates the board and creates the public result note in the same transaction. The defender declares the result note's recipient up front (`expected_output_recipients`), which it can compute because it knows its own board.
- The shooter reads the result note during sync. Consuming it would only cost a fee (the script is a no-op), so the frontend never does; the CLI and validation binary match it by serial number and script root.
- Game end adds: `enter_reveal` (winner, tx script), one reveal note per player, `mark_my_reveal` (tx script) per player, and one consume of the opponent's reveal note per player.
- Every transaction pays a fee in the chain's fee asset (USDCx on testnet); the `NoAuth` component pays it from the account vault, which is why the game account also carries `BasicWallet` and is funded before its first transaction.

## Notes

All notes carry no assets and use `NoteType::Public`. Note storage layouts (felts):

| Note | Direction | Storage | Account procedure called |
|------|-----------|---------|--------------------------|
| challenge | challenger -> acceptor | `[GAME_ID(4), challenger_prefix, challenger_suffix, COMMITMENT(4)]` | `accept_challenge` |
| accept | acceptor -> challenger | `[GAME_ID(4), acceptor_prefix, acceptor_suffix, COMMITMENT(4)]` | `receive_acceptance` |
| shot | shooter -> defender | `[row, col, turn, RESULT_SERIAL_NUM(4), RESULT_SCRIPT_ROOT(4)]` | `process_shot` |
| result | created by the defender's account for the shooter | `[shooter_prefix, shooter_suffix, turn, is_hit * 2 + game_over]` | none (data carrier) |
| reveal | player -> opponent | `[COMMITMENT(4)]` | `verify_opponent_reveal` |

Each note script checks the exact storage length, loads the storage into memory and `call`s the component procedure with the arguments in the 16-element stack window.

## Public Note Security

- `NoteTag` is for discovery only, not access control.
- Every consuming procedure (`accept_challenge`, `receive_acceptance`, `process_shot`, `verify_opponent_reveal`) first asserts that the active note's sender equals the opponent stored in the consuming account (`assert_sender_is_opponent`), then checks the phase; the handshake procedures also check the game id and the sender id carried in the note against storage. A stranger's note is rejected (`shot_rejected_from_stranger`).
- Target enforcement follows from this: a note can only be consumed by the account whose stored opponent is the note's sender.
- For the result note, spoof protection is client-side: the shooter expects a note with the serial number it chose and the result script root, sent by its opponent.

## Gameplay Rules

- Turn ownership is encoded by `expected_turn` in `game_config`.
- The challenger (in the frontend: the joiner) fires first, on turn 1.
- After the handshake the acceptor expects incoming turn 1, the challenger incoming turn 2.
- `process_shot(row, col, turn, result_serial, result_root)` enforces: sender is the opponent, `phase == ACTIVE`, `turn == expected_turn`, row/col in bounds, cell not already shot.
- After a valid shot: the cell becomes `CELL_HIT` (6) or `CELL_MISS` (7), `total_shots_received += 1`, `ships_hit_count += is_hit`, `expected_turn += 2`, and the encoded result is returned.

## Victory and Reveal

- When `ships_hit_count` reaches 17, the defending account moves itself to `REVEAL` and the result note carries `game_over = 1`.
- The winner sees `game_over` and runs `enter_reveal` on its own account (`ACTIVE -> REVEAL`).
- Both players publish a reveal note and run `mark_my_reveal` (`reveal_status[0] = 1`); each consumes the opponent's reveal note (`reveal_status[1] = 1`). The account becomes `COMPLETE` when both flags are set, in either order.
- The game result is final at `game_over`; `REVEAL -> COMPLETE` is a post-game ceremony. An account whose opponent never reveals stays in `REVEAL`.

## State Machine

On-chain phases: `CREATED (0) -> CHALLENGED (1) -> ACTIVE (2) -> REVEAL (3) -> COMPLETE (4)`.

**Challenger** (CLI `--role challenger`, frontend *Join*):
1. setup tx script -> CHALLENGED
2. publish challenge note; consume accept note -> ACTIVE, expected turn 2
3. fire odd turns, defend even turns
4. on `game_over` in a result note: `enter_reveal`
5. reveal note + `mark_my_reveal`; consume opponent reveal -> COMPLETE

**Acceptor** (CLI `--role acceptor`, frontend *Start*):
1. setup tx script -> CHALLENGED (the frontend starter runs setup only after the challenge note arrives, because it carries the game id)
2. consume challenge note -> ACTIVE, expected turn 1; publish accept note
3. defend odd turns, fire even turns
4. 17th hit received -> REVEAL automatically (or `enter_reveal` when winning)
5. reveal note + `mark_my_reveal`; consume opponent reveal -> COMPLETE

## Account Storage

Slot names are `miden_battleship_account::battleship_account::<name>` (see `battleship_account.masm`, `battleship.rs`, `frontend-template/src/config.ts`).

| Slot | Contents |
|------|----------|
| `game_config` | `[grid_size, num_ship_cells, phase, expected_turn]` |
| `opponent` | `[opponent_prefix, opponent_suffix, ships_hit_count, total_shots_received]` |
| `board_commitment` | this player's commitment word |
| `opponent_commitment` | the opponent's commitment word |
| `game_id` | shared game identifier word |
| `reveal_status` | `[my_revealed, opponent_verified, 0, 0]` |
| `my_board` (map) | key `[0, 0, 0, row]` -> `[packed_row, 0, 0, 0]`; 10 cells x 3 bits: `0` water, `1..5` ship id, `6` hit, `7` miss |

## Component Procedures (`battleship::account`)

- `set_board_rows(ROWS_A, ROWS_B, ROWS_C)` — validates the ship set (exactly 5/4/3/3/2 cells of ids 1..5), writes the rows; `CREATED` only
- `finalize_board(GAME_ID, opponent_suffix, opponent_prefix, COMMITMENT)` — stores game id, opponent, commitment; `CREATED -> CHALLENGED`
- `accept_challenge(GAME_ID, challenger_suffix, challenger_prefix, COMMITMENT)` — `CHALLENGED -> ACTIVE`, expected turn 1
- `receive_acceptance(GAME_ID, acceptor_suffix, acceptor_prefix, COMMITMENT)` — `CHALLENGED -> ACTIVE`, expected turn 2
- `process_shot(row, col, turn, RESULT_SERIAL_NUM, RESULT_SCRIPT_ROOT) -> encoded_result` — resolves a shot, creates the result note
- `enter_reveal()` — `ACTIVE -> REVEAL`
- `mark_my_reveal()` — sets `my_revealed`; completes if the opponent is verified
- `verify_opponent_reveal(COMMITMENT)` — sets `opponent_verified`; completes if already revealed
- getters `get_cell(row, col)` and `get_game_phase()`

## Anti-Cheat Model

- **Layer 1**: setup validation runs in ZK (`set_board_rows`), so an invalid ship set cannot be committed.
- **Layer 2**: shot resolution and result-note creation happen in the same ZK-proven defender transaction, so hits/misses cannot be faked and a shot cannot be answered twice.
- **Layer 3**: the reveal exchange proves that each player still holds the commitment the opponent recorded. It does not bind the commitment to the board contents in this version.
- Refusal to reveal is a UX issue only, not a correctness failure.

## Persistence and Recovery

Network sync recovers account state (public accounts), note data and nullifiers. It cannot recover what was never on chain: the commitment word, the local shot log (the frontend's enemy board is built from its own shot results), and the ship placement before setup. The frontend clears its IndexedDB state on every page load (`main.tsx` / `boot.tsx`), so a game is lost on reload; the CLI keeps its SQLite store and keystore per `--player` name.

## Frontend Model

- **Screens**: Lobby, Ship placement, Waiting, Play (with game-over state)
- **Flows** (`src/lib/game.ts`, mirroring `validate_testnet.rs`): create and fund a game account; setup; challenge/accept handshake; publish shot notes; consume incoming shot notes; read result notes; top up fees; reveal ceremony
- `useGameplaySync` polls every 3 s and handles at most one incoming note per tick, inside the provider's `runExclusive` lock
- Every transaction is submitted directly from the game account; there is no wallet, no popup and no signer provider

## Account Lifecycle

- Accounts are per-match and single-game.
- After completion they are simply abandoned (any remaining fee balance stays in the account).

## Resolved Risk Gates

1. One transaction can run `set_board_rows` + `finalize_board` through the setup script (`setup_stores_board_and_enters_challenged`).
2. `output_note::create` works from an account procedure invoked by a note script (`shot_miss_creates_result_note_for_shooter`, `shot_result_matches_expected_recipient`).
3. Silent transaction submission in the browser is achieved with `NoAuth` game accounts that pay their own fees; no wallet approval is involved.
