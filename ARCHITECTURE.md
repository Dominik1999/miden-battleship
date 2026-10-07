# Architecture

## Context

Two-player Battleship on Miden. Each player has a private board, takes turns firing shots, and gets hit/miss feedback. Miden's private accounts plus ZK-proven execution make the defender's shot resolution trustworthy without the board ever leaving the player's device.

The contracts are Miden Assembly (`project-template/contracts/masm/`): one account component, seven note scripts and two transaction scripts. They are compiled at runtime by `miden-client` 0.17 (`BattleshipScripts::compile` in `integration/src/battleship.rs`) and by the web SDK 0.17 (`ContractCompiler` in `frontend-template/src/lib/contracts.ts`). Note and transaction scripts `call` into the component and are compiled with the component code linked dynamically, so their `call`s resolve to the exact procedures installed on the game account.

## Core Model

- Each match uses two fresh per-match game accounts, one per player, plus each player's wallet.
- A game account is **private** (`AccountType::Private`, private storage mode) and composed of the battleship component, `BasicWallet` (to receive the fee asset) and `NoAuth` (no keys; the account pays its own fees). It is built with the Rust `AccountBuilder::build()` and, in the browser, with `AccountBuilder.buildWithoutSchemaCommitment()` — the web SDK's `build()` merges a storage-schema component the Rust builder does not, and both must agree because the handshake pins the initial storage commitment.
- A fresh account exists on chain only after its first transaction, which is the consumption of its faucet funding note. The chain only ever sees the account's commitment; the full state lives in the owner's client store.
- The board never leaves the account: the setup transaction stores it in private storage, every shot is resolved inside the defender's proven transaction, and the only data published are the notes.
- Grid size is fixed at 10x10. Ships are the classic set: 5, 4, 3, 3, 2 cells, 17 total.
- Ship occupancy is immutable after setup. Gameplay only changes cell markers from ship/water to hit/miss.

## Code Anchoring

There is no commit/reveal phase. Instead, each player proves to the other that it runs the same contract:

- The component source embeds its own initial storage commitment (all value slots zero, maps empty) through `{{ISC0..3}}` placeholders. Rust substitutes `init_storage_commitment()` (`battleship.rs`), the browser computes it from a throwaway account built from the placeholder component (`contracts.ts`).
- The handshake notes carry the sender's account **seed**. The consuming account recomputes `AccountId` from (seed, its own code commitment, the pinned initial storage commitment), mirroring the kernel's `validate_seed`, and asserts that it equals the stored opponent (`assert_seed_derives_opponent`). An opponent running different code cannot derive its id this way.
- At setup each account stores the MAST roots of the four note scripts it will create (shot, result, defeat, forfeit) in the `script_roots` map; the handshake notes carry the sender's roots and the consumer asserts they equal its own (`assert_script_roots`).
- Together these guarantee that every note a genuine opponent creates was produced by the same component code and will be consumed by the same note scripts.

## Transaction Model

- Miden transactions are single-account. Cross-player interaction is note-based; every game note is public and tagged with `NoteTag::with_account_target(recipient)`, so the recipient's client discovers it during sync without registering tags.
- Setup is one transaction script (`scripts/setup_tx.masm`) on the player's own account. The 36-felt payload `[GAME_ID(4), opponent(2), owner_wallet(2), packed_rows(10), SHOT/RESULT/DEFEAT/FORFEIT roots(16), pad(2)]` is supplied through the advice map under a key passed as the script argument; the script calls `set_board_rows`, `set_script_roots` and `finalize_board`.
- **Every move is one transaction.** It consumes the opponent's pending notes (the result note for my last shot, their shot note at me, or the accept note for the challenger's first move) and then runs `scripts/fire_tx.masm`, which calls `fire_shot(row, col, deadline)`. The component itself creates the shot note; when a shot note is consumed, `process_shot` creates the result note (and, on the 17th hit, the defeat note) in the same transaction. The client declares these notes up front (`expected_output_recipients`), which it can because it knows its own board and the deterministic serials.
- Note serials are deterministic: `[my_prefix, my_suffix, turn, kind]` (`own_serial`), so both clients can predict every note.
- Every transaction pays a fee in the chain's fee asset (USDCx on testnet); the `NoAuth` component pays it from the account vault, which is why the game account also carries `BasicWallet` and is funded before its first transaction.

