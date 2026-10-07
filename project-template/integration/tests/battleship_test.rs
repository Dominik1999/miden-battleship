//! Success-path MockChain tests: setup, handshake, shots and results, reveal, a full game.

mod common;

use anyhow::Result;
use common::*;
use integration::battleship::*;
use miden_client::note::NoteTag;

#[tokio::test]
async fn fresh_account_is_in_created_phase() -> Result<()> {
    let game = Game::new()?;
    let state = game.state(game.a)?;
    assert_eq!(state.phase, PHASE_CREATED);
    assert_eq!(state.expected_turn, 0);
    assert_eq!(game.fee_balance(game.a)?, INITIAL_FEE_BALANCE);
    Ok(())
}

#[tokio::test]
async fn setup_stores_board_and_enters_challenged() -> Result<()> {
    let mut game = Game::new()?;
    game.setup(game.a, game.b, A_COMMITMENT).await?;

    let state = game.state(game.a)?;
    assert_eq!(state.phase, PHASE_CHALLENGED);
    assert_eq!(state.game_id, word(GAME_ID));
    assert_eq!(state.board_commitment, word(A_COMMITMENT));
    assert!(state.opponent_is(game.b));
    assert_eq!(state.ships_hit_count, 0);
    assert_eq!(state.total_shots_received, 0);

    // classic placement: carrier on row 0, destroyer on row 4 cols 0..1
    assert_eq!(game.cell(game.a, 0, 0)?, 1);
    assert_eq!(game.cell(game.a, 0, 4)?, 1);
    assert_eq!(game.cell(game.a, 4, 1)?, 5);
    assert_eq!(game.cell(game.a, 4, 2)?, CELL_WATER);
    assert_eq!(game.cell(game.a, 5, 5)?, CELL_WATER);
    Ok(())
}

#[tokio::test]
async fn setup_pays_the_transaction_fee() -> Result<()> {
    let mut game = Game::new()?;
    let executed = game.setup(game.a, game.b, A_COMMITMENT).await?;
    let fee = executed.compute_fee().as_u64();
    assert!(fee > 0, "a fee-charging chain must compute a non-zero fee");
    // NoAuth pays at least the computed fee from the account vault
    assert!(game.fee_balance(game.a)? <= INITIAL_FEE_BALANCE - fee);
    Ok(())
}

#[tokio::test]
async fn handshake_activates_both_accounts() -> Result<()> {
    let mut game = Game::new()?;
    game.setup(game.a, game.b, A_COMMITMENT).await?;
    game.setup(game.b, game.a, B_COMMITMENT).await?;
    assert_eq!(game.state(game.a)?.phase, PHASE_CHALLENGED);
    assert_eq!(game.state(game.b)?.phase, PHASE_CHALLENGED);

    let challenge = game.challenge_note()?;
    game.publish(game.a, challenge.clone()).await?;
    assert!(game.chain.is_note_committed(&challenge.id()));
    game.consume(game.b, &challenge).await?;
    let b = game.state(game.b)?;
    assert_eq!(b.phase, PHASE_ACTIVE);
    assert_eq!(b.expected_turn, ACCEPTOR_FIRST_TURN);
    assert_eq!(b.opponent_commitment, word(A_COMMITMENT));
    assert_eq!(game.state(game.a)?.phase, PHASE_CHALLENGED);

    let accept = game.accept_note()?;
    game.publish(game.b, accept.clone()).await?;
    game.consume(game.a, &accept).await?;
    let a = game.state(game.a)?;
    assert_eq!(a.phase, PHASE_ACTIVE);
    assert_eq!(a.expected_turn, CHALLENGER_FIRST_TURN);
    assert_eq!(a.opponent_commitment, word(B_COMMITMENT));
    Ok(())
}

