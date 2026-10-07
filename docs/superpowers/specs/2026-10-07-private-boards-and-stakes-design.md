# Private boards, 12-hour forfeits and USDCx stakes

Status: approved 2026-10-07; implementation plan in `docs/superpowers/plans/2026-10-07-private-boards-and-stakes.md`, whose "Spec refinements" section amends four details (script roots in storage, client-chosen deadlines, an `outcome` slot, anchoring against the verifier's own code commitment). Target: partner mainnet in two weeks, real USDCx.

## 1. Goals

- Boards are never visible to the opponent, the node or a prover operator.
- Two players can stake $1, $5 or $10 in USDCx; the winner receives the whole pot in their wallet.
- A player who does not move for 12 hours loses; the opponent collects the pot without any
  arbiter.
- Gameplay stays popup-free; the wallet signs exactly two transactions per game: staking and
  claiming.
- A reload or a restart resumes the game; a backup of the game account can be exported.

## 2. Non-goals

- Hiding who plays whom, the shot coordinates or the results: shots and results stay public
  notes.
- Multi-game accounts or rematches: one game account per match, as today.
- A leaderboard. It can be built later from the public defeat and forfeit notes.
- Protection against a player who deletes their own game account state: they lose their stake
  by forfeit, which is the intended outcome.

## 3. Why private accounts replace commit-reveal

A private Miden account publishes only a state commitment; each transaction proves a valid
transition under the account's code without revealing the state.

- The setup transaction writes the board into private storage and validates the fleet. From
  that block on the account commitment pins the board; no procedure changes a row except
  marking hits.
- Each shot is resolved inside a proof, so the public result note is attested against the
  committed board.
- The current reveal exchange (random commitment word, reveal notes, `enter_reveal`,
  `mark_my_reveal`, `verify_opponent_reveal`) verifies nothing and is removed.

Two conditions make this trustworthy and are enforced on-chain:

1. **Code anchoring.** The account ID is `hash(seed, code commitment, initial storage
   commitment)` and the kernel checks it at the account's first transaction. The challenge and
   accept notes carry the sender's seed; `accept_challenge` and `receive_acceptance` recompute
   the ID from the seed and the known commitments and reject a mismatch. Clients also run this
   check before staking.
2. **Prover trust (decided 2026-10-07).** Every game-account transaction carries the full
   private state as prover input, so the prover operator can read the board and, because game
   accounts stay `NoAuth`, could also execute transactions on them. The partner-operated remote
   prover is trusted for both; the node, the opponent and the public never see a board and
   cannot act on an account whose state they do not hold. Local in-browser proving remains an
   opt-in "private mode" (about 3x slower per turn) for players who do not want to trust the
   prover with their board.

## 4. Game protocol

Roles are unchanged: the joiner is the challenger and fires turn 1; the starter is the
acceptor.

Every move is one transaction that consumes the opponent's pending note and emits the
player's own note, so exactly one note is always pending with the party whose move it is:

| Move | Consumes | Emits |
|------|----------|-------|
| Accept (acceptor) | challenge note | accept note |
| Start (challenger) | accept note | shot note, turn 1 |
| Resolve (defender) | shot note, turn t | result note, turn t |
| Answer (shooter) | result note, turn t | shot note, turn t+2 |
| Final resolve (defender, 17th hit) | shot note | result note with `game_over`, defeat note |

Shot and result notes are created by the game component (`fire_shot`, `process_shot`), not by
the wallet's send script, so the component can enforce that every note it emits is consumable
by a genuine opponent: correct turn, in-bounds cell, no repeated cell, previous result
processed.

### Deadlines and forfeits

Each shot and result note stores `deadline = block timestamp at creation + 43 200 s`. After the
deadline the note's sender may consume its own note instead of the opponent; the note script
routes that case to `claim_forfeit`, which verifies that the note was created by this account
(sender = native account), carries the shot or result script root, and that the reference
block timestamp is past the deadline. The kernel's reference block is at most the chain tip,
so the deadline cannot be forged early, and a note that was consumed can never be reclaimed.
`claim_forfeit` moves the account to COMPLETE and emits a **forfeit note**.

The final result note and the defeat note have no reclaim path: once the game is decided the
winner's silence is not a forfeit.

### Game over

The 17th hit moves the defender to COMPLETE and emits the **defeat note**, addressed to the
winner's wallet. The winner's account learns the outcome from the result note's `game_over`
flag when it processes it (`process_result`), which moves it to COMPLETE too.

## 5. Contract changes (`contracts/masm`)

### Storage (game account, private)

| Slot | Content |
|------|---------|
| `game_config` | `[grid_size, total_ship_cells, phase, expected_turn]` (unchanged) |
| `opponent` | `[prefix, suffix, ships_hit_count, total_shots_received]` (unchanged) |
| `game_id` | shared game id (unchanged) |
| `owner_wallet` | `[prefix, suffix, 0, 0]`: the wallet that receives notes about this game |
| `opponent_wallet` | `[prefix, suffix, 0, 0]`: learned from the handshake note |
| `turn_state` | `[shots_fired, results_processed, last_shot_row, last_shot_col]` |
| `my_board` (map) | packed rows (unchanged) |
| `my_shots` (map) | key `[0,0,0,row]`, value `[fired_bits, 0, 0, 0]`: cells I fired at |

Removed: `board_commitment`, `opponent_commitment`, `reveal_status`. Phases: CREATED,
CHALLENGED, ACTIVE, COMPLETE (REVEAL removed). A `result` field in `game_config[1]` records
the outcome: 0 open, 1 won, 2 lost, 3 won by forfeit, 4 lost by forfeit.

### Procedures

| Procedure | Caller | Behaviour |
|-----------|--------|-----------|
| `set_board_rows`, `finalize_board` | setup tx script | unchanged, plus `owner_wallet` |
| `accept_challenge` | challenge note | existing checks + seed-derived ID check of the challenger + stores `opponent_wallet` |
| `receive_acceptance` | accept note | existing checks + seed check + stores `opponent_wallet`; the tx script then calls `fire_shot` for turn 1 |
| `fire_shot(row, col)` | tx script | ACTIVE, `shots_fired == results_processed` (challenger) or `== results_processed` after the first received shot (acceptor), cell in bounds and not in `my_shots`; records the cell, creates the shot note with `turn`, `deadline`, result serial and the result/defeat script roots |
| `process_shot` | shot note | unchanged checks; on the 17th hit also creates the defeat note to `opponent_wallet` and sets COMPLETE/lost |
| `process_result` | result note | sender = opponent, turn = last fired turn; records hit/miss in `my_shots` value bits; on `game_over` sets COMPLETE/won |
| `claim_forfeit` | shot or result note (reclaim branch) | see section 4; sets COMPLETE/won-by-forfeit and creates the forfeit note to `owner_wallet`... addressed so that only the owner's wallet can consume it |

The handshake notes grow to `[GAME_ID(4), sender_prefix, sender_suffix, SEED(4),
wallet_prefix, wallet_suffix]` (12 items). The commitment word is gone.

### Note scripts

| Script | Consumer | Logic |
|--------|----------|-------|
| challenge, accept | opponent game account | as today, with the longer storage |
| shot | defender, or sender after deadline | `if sender == native account: call claim_forfeit else call process_shot` |
| result | shooter, or sender after deadline unless `game_over` | symmetric |
| defeat | winner's wallet only | asserts native account = stored wallet; moves nothing; its existence as an input note is the proof |
| forfeit | winner's wallet only | same as defeat |
| stake | see section 6 | conditional P2ID |

Script roots of result, defeat and forfeit are constants embedded in the component at compile
time (the compiler substitutes them before assembling the component, as it does for the result
root today).

## 6. Stakes

A stake note is created by the player's wallet (MidenFi, one signature) and holds the stake.
Storage: `[my_wallet(2), my_game(2), opponent_wallet(2), opponent_game(2), expiry_timestamp]`.
It can be consumed only in these cases, each checked by the script:

| Consumer | Condition |
|----------|-----------|
| opponent's wallet | the same transaction consumes a defeat note sent by `my_game`, or a forfeit note sent by `opponent_game` |
| my wallet | the same transaction consumes a defeat note sent by `opponent_game`, or a forfeit note sent by `my_game` |
| my wallet | reference block timestamp past `expiry` (60 days) |

Sibling input notes are inspected with the kernel's `input_note::get_sender` and
`input_note::get_script_root`. Assets are moved with the wallet's `receive_asset`, as P2ID does.

Flow: the challenger stakes when challenging, the acceptor stakes when accepting. Each client
waits for the opponent's stake note (matching tier and account ids) before its first shot; a
missing counter-stake is a UI refusal to play, not a contract rule. The winner claims both
stakes and the defeat or forfeit note in one wallet transaction.

Tiers: 1, 5 and 10 USDCx (6 decimals). The tier is carried in the challenge note so the
acceptor's client can show it before accepting.

## 7. Frontend

- Game accounts: `AccountType.Private`, `NoAuth` (unchanged), BasicWallet for receiving the
  fee top-up. The random account seed is the only secret needed to keep the account out of
  anyone's reach except the prover; no key, no keystore.
- Fee funding on mainnet: the wallet sends a USDCx P2ID note to the game account at creation
  (one of the two wallet signatures is combined with the stake: stake note + fee note in the
  same wallet transaction). Testnet keeps the faucet.
- Prover setting: remote prover by default (partner endpoint on mainnet); an opt-in private
  mode switches game-account transactions to `TransactionProver.newLocalProver()`, with
  cross-origin isolation enabled so the SDK worker gets a thread pool.
- Wallet adapter (`@miden-sdk/miden-wallet-adapter-react`) returns for two actions: stake and
  claim. The `MidenProvider` is rendered without a signer provider; the adapter is used only to
  request those transactions.
- Session persistence: no storage wipe on load; a localStorage record (role, addresses, game
  id, ship cells, shot log) plus on-chain state rebuilds the screen. Account export/import
  buttons for backup.
- Gameplay hooks follow the new protocol: a turn is one transaction (`process_result` +
  `fire_shot`); a visible countdown shows the opponent's deadline; after the deadline the UI
  offers "claim forfeit".

## 8. Rust side

- MockChain tests for: code anchoring (wrong seed rejected), `fire_shot` guards (turn order,
  repeat cell, bounds), forfeit (reclaim before deadline rejected, after deadline emits the
  forfeit note, consumed notes cannot be reclaimed), defeat note on the 17th hit, stake note
  conditions (all five rows of the table in section 6, plus wrong wallet rejected), no reclaim
  on final result and defeat notes.
- `validate_testnet` plays the full staked game with private accounts and a forfeit variant.

## 9. Open items and risks

- **Stall griefing cost.** A stalling player loses the pot after 12 hours; the honest player
  must come back after 12 hours to claim. The UI must make that explicit.
- **Clock.** Deadlines use block timestamps; a 12-hour deadline tolerates block-time drift.
- **State loss.** A player who loses the browser store loses by forfeit. Backup export is the
  mitigation.
- **Wallet capabilities.** The stake transaction is a custom note with assets created through
  the wallet adapter; confirm the partner wallet supports custom-script notes with assets.
- **Prover trust.** The prover operator can read boards and, with `NoAuth`, execute moves on
  any game account whose transactions it has proven. Accepted for the partner-run prover;
  revisit (ECDSA on game accounts, or local proving) before opening to third-party provers.
- **Prover time.** See section 10.

## 10. Spike: in-browser proving (measured 2026-10-07)

Throwaway page, private game account, `TransactionProver.newLocalProver()`, single-thread SDK
build with the SDK worker's rayon pool (`crossOriginIsolated = true`, 12 hardware threads,
Apple Silicon laptop). Each figure is wall time from submit to commit, so it includes 3 to 6 s
of block and poll latency on top of proving.