## Notes

All game notes carry no assets and use `NoteType::Public`. Note storage layouts (felts):

| Note | Created by | Direction | Storage | Consumed by |
|------|-----------|-----------|---------|-------------|
| challenge | client (`BasicWallet` send-notes path) | challenger -> acceptor | `[GAME_ID(4), sender_prefix, sender_suffix, SEED(4), wallet_prefix, wallet_suffix, SHOT_ROOT(4), RESULT_ROOT(4), DEFEAT_ROOT(4), FORFEIT_ROOT(4)]` (28) | `assert_script_roots` + `accept_challenge` |
| accept | client | acceptor -> challenger | same 28-item layout | `assert_script_roots` + `receive_acceptance` |
| shot | component (`fire_shot`) | shooter -> defender | `[row, col, turn, deadline]` | defender: `process_shot`; shooter after the deadline: `claim_forfeit` |
| result | component (`process_shot`) | defender -> shooter | `[shooter_prefix, shooter_suffix, turn, is_hit * 2 + game_over, deadline]` | shooter: `process_result`; defender after the deadline: `claim_forfeit` (never for a final result) |
| defeat | component (`process_shot`, 17th hit) | loser's account -> winner's wallet | `[wallet_prefix, wallet_suffix]` | the named wallet only (`note_target`) |
| forfeit | component (`claim_forfeit`) | own account -> own wallet | `[wallet_prefix, wallet_suffix]` | the named wallet only |
| stake | wallet (with the fee asset) | wallet -> conditional P2ID | `[my_wallet(2), my_game(2), opp_wallet(2), opp_game(2), expiry]` (9) | the winner's wallet next to a defeat/forfeit note; the staker after expiry |

Each note script checks the exact storage length, loads the storage into memory and `call`s the component procedure with the arguments in the 16-element stack window. The shot and result scripts branch on whether the consuming account is the note's sender (reclaim) or its opponent (resolve). The shot note takes a note argument: the deadline the defender gives the shooter for the result note. The defeat and forfeit scripts are identical except for a structural `NOTE_KIND` constant, so their MAST roots differ.

## Public Note Security

- `NoteTag` is for discovery only, not access control.
- Every consuming procedure (`accept_challenge`, `receive_acceptance`, `process_shot`, `process_result`) first asserts that the active note's sender equals the opponent stored in the consuming account (`assert_sender_is_opponent`), then checks the phase; the handshake procedures also check the game id, the sender id, the seed derivation and the script roots. A stranger's note is rejected (`shot_rejected_with_wrong_turn_and_from_stranger`).
- Target enforcement follows from this: a game note can only be consumed by the account whose stored opponent is the note's sender, or by its own sender after the deadline.
- `claim_forfeit` asserts that the note was created by this account and carries one of its own stored shot/result roots.
- Defeat, forfeit and stake notes are wallet-level: the defeat/forfeit scripts assert the consuming account is the named wallet, and the stake script scans the transaction's input notes for a defeat/forfeit note from the right game account (roots filled into the script at compile time through `{{DEFEATn}}` / `{{FORFEITn}}` placeholders).

## Gameplay Rules

- The challenger (in the frontend: the joiner) fires first. The challenger fires odd turns (`2 * shots_fired + 1`), the acceptor even turns (`2 * shots_fired + 2`); the defender's expected incoming turn (`game_config[3]`) starts at 1 (acceptor) or 2 (challenger) and advances by 2 per shot resolved.
- `fire_shot(row, col, deadline)` enforces: `phase == ACTIVE`, `results_processed == shots_fired` (the previous result was processed), row/col in bounds, cell not already fired at, `deadline >= reference block timestamp + 43,200 s` (12 h). It records `last_shot = [row, col, turn, 0]`, sets the fired bit in `my_shots[row]` and creates the shot note.
- `process_shot(row, col, turn, result_deadline)` enforces: sender is the opponent, `phase == ACTIVE`, `turn == expected_turn`, row/col in bounds, cell not already shot, deadline rule for `result_deadline`. The cell becomes `CELL_HIT` (6) or `CELL_MISS` (7), `total_shots_received += 1`, `ships_hit_count += is_hit`, `expected_turn += 2`, and the result note is created.
- `process_result(shooter, turn, encoded_result)` enforces: sender is the opponent, `phase == ACTIVE`, shooter is this account, `turn == last_shot.turn`, not yet processed. It increments `results_processed` and sets the hit bit in `my_shots[row]`.