#[tokio::test]
async fn shot_miss_creates_result_note_for_shooter() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;

    let (executed, result) = game.fire(game.a, game.b, 5, 5, 1).await?;
    let parsed = ResultNoteStorage::from_note(&result)?;
    assert_eq!(
        parsed.result,
        ShotResult {
            is_hit: false,
            game_over: false
        }
    );
    assert_eq!(parsed.turn, 1);
    assert_eq!(parsed.shooter_prefix, id_prefix(game.a));
    assert_eq!(parsed.shooter_suffix, id_suffix(game.a));
    assert_eq!(result.metadata().sender(), game.b);
    assert_eq!(
        result.metadata().tag(),
        NoteTag::with_account_target(game.a)
    );
    assert!(executed.output_notes().num_notes() >= 1);

    assert_eq!(game.cell(game.b, 5, 5)?, CELL_MISS);
    let b = game.state(game.b)?;
    assert_eq!(b.phase, PHASE_ACTIVE);
    assert_eq!(b.ships_hit_count, 0);
    assert_eq!(b.total_shots_received, 1);
    assert_eq!(b.expected_turn, 3);

    // the shooter can consume the result note (no-op script) once it is committed
    assert!(game.chain.is_note_committed(&result.id()));
    game.consume(game.a, &result).await?;
    Ok(())
}

#[tokio::test]
async fn shot_hit_marks_cell_and_counts() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;

    let (_, result) = game.fire(game.a, game.b, 0, 0, 1).await?;
    let parsed = ResultNoteStorage::from_note(&result)?;
    assert_eq!(
        parsed.result,
        ShotResult {
            is_hit: true,
            game_over: false
        }
    );
    assert_eq!(game.cell(game.b, 0, 0)?, CELL_HIT);
    let b = game.state(game.b)?;
    assert_eq!(b.ships_hit_count, 1);
    assert_eq!(b.total_shots_received, 1);
    assert_eq!(b.expected_turn, 3);
    Ok(())
}

#[tokio::test]
async fn shot_result_matches_expected_recipient() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;

    let shot = game.shot_note(game.a, game.b, 0, 0, 1)?;
    let shot_storage = ShotNoteStorage::from_note(&shot)?;
    let expected = expected_result_note(
        game.scripts.result_note.clone(),
        game.b,
        game.a,
        1,
        ShotResult {
            is_hit: true,
            game_over: false,
        },
        shot_storage.result_serial_num,
    )?;
    game.publish(game.a, shot.clone()).await?;
    let executed = game
        .consume_shot_expecting(game.b, &shot, expected.clone())
        .await?;
    assert_eq!(game.result_note_of(&executed)?.id(), expected.id());
    Ok(())
}

#[tokio::test]
async fn shots_alternate_between_players() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;

    game.fire(game.a, game.b, 9, 9, 1).await?;
    let (_, result) = game.fire(game.b, game.a, 1, 0, 2).await?;
    assert!(ResultNoteStorage::from_note(&result)?.result.is_hit);
    assert_eq!(game.state(game.a)?.expected_turn, 4);
    assert_eq!(game.state(game.b)?.expected_turn, 3);
    game.fire(game.a, game.b, 9, 8, 3).await?;
    assert_eq!(game.state(game.b)?.expected_turn, 5);
    Ok(())
}

#[tokio::test]
async fn seventeenth_hit_ends_the_game() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;

    let cells = classic_ship_cells();
    for (i, (row, col, _)) in cells.iter().enumerate() {
        let turn = i as u64 * 2 + 1;
        let (_, result) = game.fire(game.a, game.b, *row, *col, turn).await?;
        let parsed = ResultNoteStorage::from_note(&result)?;
        assert!(parsed.result.is_hit, "shot {i} at ({row}, {col}) must hit");
        assert_eq!(
            parsed.result.game_over,
            i == cells.len() - 1,
            "shot {i} game_over flag"
        );
        assert_eq!(parsed.turn, turn);
    }

    let b = game.state(game.b)?;
    assert_eq!(b.phase, PHASE_REVEAL);
    assert_eq!(b.ships_hit_count, TOTAL_SHIP_CELLS);
    assert_eq!(b.total_shots_received, TOTAL_SHIP_CELLS);
    Ok(())
}

