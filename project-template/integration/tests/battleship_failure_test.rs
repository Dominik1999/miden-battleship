//! Failure-path MockChain tests: every rejection is matched against its MASM error message.

mod common;

use anyhow::Result;
use common::*;
use integration::battleship::*;

#[tokio::test]
async fn handshake_rejects_wrong_seed() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    game.fund(a).await?;
    game.fund(b).await?;
    game.setup(a).await?;
    game.setup(b).await?;
    // A claims to be itself but presents C's seed: the derived id does not match A.
    let roots = game.scripts.roots();
    let note = make_game_note(
        game.scripts.challenge_note.clone(),
        a,
        b,
        handshake_storage(word(GAME_ID), a, game.c.seed, game.a.wallet, &roots),
        serial(77),
    )?;
    game.publish(a, note.clone()).await?;
    let result = game.consume(b, &note).await;
    assert_masm_error(result, "handshake seed does not derive the opponent id");
    Ok(())
}

#[tokio::test]
async fn handshake_rejects_foreign_roots() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    game.fund(a).await?;
    game.fund(b).await?;
    game.setup(a).await?;
    game.setup(b).await?;
    let mut roots = game.scripts.roots();
    roots.result = word([1, 2, 3, 4]);
    let note = make_game_note(
        game.scripts.challenge_note.clone(),
        a,
        b,
        handshake_storage(word(GAME_ID), a, game.a.seed, game.a.wallet, &roots),
        serial(78),
    )?;
    game.publish(a, note.clone()).await?;
    let result = game.consume(b, &note).await;
    assert_masm_error(result, "handshake script roots do not match");
    Ok(())
}

#[tokio::test]
async fn setup_rejects_wrong_ship_count() -> Result<()> {
    let mut game = Game::new()?;
    let a = game.a.id;
    game.fund(a).await?;
    let mut cells = classic_ship_cells();
    cells.pop();
    let result = game.setup_with_rows(a, pack_board(&cells)).await;
    assert_masm_error(result, "board must contain exactly 17 ship cells");
    Ok(())
}

#[tokio::test]
async fn fire_rejected_out_of_turn() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let shot = game.handshake(0, 0).await?;
    // A fired turn 1 and has not received a result: no second shot
    let result = game.fire(a, 1, 1).await;
    assert_masm_error(
        result,
        "fire_shot requires the previous result to be processed",
    );
    // B resolves; now B may fire, but only once
    game.resolve(b, &shot).await?;
    game.fire(b, 5, 5).await?;
    let result = game.fire(b, 6, 6).await;
    assert_masm_error(
        result,
        "fire_shot requires the previous result to be processed",
    );
    Ok(())
}

#[tokio::test]
async fn fire_rejected_on_repeated_cell_and_out_of_bounds() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let shot = game.handshake(0, 0).await?;
    let (result, _) = game.resolve(b, &shot).await?;
    let b_shot = game.fire(b, 9, 9).await?;
    game.resolve(a, &b_shot).await?;
    let repeated = game.answer(a, &result, 0, 0).await;
    assert_masm_error(repeated, "fire_shot: cell was already fired at");
    let oob = game.answer(a, &result, 10, 0).await;
    assert_masm_error(oob, "row is out of bounds");
    Ok(())
}

#[tokio::test]
async fn fire_rejected_with_short_deadline() -> Result<()> {
    let mut game = Game::new()?;
    let b = game.b.id;
    let shot = game.handshake(0, 0).await?;
    game.resolve(b, &shot).await?;
    let too_short = game.now() + DEADLINE_DELTA - 1;
    let result = game.fire_with_deadline(b, 9, 9, too_short).await;
    assert_masm_error(
        result,
        "deadline must be at least 12 hours after the reference block",
    );
    Ok(())
}