## Victory and Forfeit

- When `ships_hit_count` reaches 17, `process_shot` sets the defender to `COMPLETE` / `LOST`, marks the result `game_over = 1` and emits a defeat note to the opponent's wallet. The shooter processes that final result and goes `COMPLETE` / `WON`.
- Every shot and result note carries a deadline (block timestamp, at least 12 h after the sender's reference block). After the deadline its sender may consume its own note: `claim_forfeit` checks the sender, the root and `block_timestamp > deadline`, sets `COMPLETE` / `WON_BY_FORFEIT` and emits a forfeit note to the owner wallet. A final result note cannot be reclaimed. A late answer that lands before the reclaim is still valid.
- Stakes: before play, each wallet publishes a stake note holding the stake amount in the fee asset and naming both wallets and both game accounts. The winner's wallet consumes **both** stake notes together with the defeat or forfeit note in one transaction; the loser's wallet cannot claim. After the expiry (60 days) the staker can refund its own stake.

## State Machine

On-chain phases: `CREATED (0) -> CHALLENGED (1) -> ACTIVE (2) -> COMPLETE (3)`. Outcomes: `OPEN (0)`, `WON (1)`, `LOST (2)`, `WON_BY_FORFEIT (3)`.

**Challenger** (CLI `--role challenger`, frontend *Join*):
1. setup tx script -> CHALLENGED
2. publish challenge note (carrying seed, wallet, roots)
3. consume accept note + fire turn 1 in one transaction -> ACTIVE, role challenger
4. each move: consume the result of my last shot and the opponent's shot, fire the next odd turn
5. 17th hit received: resolve -> COMPLETE / LOST; or final result processed -> COMPLETE / WON

**Acceptor** (CLI `--role acceptor`, frontend *Start*):
1. setup tx script -> CHALLENGED (the frontend starter runs setup only after the challenge note arrives, because it carries the game id)
2. consume challenge note -> ACTIVE, role acceptor; publish accept note
3. each move: consume the opponent's shot (turn 1 first) and the result of my last shot, fire the next even turn
4. same endings as the challenger

Either side: an unanswered note past its deadline -> reclaim -> COMPLETE / WON_BY_FORFEIT.

## Account Storage

Slot names are `miden_battleship_account::battleship_account::<name>` (see `battleship_account.masm`, `battleship.rs`, `frontend-template/src/config.ts`).

| Slot | Contents |
|------|----------|
| `game_config` | `[grid_size, num_ship_cells, phase, expected_turn]` |
| `opponent` | `[opponent_prefix, opponent_suffix, ships_hit_count, total_shots_received]` |
| `game_id` | shared game identifier word |
| `owner_wallet` | `[wallet_prefix, wallet_suffix, 0, 0]` of this player's wallet |
| `opponent_wallet` | `[wallet_prefix, wallet_suffix, 0, 0]`, stored by the handshake |
| `turn_state` | `[shots_fired, results_processed, role, 0]` (role 1 challenger, 2 acceptor) |
| `last_shot` | `[row, col, turn, 0]` of the last shot this account fired |
| `outcome` | `[outcome, 0, 0, 0]` |
| `my_board` (map) | key `[0, 0, 0, row]` -> `[packed_row, 0, 0, 0]`; 10 cells x 3 bits: `0` water, `1..5` ship id, `6` hit, `7` miss |
| `my_shots` (map) | key `[0, 0, 0, row]` -> `[fired_bits, hit_bits, 0, 0]` of the cells this account fired at |
| `script_roots` (map) | key `[0, 0, 0, kind]` -> script root; kinds 0 shot, 1 result, 2 defeat, 3 forfeit |

## Component Procedures (`battleship::account`)

- `set_board_rows(ROWS_A, ROWS_B, ROWS_C)` — validates the ship set (exactly 5/4/3/3/2 cells of ids 1..5), writes the rows; `CREATED` only
- `set_script_roots(SHOT, RESULT, DEFEAT, FORFEIT)` — pins the roots of the notes this account creates; `CREATED` only
- `finalize_board(GAME_ID, opponent, owner_wallet)` — stores game id, opponent, owner wallet; `CREATED -> CHALLENGED`
- `assert_script_roots(SHOT, RESULT, DEFEAT, FORFEIT)` — called by the handshake note scripts before the handshake procedure
- `accept_challenge(GAME_ID, challenger, SEED, challenger_wallet)` — `CHALLENGED -> ACTIVE`, acceptor, expected turn 1
- `receive_acceptance(GAME_ID, acceptor, SEED, acceptor_wallet)` — `CHALLENGED -> ACTIVE`, challenger, expected turn 2
- `fire_shot(row, col, deadline)` — records the shot, creates the shot note (`scripts/fire_tx.masm`)
- `process_shot(row, col, turn, result_deadline)` — resolves a shot, creates the result note (and the defeat note on the 17th hit)
- `process_result(shooter, turn, encoded_result)` — records the result of the last shot; `COMPLETE / WON` on `game_over`
- `claim_forfeit(deadline, kind)` — reclaims an own unanswered note after its deadline; `COMPLETE / WON_BY_FORFEIT`, forfeit note
- getters `get_cell(row, col)` and `get_game_phase()`

## Anti-Cheat Model

- **Layer 1**: setup validation runs in ZK (`set_board_rows`), so an invalid ship set cannot be stored, and the account commitment pins the board from then on.
- **Layer 2**: shot resolution and result-note creation happen in the same ZK-proven defender transaction, so hits/misses cannot be faked and a shot cannot be answered twice. The shooter's account records the result in its own proven transaction (`process_result`).
- **Layer 3**: the handshake proves that the opponent runs this exact component (seed derivation against the code and initial storage commitments) and the same note scripts (pinned roots), so a modified contract cannot take part.
- **Layer 4**: deadlines and forfeits make walking away a loss, and stakes make it cost something; the defeat/forfeit notes are proofs the winner's wallet uses to claim.

## Persistence and Recovery

Network sync recovers note data and nullifiers, but a private game account's state lives only in the owner's client store (SQLite for the Rust binaries, IndexedDB in the browser). The frontend keeps IndexedDB across page loads and persists the rest of the session (seed, ship cells, shot log, stake tier) in `localStorage` (`src/lib/session.ts`); the lobby offers *Resume* / *Discard* for an interrupted game and *Reset Client Data* to wipe the store. The CLI keeps its SQLite store and keystore per `--player` name.

## Frontend Model

- **Screens**: Lobby (with stake tier and resume), Ship placement, Waiting, Play (with forfeit countdown, stake status and game-over state)
- **Flows** (`src/lib/game.ts`, mirroring `integration/src/helpers.rs`): create and fund a game account and a local wallet; setup; challenge/accept handshake; stake publication; moves (consume pending notes + fire in one transaction); reclaims; claims; fee top-ups
- `useGameplaySync` polls every 3 s inside the provider's `runExclusive` lock and submits at most one transaction per tick: it resolves a shot that sinks my last ship at once, processes a final result at once, otherwise exposes `myTurn`; `fire()` and `claimForfeit()` are the player's actions
- Deadlines come from the wall clock plus margins (`DEADLINE_MARGIN_SECONDS`, `CLAIM_MARGIN_SECONDS`) because the SDK's client wrapper exposes no block header
- The player's wallet on testnet is a local public `NoAuth` wallet funded from the faucet; a browser-extension wallet is a follow-up. Every transaction is submitted directly; there is no popup and no signer provider

## Account Lifecycle

- Accounts are per-match and single-game.
- After completion they are simply abandoned (any remaining fee balance stays in the account); the wallets keep the stakes.

## Resolved Risk Gates

1. One transaction can run `set_board_rows` + `set_script_roots` + `finalize_board` through the setup script (`setup_stores_board_wallet_and_roots`).
2. `output_note::create` works from an account procedure invoked by a note script or a transaction script (`shot_round_trip_updates_both_accounts`, `seventeenth_hit_ends_the_game_with_a_defeat_note`).
3. The seed derivation in MASM matches `AccountId::new` for accounts built by both the Rust and the web SDK builders (`handshake_rejects_wrong_seed`, `init_storage_commitment_matches_a_built_account`, verified on testnet with a Rust CLI vs browser game).
4. Silent transaction submission in the browser is achieved with `NoAuth` game accounts that pay their own fees; no wallet approval is involved.