| Transaction (trace) | NoAuth, 2 runs | ECDSA |
|---------------------|----------------|-------|
| consume funding note, deploys the account (2^14) | 16.5 s, 13.0 s | 22.6 s |
| setup tx script (2^15, same size as a shot resolution) | 19.0 s, 22.1 s | 21.8 s |
| publish a note with the wallet send script (2^14) | 12.4 s, 15.6 s | 16.4 s |
| consume a handshake note (2^14) | 15.9 s, 12.8 s | 13.4 s |

For comparison, the remote testnet prover took about 6 s per transaction submit-to-commit in
the two-browser game of the same day (33 turns in ~6.5 minutes), i.e. 2 to 4 s of proving.

Conclusions:

- Local proving costs roughly 8 to 17 s per transaction on this machine, about 3x the remote
  prover; a full turn (shooter's `process_result` + `fire_shot`, then the defender's
  `process_shot`) would take 30 to 40 s locally versus about 12 s remotely.
- ECDSA would add a few seconds at most locally and nothing remotely; it was measured as the
  option that keeps the prover operator read-only, and rejected for now in favour of trusting
  the prover (game accounts stay `NoAuth`).
- Recommendation: remote prover by default on mainnet, with the privacy caveat that the prover
  operator can read the boards; local proving as an opt-in private mode. The UI shows a
  proving indicator in both modes.