#[tokio::test]
async fn shot_rejected_with_wrong_turn_and_from_stranger() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b, c) = (game.a.id, game.b.id, game.c.id);
    let _shot = game.handshake(0, 0).await?;
    // a forged shot note with turn 5 from A: B rejects the turn
    let forged = expected_shot_note(&game.scripts, a, b, 1, 1, 5, game.deadline())?;
    game.publish(a, forged.clone()).await?;
    let result = game.resolve(b, &forged).await;
    assert_masm_error(result, "shot turn does not match the expected turn");
    // a shot from C: B rejects the sender
    game.fund(c).await?;
    let stranger = expected_shot_note(&game.scripts, c, b, 1, 1, 1, game.deadline())?;
    game.publish(c, stranger.clone()).await?;
    let result = game.resolve(b, &stranger).await;
    assert_masm_error(
        result,
        "note sender prefix does not match the stored opponent",
    );
    Ok(())
}

#[tokio::test]
async fn result_rejected_for_wrong_turn() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let shot = game.handshake(0, 0).await?;
    game.resolve(b, &shot).await?;
    // a forged result for turn 7 from B
    let forged = expected_result_note(
        &game.scripts,
        b,
        a,
        7,
        ShotResult {
            is_hit: true,
            game_over: false,
        },
        game.deadline(),
    )?;
    game.publish(b, forged.clone()).await?;
    let result = game.consume(a, &forged).await;
    assert_masm_error(result, "result turn does not match the last fired shot");
    Ok(())
}

#[tokio::test]
async fn forfeit_rejected_before_and_at_deadline() -> Result<()> {
    let mut game = Game::new()?;
    let a = game.a.id;
    let shot = game.handshake(0, 0).await?;
    let result = game.reclaim(a, &shot).await;
    assert_masm_error(result, "claim_forfeit: the deadline has not passed");
    // exactly at the deadline: still rejected (strictly after is required)
    let deadline = ShotNoteStorage::from_note(&shot)?.deadline;
    let wait = deadline - game.now();
    game.advance_time(wait)?;
    assert_eq!(game.now(), deadline);
    let result = game.reclaim(a, &shot).await;
    assert_masm_error(result, "claim_forfeit: the deadline has not passed");
    Ok(())
}

#[tokio::test]
async fn forfeit_rejected_by_non_sender() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let shot = game.handshake(0, 0).await?;
    game.advance_time(DEADLINE_DELTA + 1)?;
    // B consuming A's shot after the deadline still resolves it (first come first served);
    // a stranger cannot consume it at all
    let c = game.c.id;
    game.fund(c).await?;
    let result = game.consume(c, &shot).await;
    assert_masm_error(
        result,
        "note sender prefix does not match the stored opponent",
    );
    let _ = (a, b);
    Ok(())
}

#[tokio::test]
async fn final_result_cannot_be_reclaimed() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let cells = classic_ship_cells();
    let mut shot = game.handshake(cells[0].0, cells[0].1).await?;
    let mut final_result = None;
    for i in 0..cells.len() {
        let (result, _) = game.resolve(b, &shot).await?;
        if i == cells.len() - 1 {
            final_result = Some(result);
            break;
        }
        let b_shot = game.fire(b, 9 - (i as u64 / 10), i as u64 % 10).await?;
        let (b_result, _) = game.resolve(a, &b_shot).await?;
        let (nrow, ncol, _) = cells[i + 1];
        shot = game.answer(a, &result, nrow, ncol).await?;
        game.consume(b, &b_result).await?;
    }
    let final_result = final_result.expect("final result");
    game.advance_time(DEADLINE_DELTA + 1)?;
    let result = game.reclaim(b, &final_result).await;
    assert_masm_error(result, "a final result note cannot be reclaimed");
    Ok(())
}

#[tokio::test]
async fn defeat_note_only_consumable_by_winner_wallet() -> Result<()> {
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
    let id = defeat.id();
    let wallet_b = game.b.wallet;
    let result = game
        .execute_wallet(wallet_b, move |builder| {
            builder.authenticated_input_note(id)
        })
        .await;
    assert!(
        result.is_err(),
        "the loser's wallet must not consume the defeat note"
    );
    Ok(())
}
