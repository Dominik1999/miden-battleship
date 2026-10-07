# Coverage of the pre-0.17 integration tests and binaries (summary, 2026-10-07)

Source: integration/tests/*.rs and integration/src/bin/*.rs as of commit 24768b3 (old 0.14 API).
Kept so the 0.17 rewrite preserves the same assertions.

## Storage layouts (unchanged in the MASM rewrite except the board map)
- game_config: [grid_size, num_placed, phase, expected_turn]; phases 0 CREATED, 1 CHALLENGED, 2 ACTIVE, 3 REVEAL, 4 COMPLETE
- opponent: [opp_prefix, opp_suffix, ships_hit_count, total_shots_received]
- game_id, board_commitment, opponent_commitment: full words
- reveal_status: [my_revealed, opponent_verified]
- board: now one map slot `my_board`, key [0,0,0,row] -> [packed_row,0,0,0]; cell = (packed >> col*3) & 7; 0 water, 1..5 ship, 6 HIT, 7 MISS

## Flow
1. Each player sets up its own board (now the setup tx script), naming the opponent: phase 1.
2. Challenger A sends challenge note (A id + A commitment) -> B consumes: B ACTIVE, expected_turn 1, opp_commit = A's.
3. B sends accept note -> A consumes: A ACTIVE, expected_turn 2, opp_commit = B's.
4. Challenger fires turn 1 at B; defender consumes the shot note, which writes 6/7 to the cell, bumps counters, advances expected_turn by 2 and emits the public result note (storage [shooter_prefix, shooter_suffix, turn, hit*2+game_over], serial from the shot note, tag -> shooter).
5. 17th hit auto-moves the defender to REVEAL. The winner runs enter_reveal on itself (ACTIVE -> REVEAL).
6. Both run mark_my_reveal (reveal_status[0]=1); each consumes the other's reveal note (verify commitment, reveal_status[1]=1, phase 4 when both set).

## Assertions to keep (per old test)
- create account: game_config == 0
- setup: phase 1, game_id, board_commitment, opponent prefix/suffix, cell(0,0)==1, cell(5,5)==0
- accept: phase 2, expected_turn 1, opponent_commitment
- shot miss (5,5,t1): cell 7, total_shots 1, hits 0, expected_turn 3
- shot hit (0,0,t1): cell 6, hits 1, total 1; result note created (>=1 output note), encoded 2 (hit) / 0 (miss) / 3 (final hit)
- handshake two accounts: A/B phase 1 -> B (2, turn 1, A commit) -> A (2, turn 2, B commit)
- enter_reveal: 2 -> 3; mark_my_reveal: reveal_status[0]=1; verify: reveal_status[1]=1 and phase 4
- victory: 17 shots over all ship cells, turns 2i+1; final phase 3, hits 17, total 17
- full game A wins: as flow above, both end at phase 4
- failures (is_err only): wrong turn (5 when 1 expected), duplicate cell, shot in CHALLENGED, enter_reveal in CHALLENGED, wrong reveal commitment
- benchmarks: print cycle measurements for setup, shot, baseline wallet; print result script root

## Binaries
- validate_local: full game A wins against a node (setup A/B, challenge, accept, 17 shots with expected result recipient, enter_reveal, mark x2, reveal exchange). No storage asserts (to add).
- deploy_testnet: creates A and B, runs setup + handshake on testnet, prints ids and result script root for the frontend.
- battleship_cli: interactive two-terminal game (--player, --role, --game-id, --opponent); polls tags; never exchanged reveal notes.
- test_prover: one-off remote prover timing probe; drop.
