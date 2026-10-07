//! Success-path MockChain tests: deploy, setup, seed-anchored handshake, shots, results, game end.

mod common;

use anyhow::Result;
use common::*;
use integration::battleship::*;

#[tokio::test]
async fn funding_note_deploys_the_private_account() -> Result<()> {
    let mut game = Game::new()?;
    let a = game.a.id;
    game.fund(a).await?;
    let state = game.state(a)?;
    assert_eq!(state.phase, PHASE_CREATED);
    assert!(game.fee_balance(a)? < INITIAL_FEE_BALANCE);
    assert!(game.fee_balance(a)? > INITIAL_FEE_BALANCE - 10_000);
    Ok(())
}

#[tokio::test]
async fn setup_stores_board_wallet_and_roots() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    game.fund(a).await?;
    game.setup(a).await?;

    let state = game.state(a)?;
    assert_eq!(state.phase, PHASE_CHALLENGED);
    assert_eq!(state.game_id, word(GAME_ID));
    assert!(state.opponent_is(b));
    assert_eq!(state.owner_wallet, Some(game.a.wallet));
    assert_eq!(state.opponent_wallet, None);
    assert_eq!(state.outcome, OUTCOME_OPEN);
    assert_eq!(game.cell(a, 0, 0)?, 1);
    assert_eq!(game.cell(a, 4, 1)?, 5);
    assert_eq!(game.cell(a, 5, 5)?, CELL_WATER);
    let account = game.account(a)?;
    let roots = game.scripts.roots();
    assert_eq!(read_script_root(&account, ROOT_SHOT), roots.shot);
    assert_eq!(read_script_root(&account, ROOT_RESULT), roots.result);
    assert_eq!(read_script_root(&account, ROOT_DEFEAT), roots.defeat);
    assert_eq!(read_script_root(&account, ROOT_FORFEIT), roots.forfeit);
    Ok(())
}

#[tokio::test]
async fn handshake_pins_roots_wallets_and_roles() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    game.fund(a).await?;
    game.fund(b).await?;
    game.setup(a).await?;
    game.setup(b).await?;

    let challenge = game.challenge_note()?;
    game.publish(a, challenge.clone()).await?;
    assert!(game.is_committed(&challenge));
    game.consume(b, &challenge).await?;
    let sb = game.state(b)?;
    assert_eq!(sb.phase, PHASE_ACTIVE);
    assert_eq!(sb.expected_turn, ACCEPTOR_FIRST_TURN);
    assert_eq!(sb.role, ROLE_ACCEPTOR);
    assert_eq!(sb.opponent_wallet, Some(game.a.wallet));

    let accept = game.accept_note()?;
    game.publish(b, accept.clone()).await?;
    let shot = game.accept_and_fire(&accept, 0, 0).await?;
    let sa = game.state(a)?;
    assert_eq!(sa.phase, PHASE_ACTIVE);
    assert_eq!(sa.expected_turn, CHALLENGER_FIRST_TURN);
    assert_eq!(sa.role, ROLE_CHALLENGER);
    assert_eq!(sa.opponent_wallet, Some(game.b.wallet));
    assert_eq!(sa.shots_fired, 1);
    assert_eq!(sa.last_shot, (0, 0, 1));
    assert!(game.is_committed(&shot));
    assert_eq!(read_my_shot(&game.account(a)?, 0, 0), (true, false));
    Ok(())
}

#[tokio::test]
async fn shot_round_trip_updates_both_accounts() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let shot1 = game.handshake(0, 0).await?; // A fires turn 1 at B's carrier

    let (result1, defeat) = game.resolve(b, &shot1).await?;
    assert!(defeat.is_none());
    let parsed = ResultNoteStorage::from_note(&result1)?;
    assert_eq!(parsed.turn, 1);
    assert_eq!(parsed.shooter, a);
    assert!(parsed.result.is_hit && !parsed.result.game_over);
    assert!(parsed.deadline >= game.now());
    assert!(game.is_committed(&result1));
    let sb = game.state(b)?;
    assert_eq!(game.cell(b, 0, 0)?, CELL_HIT);
    assert_eq!(sb.ships_hit_count, 1);
    assert_eq!(sb.total_shots_received, 1);
    assert_eq!(sb.expected_turn, 3);
    assert_eq!(sb.phase, PHASE_ACTIVE);

    // B (acceptor) fires its first shot, turn 2; each direction's turn numbers are independent.
    let shot2 = game.fire(b, 9, 9).await?;
    let sb = game.state(b)?;
    assert_eq!(sb.shots_fired, 1);
    assert_eq!(sb.last_shot, (9, 9, 2));

    let (result2, _) = game.resolve(a, &shot2).await?;
    assert!(!ResultNoteStorage::from_note(&result2)?.result.is_hit);
    assert_eq!(game.cell(a, 9, 9)?, CELL_MISS);
    assert_eq!(game.state(a)?.expected_turn, 4);

    // A answers its result (turn 1) and fires turn 3 in one transaction.
    let shot3 = game.answer(a, &result1, 0, 1).await?;
    let sa = game.state(a)?;
    assert_eq!(sa.results_processed, 1);
    assert_eq!(sa.shots_fired, 2);
    assert_eq!(sa.last_shot, (0, 1, 3));
    assert_eq!(read_my_shot(&game.account(a)?, 0, 0), (true, true));
    assert_eq!(read_my_shot(&game.account(a)?, 0, 1), (true, false));
    assert_eq!(ShotNoteStorage::from_note(&shot3)?.turn, 3);

    // B answers its miss result and fires turn 4.
    let shot4 = game.answer(b, &result2, 9, 8).await?;
    assert_eq!(read_my_shot(&game.account(b)?, 9, 9), (true, false));
    assert_eq!(ShotNoteStorage::from_note(&shot4)?.turn, 4);
    Ok(())
}

