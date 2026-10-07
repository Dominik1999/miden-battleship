# Private Boards, Forfeits and Stakes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Private game accounts with a one-transaction-per-move protocol, 12-hour forfeits, USDCx stake notes claimable by the winner's wallet, and a frontend that survives reloads.

**Architecture:** The MASM component owns every game note (fire_shot, process_shot, process_result, claim_forfeit create shot/result/defeat/forfeit notes), so every emitted note is consumable by a genuine opponent and a stalled one is reclaimable after its deadline. Opponents are code-anchored by recomputing the account ID from the seed carried in the handshake. Stake notes are conditional P2IDs consumed by a wallet together with a defeat or forfeit note. The Rust crate stays the oracle (MockChain tests with block timestamps, testnet validator); the frontend mirrors it.

**Tech Stack:** MASM (miden-protocol 0.17.1 kernel API), miden-client 0.17.2, miden-testing 0.17.1, @miden-sdk/miden-sdk 0.17.1, @miden-sdk/react 0.17.0, @miden-sdk/miden-wallet-adapter-{base,react} 0.17.0, React 19, Vite 6, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-10-07-private-boards-and-stakes-design.md` (read it first; this plan refines four details, recorded in section "Spec refinements" below).

## Global Constraints

- Rust 1.98.1; `cargo test -p integration --release`, `cargo clippy --all-targets` and nightly `cargo fmt` must be clean before every commit.
- Frontend: `yarn test`, `yarn lint`, `yarn build` clean before every commit; no frontend edits while a browser game is running.
- Game accounts: `AccountType::Private`, `NoAuth` + `BasicWallet` + battleship component; delegated prover by default; local proving opt-in.
- Deadlines: 43 200 s after the reference block timestamp; stake expiry 60 days; tiers 1, 5, 10 USDCx = 1_000_000, 5_000_000, 10_000_000 base units.
- One game account per match; no amend commits; commit per task.

## Spec refinements (decided while planning)

1. **Script roots live in account storage, pinned by the handshake.** The component must create shot/result/defeat/forfeit notes but cannot embed their script roots (the scripts `call` the component, so the roots depend on the component: a cycle). Setup stores the four roots in a `script_roots` map; the challenge and accept notes carry the sender's roots and `accept_challenge` / `receive_acceptance` assert they equal the receiver's own. An honest account therefore never plays an opponent with different roots.
2. **Deadlines are chosen by the creating client and validated on-chain** (`deadline >= block_timestamp + 43200`), so every note's content is known to its creator and `expected_output_recipients` works without predicting block times. Serial numbers are deterministic: `[creator_prefix, creator_suffix, turn, kind]`.
3. **Outcome has its own slot** `outcome = [outcome, 0, 0, 0]` (0 open, 1 won, 2 lost, 3 won by forfeit, 4 lost by forfeit) instead of reusing `game_config[1]`.
4. **Code anchoring compares against the verifier's own code commitment** (`active_account::get_code_commitment`) plus an embedded `INIT_STORAGE_COMMITMENT` constant, so no code commitment has to be embedded in the code.

## Review Focus

1. A shot note reclaimed exactly at `deadline` (equal, not greater): must be rejected; test `forfeit_rejected_at_deadline` in Task 4.
2. A defender resolving a shot after its deadline but before the shooter reclaims: must succeed (first transaction wins); test `late_resolution_still_valid` in Task 4.
3. Two stake notes plus a defeat note where the defeat note was sent by a third account: must be rejected; test `stake_rejects_defeat_from_stranger` in Task 5.
4. The loser consuming the defeat note to burn it: must be rejected (wrong wallet); test `defeat_note_only_consumable_by_winner_wallet` in Task 4.
5. A challenge note whose seed does not derive the sender's ID: must be rejected; test `handshake_rejects_wrong_seed` in Task 2.

---

### Task 1: Storage layout, setup and handshake with seed, wallet and roots (MASM + Rust bindings)

**Files:**
- Modify: `project-template/contracts/masm/battleship_account.masm`
- Modify: `project-template/contracts/masm/scripts/setup_tx.masm`
- Modify: `project-template/contracts/masm/challenge_note.masm`, `accept_note.masm`
- Modify: `project-template/integration/src/battleship.rs`
- Modify: `project-template/integration/tests/common/mod.rs`, `tests/battleship_test.rs`, `tests/battleship_failure_test.rs`

**Interfaces (produced):**
- Slots (names under `miden_battleship_account::battleship_account::`): `game_config`, `opponent`, `game_id`, `owner_wallet`, `opponent_wallet`, `turn_state = [shots_fired, results_processed, role, 0]`, `last_shot = [row, col, turn, 0]`, `outcome`, maps `my_board`, `my_shots` (`[fired_bits, hit_bits, 0, 0]`), `script_roots` (key `[0,0,0,k]`, k: 0 shot, 1 result, 2 defeat, 3 forfeit).
- Setup payload (advice map, 34 felts padded to 36): `GAME_ID(4) opponent(2) owner_wallet(2) rows(10) SHOT_ROOT(4) RESULT_ROOT(4) DEFEAT_ROOT(4) FORFEIT_ROOT(4) pad(2)`.
- Handshake storage (28 felts): `GAME_ID(4) sender(2) SEED(4) wallet(2) SHOT_ROOT(4) RESULT_ROOT(4) DEFEAT_ROOT(4) FORFEIT_ROOT(4)`.
- `finalize_board(game_id, opponent, owner_wallet, ROOTS...)`, `accept_challenge(...)`, `receive_acceptance(...)` with the seed check: `hash_elements([SEED, my_code_commitment, INIT_STORAGE_COMMITMENT, 0,0,0,0]) -> (suffix=d0 shaped, prefix=d1) == opponent id`, mirrored from the kernel's `validate_seed`.
- Rust: `BattleshipScripts::compile()` substitutes `{{INIT_STORAGE_COMMITMENT}}` (computed from `all_storage_slots()`); `build_setup_payload(game_id, opponent, owner_wallet, rows, &roots)`; `handshake_storage(game_id, sender, seed: Word, wallet, &roots)`; `ScriptRoots { shot, result, defeat, forfeit }` from `BattleshipScripts::roots()`; `game_account_builder(seed, component)` now `AccountType::Private`; `GameState` gains `outcome`, `shots_fired`, `results_processed`, `role`.

- [ ] Tests first in `battleship_test.rs`: `setup_stores_wallet_and_roots`, `handshake_pins_roots_and_wallets` (both accounts ACTIVE, `opponent_wallet` set, roles 1/2). In `battleship_failure_test.rs`: `handshake_rejects_wrong_seed` (seed of a third account: "handshake seed does not derive the opponent id"), `handshake_rejects_foreign_roots` ("handshake script roots do not match").
- [ ] Implement the MASM (constants, slots, payload, procedures, seed hashing with `miden::core::crypto::hashes::poseidon2::hash_elements`), then the Rust bindings and harness (`Game::setup` takes the seed from `AccountBuilder`; `Game` keeps `seed_a/seed_b`).
- [ ] `cargo test -p integration --release`, clippy, fmt, commit `feat(contract): private-account setup and seed-anchored handshake`.

### Task 2: Component-created shots and results (`fire_shot`, `process_shot`, `process_result`)

**Files:** `battleship_account.masm`, new `contracts/masm/scripts/fire_tx.masm` (args word `[row, col, deadline, 0]`), `shot_note.masm`, `result_note.masm`, `battleship.rs` (note parsers/builders), tests.

**Interfaces:**
- `fire_shot(row, col, deadline)`: ACTIVE; `results_processed == shots_fired`; challenger fires iff `shots_fired == total_shots_received`, acceptor iff `shots_fired == total_shots_received - 1`; cell in bounds and not in `my_shots`; `deadline >= tx::get_block_timestamp() + 43200`; turn = challenger `2f+1` / acceptor `2f+2`; writes `last_shot`, `my_shots`, `turn_state`; creates the shot note: storage `[row, col, turn, deadline]`, serial `[my_prefix, my_suffix, turn, 1]`, script root `script_roots[0]`, tag → opponent, public.
- `process_shot(row, col, turn, deadline_out)` (deadline_out is the note arg chosen by the defender for the result note): existing checks plus `deadline_out >= ts + 43200`; result note storage `[shooter_prefix, shooter_suffix, turn, encoded, deadline_out]`, serial `[my_prefix, my_suffix, turn, 2]`; on the 17th hit: outcome 2, COMPLETE, defeat note (Task 4).
- `process_result(shooter_prefix, shooter_suffix, turn, encoded)`: sender == opponent; ACTIVE; `turn == last_shot.turn`; `results_processed == shots_fired - 1`; records hit bit; on `game_over`: outcome 1, COMPLETE.
- Rust: `shot_storage(row, col, turn, deadline)`, `result_storage(shooter, turn, result, deadline)`, `expected_shot_note(scripts, shooter, defender, row, col, turn, deadline)`, `expected_result_note(scripts, defender, shooter, turn, result, deadline)`; harness `Game::fire(shooter, row, col)` = tx script `fire_tx` with expected output note; `Game::resolve(defender, shot, deadline)` = consume with note args + expected outputs; `Game::answer(shooter, result, row, col)` = consume result + fire in one tx.

- [ ] Tests: `challenger_fires_first_turn_with_acceptance` (accept + fire in one tx), `shot_round_trip` (fire → resolve → answer; counters, `my_shots` bits, result deadline), `fire_rejected_out_of_turn`, `fire_rejected_on_repeated_cell`, `fire_rejected_before_result_processed`, `fire_rejected_with_short_deadline` ("deadline must be at least 12 hours ahead"), `result_rejected_wrong_turn`, `seventeenth_hit_sets_outcome_lost_and_won`.
- [ ] Implement, test, lint, commit `feat(contract): component-created shots and results with deadlines`.

### Task 3: Remove the reveal protocol

- [ ] Delete `enter_reveal`, `mark_my_reveal`, `verify_opponent_reveal`, `reveal_note.masm`, `enter_reveal_tx.masm`, `mark_my_reveal_tx.masm`, the `board_commitment`/`opponent_commitment`/`reveal_status` slots and the PHASE_REVEAL constant; update `battleship.rs`, tests, `cycle_benchmark_test.rs`.
- [ ] Commit `refactor(contract): drop the reveal phase (private accounts make it redundant)`.

### Task 4: Forfeits, defeat and forfeit notes

**Files:** `battleship_account.masm` (`claim_forfeit`), `shot_note.masm` and `result_note.masm` (reclaim branch), new `defeat_note.masm`, `forfeit_note.masm`, tests.

**Interfaces:**
- Shot note script: `if active_note::get_sender == active_account::get_id → call claim_forfeit(deadline, KIND_SHOT) else call process_shot(...)`. Result note script: same with `KIND_RESULT`, but if `encoded & 1 == 1` (game over) the reclaim branch is an assertion failure "a final result note cannot be reclaimed".
- `claim_forfeit(deadline, kind)`: ACTIVE; `active_note::get_script_root == script_roots[kind]`; `tx::get_block_timestamp() > deadline`; outcome 3; COMPLETE; forfeit note storage `[owner_wallet_prefix, owner_wallet_suffix]`, serial `[my_prefix, my_suffix, 0, 4]`, root `script_roots[3]`, tag → owner wallet.
- Defeat note (created in `process_shot` on the 17th hit): storage `[opponent_wallet_prefix, opponent_wallet_suffix]`, serial `[my_prefix, my_suffix, 0, 3]`, root `script_roots[2]`, tag → opponent wallet. Both defeat and forfeit scripts: `note_target::assert_active_account_is_target_account` and nothing else.
- Harness: `Game` gets wallet accounts `wallet_a`, `wallet_b` (public BasicWallet, `Auth::IncrNonce`) whose ids are the owner wallets; `Game::advance_time(secs)` = `prove_next_block_at(last_timestamp + secs)`; `Game::reclaim(id, note, kind)`.

- [ ] Tests: `forfeit_after_deadline_emits_forfeit_note`, `forfeit_rejected_before_deadline`, `forfeit_rejected_at_deadline`, `forfeit_rejected_by_non_sender` ("note sender prefix does not match the stored opponent" path), `late_resolution_still_valid`, `consumed_note_cannot_be_reclaimed` (MockChain nullifier), `final_result_cannot_be_reclaimed`, `defeat_note_only_consumable_by_winner_wallet`, `defeat_note_consumed_by_winner_wallet`.
- [ ] Implement, test, lint, commit `feat(contract): 12-hour forfeits with defeat and forfeit notes`.

### Task 5: Stake note

**Files:** new `contracts/masm/stake_note.masm`, `battleship.rs` (`stake_storage`, `make_stake_note(scripts, wallet, game, opp_wallet, opp_game, expiry, asset)`, root substitution of DEFEAT/FORFEIT roots via `{{DEFEAT_ROOT}}`/`{{FORFEIT_ROOT}}`), tests.

**Interfaces:** storage `[my_wallet(2), my_game(2), opp_wallet(2), opp_game(2), expiry]`; script: loop `0..tx::get_num_input_notes()` over `input_note::get_sender(i)`, `input_note::get_script_root(i)` to set flags `my_game_defeated`, `opp_game_defeated`, `my_game_forfeit`, `opp_game_forfeit`; consumer = `active_account::get_id`; allowed iff `(consumer == opp_wallet && (my_game_defeated || opp_game_forfeit_claim))` or `(consumer == my_wallet && (opp_game_defeated || my_game_forfeit_claim || ts > expiry))` where `my_game_forfeit_claim` = forfeit note sent by `my_game`; then `exec.basic_wallet::move_note_assets_to_account`.

- [ ] Tests (fee faucet asset as the stake, `MockChain` fee faucet id): `winner_wallet_claims_both_stakes_with_defeat_note`, `winner_wallet_claims_with_forfeit_note`, `loser_wallet_cannot_claim`, `stake_rejects_defeat_from_stranger`, `staker_refunds_after_expiry`, `staker_cannot_refund_before_expiry`, `stake_without_proof_note_rejected`.
- [ ] Implement, test, lint, commit `feat(contract): conditional stake notes`.

### Task 6: Rust clients: validator and CLI on private accounts with stakes and a forfeit path

**Files:** `helpers.rs` (note args, expected outputs for component notes, wallet accounts with ECDSA for the stake/claim transactions, `fire`, `resolve`, `answer`, `reclaim`, `stake`, `claim`), `validate_testnet.rs` (full staked game: both wallets stake, A wins, A's wallet claims; then a second short game where B stalls and A claims forfeit after advancing... testnet time cannot be advanced: the forfeit variant uses a 12-hour deadline, so it is exercised on MockChain only; the validator asserts the reclaim is rejected before the deadline), `battleship_cli.rs`.
- [ ] Run `validate_testnet` to DONE; commit `feat(rust): private-account clients with stakes`.

### Task 7: Frontend libraries (notes, game, contracts, persistence)

**Files:** `src/lib/contracts.ts` (roots for all five note scripts + `initStorageCommitment()` via a throwaway account), `src/lib/notes.ts` (new layouts), `src/lib/game.ts` (`runSetup` with roots/wallet, `fire`, `resolveShot`, `answerResult`, `reclaim`, `verifyOpponentSeed`), new `src/lib/session.ts` (localStorage record `{ role, myAddress, opponentAddress, gameId, cells, shots, stakeTier, createdAt }` + `load/save/clear`), `src/boot.tsx` (no wipe), tests under `src/lib/__tests__/`.
- [ ] Tests for every parser/builder with the mock SDK; session round trip; commit `feat(frontend): private-game libraries and session persistence`.

### Task 8: Frontend hooks and screens

**Files:** `useStartGame`, `useJoinGame` (private accounts, seed handshake, resume from session), `useGameplaySync` (turn = consume result + fire; forfeit countdown; claim forfeit; defeat/forfeit notes feed the outcome), `useFireShot` (merged into the turn flow), `GamePlay`, `GameStatus` (deadline countdown, outcome), `LobbyScreen` (tier picker, resume banner), `WaitingScreen`.
- [ ] Component tests updated; commit `feat(frontend): turn protocol, forfeits and resume`.

### Task 9: Wallet integration for stakes and claims

**Files:** `package.json` (re-add `@miden-sdk/miden-wallet-adapter-base/react`), `src/providers.tsx` (wallet provider *outside* the Miden provider, used only for `requestTransaction`), new `src/lib/stakes.ts` (build stake note with assets; claim transaction = defeat/forfeit note + both stake notes; mainnet fee top-up P2ID to the game account in the same wallet transaction), `src/hooks/useStakes.ts`, UI in lobby/game over.
- [ ] Tests with the adapter mocked; commit `feat(frontend): USDCx stakes via the wallet`.

### Task 10: End-to-end, docs, feedback

- [ ] Two-browser testnet game with stakes on the testnet faucet asset (tier 0.001 USDCx for testnet), frozen code; forfeit path demonstrated on MockChain only.
- [ ] Update README, ARCHITECTURE, CLAUDE files, skills; `tasks/todo.md`, `feedback.md`; commit `docs: private boards, forfeits and stakes`.