- Mobile and low-core machines will be slower; the multithreaded SDK build
  (`@miden-sdk/miden-sdk/mt`) is the lever if needed.
- Side finding: a note an account sends to itself is never surfaced as an input note by the
  same client, so the spike measured setup instead of a self-resolved shot.
- The web SDK does expose `Poseidon2.hashElements`, so the setup script's advice-payload
  preimage check (removed during the migration) can be restored; the spec keeps the key-based
  variant since the payload is the owner's own data.


## Implementation refinements (2026-10-07, after the build)

- Turn rule: `fire_shot` only requires `results_processed == shots_fired` (the previous result is processed); the acceptor is not additionally bound to the number of shots received, so a delayed answer never squeezes a deadline.
- Every move is one transaction: the opponent's pending notes (result, shot, or the acceptance for the challenger's first move) are consumed first, then `fire_tx` runs. The defender's result deadline is the shot note's argument.
- Browser deadlines come from the wall clock plus `DEADLINE_MARGIN_SECONDS` (the SDK's client wrapper exposes no block header); forfeits are claimed `CLAIM_MARGIN_SECONDS` after the deadline.
- Browser accounts are built with `buildWithoutSchemaCommitment()` so the pinned initial storage commitment equals the Rust builder's.
- Testnet wallets are local public NoAuth accounts funded from the faucet; the extension wallet is the mainnet follow-up.