#[tokio::test]
async fn seventeenth_hit_ends_the_game_with_a_defeat_note() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let cells = classic_ship_cells();
    let mut shot = game.handshake(cells[0].0, cells[0].1).await?;
    let mut defeat_note = None;
    for (i, (row, col, _)) in cells.iter().enumerate() {
        let (result, defeat) = game.resolve(b, &shot).await?;
        let parsed = ResultNoteStorage::from_note(&result)?;
        assert!(parsed.result.is_hit, "shot {i} must hit");
        if i == cells.len() - 1 {
            assert!(parsed.result.game_over);
            defeat_note = defeat;
            // the winner processes the final result (no further shot)
            game.consume(a, &result).await?;
            break;
        }
        assert!(defeat.is_none());
        // B fires a miss, A resolves it, then A answers and fires the next hit
        let b_shot = game.fire(b, 9 - (i as u64 / 10), i as u64 % 10).await?;
        let (b_result, _) = game.resolve(a, &b_shot).await?;
        let (nrow, ncol, _) = cells[i + 1];
        shot = game.answer(a, &result, nrow, ncol).await?;
        game.consume(b, &b_result).await?; // B processes its miss; it fires again after resolving
        let _ = (row, col);
    }
    let sb = game.state(b)?;
    assert_eq!(sb.phase, PHASE_COMPLETE);
    assert_eq!(sb.outcome, OUTCOME_LOST);
    assert_eq!(sb.ships_hit_count, TOTAL_SHIP_CELLS);
    let sa = game.state(a)?;
    assert_eq!(sa.phase, PHASE_COMPLETE);
    assert_eq!(sa.outcome, OUTCOME_WON);
    let defeat = defeat_note.expect("defeat note created");
    assert!(game.is_committed(&defeat));
    assert_eq!(defeat.metadata().sender(), b);
    assert_eq!(
        defeat.metadata().tag(),
        miden_client::note::NoteTag::with_account_target(game.a.wallet)
    );
    Ok(())
}

#[tokio::test]
async fn winner_wallet_consumes_the_defeat_note() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let cells = classic_ship_cells();
    let mut shot = game.handshake(cells[0].0, cells[0].1).await?;
    let mut defeat_note = None;
    for i in 0..cells.len() {
        let (result, defeat) = game.resolve(b, &shot).await?;
        if i == cells.len() - 1 {
            defeat_note = defeat;
            break;
        }
        let b_shot = game.fire(b, 9 - (i as u64 / 10), i as u64 % 10).await?;
        let (b_result, _) = game.resolve(a, &b_shot).await?;
        let (nrow, ncol, _) = cells[i + 1];
        shot = game.answer(a, &result, nrow, ncol).await?;
        game.consume(b, &b_result).await?;
    }
    let defeat = defeat_note.expect("defeat note");
    let wallet_a = game.a.wallet;
    let id = defeat.id();
    game.execute_wallet(wallet_a, move |builder| {
        builder.authenticated_input_note(id)
    })
    .await?;
    assert!(game.chain.is_note_consumed(&defeat.nullifier()));
    Ok(())
}

#[tokio::test]
async fn forfeit_after_deadline_emits_forfeit_note() -> Result<()> {
    let mut game = Game::new()?;
    let a = game.a.id;
    let shot = game.handshake(0, 0).await?;
    // B never resolves. After the deadline A reclaims the shot note.
    game.advance_time(DEADLINE_DELTA + 1)?;
    let forfeit = game.reclaim(a, &shot).await?;
    let sa = game.state(a)?;
    assert_eq!(sa.phase, PHASE_COMPLETE);
    assert_eq!(sa.outcome, OUTCOME_WON_BY_FORFEIT);
    assert!(game.is_committed(&forfeit));
    assert_eq!(forfeit.metadata().sender(), a);
    assert_eq!(
        forfeit.metadata().tag(),
        miden_client::note::NoteTag::with_account_target(game.a.wallet)
    );
    // the forfeit note is consumable by A's wallet
    let id = forfeit.id();
    let wallet_a = game.a.wallet;
    game.execute_wallet(wallet_a, move |builder| {
        builder.authenticated_input_note(id)
    })
    .await?;
    Ok(())
}

#[tokio::test]
async fn late_resolution_still_valid_before_reclaim() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let shot = game.handshake(0, 0).await?;
    game.advance_time(DEADLINE_DELTA + 1)?;
    // B is late but first: the resolution succeeds and the shot can no longer be reclaimed.
    let (result, _) = game.resolve(b, &shot).await?;
    assert!(ResultNoteStorage::from_note(&result)?.result.is_hit);
    let reclaim = game.reclaim(a, &shot).await;
    assert!(reclaim.is_err(), "a consumed note cannot be reclaimed");
    assert_eq!(game.state(a)?.phase, PHASE_ACTIVE);
    Ok(())
}