#[tokio::test]
async fn full_game_a_wins() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;

    // A sinks B's fleet; B fires back misses in between.
    let cells = classic_ship_cells();
    for (i, (row, col, _)) in cells.iter().enumerate() {
        let (_, result) = game
            .fire(game.a, game.b, *row, *col, i as u64 * 2 + 1)
            .await?;
        assert!(ResultNoteStorage::from_note(&result)?.result.is_hit);
        if i < cells.len() - 1 {
            let (row, col) = (9 - i as u64 / 10, i as u64 % 10);
            let (_, result) = game
                .fire(game.b, game.a, row, col, i as u64 * 2 + 2)
                .await?;
            assert!(!ResultNoteStorage::from_note(&result)?.result.is_hit);
        }
    }
    assert_eq!(game.state(game.b)?.phase, PHASE_REVEAL);
    assert_eq!(game.state(game.a)?.phase, PHASE_ACTIVE);

    // the winner enters the reveal phase on its own account
    game.run_script(game.a, game.scripts.enter_reveal_tx.clone(), None, vec![])
        .await?;
    assert_eq!(game.state(game.a)?.phase, PHASE_REVEAL);

    // both players send their reveal note and record that they did
    let reveal_a = game.reveal_note(game.a, game.b, A_COMMITMENT)?;
    game.publish(game.a, reveal_a.clone()).await?;
    game.run_script(game.a, game.scripts.mark_my_reveal_tx.clone(), None, vec![])
        .await?;
    let reveal_b = game.reveal_note(game.b, game.a, B_COMMITMENT)?;
    game.publish(game.b, reveal_b.clone()).await?;
    game.run_script(game.b, game.scripts.mark_my_reveal_tx.clone(), None, vec![])
        .await?;
    assert_eq!(game.state(game.a)?.my_revealed, 1);
    assert_eq!(game.state(game.b)?.my_revealed, 1);
    assert_eq!(game.state(game.a)?.phase, PHASE_REVEAL);

    // each verifies the other's reveal; the game completes on both accounts
    game.consume(game.b, &reveal_a).await?;
    let b = game.state(game.b)?;
    assert_eq!(b.opponent_verified, 1);
    assert_eq!(b.phase, PHASE_COMPLETE);
    assert_eq!(game.state(game.a)?.phase, PHASE_REVEAL);

    game.consume(game.a, &reveal_b).await?;
    let a = game.state(game.a)?;
    assert_eq!(a.opponent_verified, 1);
    assert_eq!(a.phase, PHASE_COMPLETE);

    // every transaction paid a fee from the game account
    assert!(game.fee_balance(game.a)? < INITIAL_FEE_BALANCE);
    assert!(game.fee_balance(game.b)? < INITIAL_FEE_BALANCE);
    Ok(())
}

#[tokio::test]
async fn reveal_completes_in_either_order() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;
    for (i, (row, col, _)) in classic_ship_cells().iter().enumerate() {
        game.fire(game.a, game.b, *row, *col, i as u64 * 2 + 1)
            .await?;
    }
    game.run_script(game.a, game.scripts.enter_reveal_tx.clone(), None, vec![])
        .await?;

    // B verifies A's reveal before marking its own: verified first, complete after marking
    let reveal_a = game.reveal_note(game.a, game.b, A_COMMITMENT)?;
    game.publish(game.a, reveal_a.clone()).await?;
    game.consume(game.b, &reveal_a).await?;
    let b = game.state(game.b)?;
    assert_eq!(
        (b.my_revealed, b.opponent_verified, b.phase),
        (0, 1, PHASE_REVEAL)
    );
    game.run_script(game.b, game.scripts.mark_my_reveal_tx.clone(), None, vec![])
        .await?;
    let b = game.state(game.b)?;
    assert_eq!(
        (b.my_revealed, b.opponent_verified, b.phase),
        (1, 1, PHASE_COMPLETE)
    );
    Ok(())
}
