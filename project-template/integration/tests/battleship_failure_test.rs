//! Failure-path MockChain tests: every rejection is matched against its MASM error message.

mod common;

use anyhow::Result;
use common::*;
use integration::battleship::*;

#[tokio::test]
async fn setup_rejects_wrong_ship_count() -> Result<()> {
    let mut game = Game::new()?;
    let mut cells = classic_ship_cells();
    cells.pop();
    let result = game
        .setup_with_rows(game.a, game.b, A_COMMITMENT, pack_board(&cells))
        .await;
    assert_masm_error(result, "board must contain exactly 17 ship cells");
    Ok(())
}

#[tokio::test]
async fn setup_rejects_wrong_ship_sizes() -> Result<()> {
    let mut game = Game::new()?;
    // 17 cells, but the carrier has 6 cells and the destroyer 1
    let mut cells = classic_ship_cells();
    cells.retain(|(r, c, _)| !(*r == 4 && *c == 1));
    cells.push((0, 5, 1));
    let result = game
        .setup_with_rows(game.a, game.b, A_COMMITMENT, pack_board(&cells))
        .await;
    assert_masm_error(result, "ship 5 (destroyer) must occupy 2 cells");
    Ok(())
}

#[tokio::test]
async fn setup_rejects_invalid_cell_value() -> Result<()> {
    let mut game = Game::new()?;
    let mut rows = pack_board(&classic_ship_cells());
    rows[9] = 6; // cell (9, 0) = 6 is not a ship id
    let result = game
        .setup_with_rows(game.a, game.b, A_COMMITMENT, rows)
        .await;
    assert_masm_error(
        result,
        "board cell value must be water or a ship id in 1..5",
    );
    Ok(())
}

#[tokio::test]
async fn setup_rejects_second_setup() -> Result<()> {
    let mut game = Game::new()?;
    game.setup(game.a, game.b, A_COMMITMENT).await?;
    let result = game.setup(game.a, game.b, A_COMMITMENT).await;
    assert_masm_error(result, "set_board_rows requires the CREATED phase");
    Ok(())
}

#[tokio::test]
async fn challenge_rejected_before_setup() -> Result<()> {
    let mut game = Game::new()?;
    game.setup(game.a, game.b, A_COMMITMENT).await?;
    let challenge = game.challenge_note()?;
    game.publish(game.a, challenge.clone()).await?;
    // B never ran its setup: the stored opponent is zero, so the sender check fails first
    let result = game.consume(game.b, &challenge).await;
    assert_masm_error(
        result,
        "note sender prefix does not match the stored opponent",
    );
    Ok(())
}

#[tokio::test]
async fn challenge_rejected_with_wrong_game_id() -> Result<()> {
    let mut game = Game::new()?;
    game.setup(game.a, game.b, A_COMMITMENT).await?;
    game.setup(game.b, game.a, B_COMMITMENT).await?;
    let note = make_game_note(
        game.scripts.challenge_note.clone(),
        game.a,
        game.b,
        handshake_storage(word([1, 1, 1, 1]), game.a, word(A_COMMITMENT)),
        serial(77),
    )?;
    game.publish(game.a, note.clone()).await?;
    let result = game.consume(game.b, &note).await;
    assert_masm_error(
        result,
        "handshake game id does not match the stored game id",
    );
    Ok(())
}

#[tokio::test]
async fn accept_rejected_twice() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;
    let accept = game.accept_note()?;
    game.publish(game.b, accept.clone()).await?;
    let result = game.consume(game.a, &accept).await;
    assert_masm_error(result, "handshake requires the CHALLENGED phase");
    Ok(())
}

#[tokio::test]
async fn shot_rejected_from_stranger() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;
    let shot = game.shot_note(game.c, game.b, 0, 0, 1)?;
    game.publish(game.c, shot.clone()).await?;
    let result = game.consume_shot(game.b, &shot).await;
    assert_masm_error(
        result,
        "note sender prefix does not match the stored opponent",
    );
    Ok(())
}

#[tokio::test]
async fn shot_rejected_in_challenged_phase() -> Result<()> {
    let mut game = Game::new()?;
    game.setup(game.a, game.b, A_COMMITMENT).await?;
    game.setup(game.b, game.a, B_COMMITMENT).await?;
    let shot = game.shot_note(game.a, game.b, 0, 0, 1)?;
    game.publish(game.a, shot.clone()).await?;
    let result = game.consume_shot(game.b, &shot).await;
    assert_masm_error(result, "process_shot requires the ACTIVE phase");
    Ok(())
}

#[tokio::test]
async fn shot_rejected_with_wrong_turn() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;
    let shot = game.shot_note(game.a, game.b, 0, 0, 5)?;
    game.publish(game.a, shot.clone()).await?;
    let result = game.consume_shot(game.b, &shot).await;
    assert_masm_error(result, "shot turn does not match the expected turn");
    assert_eq!(game.state(game.b)?.total_shots_received, 0);
    Ok(())
}

#[tokio::test]
async fn shot_rejected_out_of_bounds() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;
    let shot = game.shot_note(game.a, game.b, 10, 0, 1)?;
    game.publish(game.a, shot.clone()).await?;
    let result = game.consume_shot(game.b, &shot).await;
    assert_masm_error(result, "row is out of bounds");

    let shot = game.shot_note(game.a, game.b, 0, 10, 1)?;
    game.publish(game.a, shot.clone()).await?;
    let result = game.consume_shot(game.b, &shot).await;
    assert_masm_error(result, "col is out of bounds");
    Ok(())
}

#[tokio::test]
async fn shot_rejected_on_already_shot_cell() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;
    game.fire(game.a, game.b, 5, 5, 1).await?;
    game.fire(game.b, game.a, 5, 5, 2).await?;
    let shot = game.shot_note(game.a, game.b, 5, 5, 3)?;
    game.publish(game.a, shot.clone()).await?;
    let result = game.consume_shot(game.b, &shot).await;
    assert_masm_error(result, "cell has already been shot");
    Ok(())
}

#[tokio::test]
async fn enter_reveal_rejected_in_challenged_phase() -> Result<()> {
    let mut game = Game::new()?;
    game.setup(game.a, game.b, A_COMMITMENT).await?;
    let result = game
        .run_script(game.a, game.scripts.enter_reveal_tx.clone(), None, vec![])
        .await;
    assert_masm_error(result, "enter_reveal requires the ACTIVE phase");
    Ok(())
}

#[tokio::test]
async fn mark_reveal_rejected_in_active_phase() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;
    let result = game
        .run_script(game.a, game.scripts.mark_my_reveal_tx.clone(), None, vec![])
        .await;
    assert_masm_error(result, "mark_my_reveal requires the REVEAL phase");
    Ok(())
}

#[tokio::test]
async fn reveal_rejected_in_active_phase() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;
    let reveal = game.reveal_note(game.a, game.b, A_COMMITMENT)?;
    game.publish(game.a, reveal.clone()).await?;
    let result = game.consume(game.b, &reveal).await;
    assert_masm_error(result, "verify_opponent_reveal requires the REVEAL phase");
    Ok(())
}

#[tokio::test]
async fn reveal_rejected_with_wrong_commitment() -> Result<()> {
    let mut game = Game::new()?;
    game.handshake().await?;
    for (i, (row, col, _)) in classic_ship_cells().iter().enumerate() {
        game.fire(game.a, game.b, *row, *col, i as u64 * 2 + 1)
            .await?;
    }
    let reveal = game.reveal_note(game.a, game.b, [999, 998, 997, 996])?;
    game.publish(game.a, reveal.clone()).await?;
    let result = game.consume(game.b, &reveal).await;
    assert_masm_error(
        result,
        "revealed commitment does not match the stored opponent commitment",
    );
    assert_eq!(game.state(game.b)?.opponent_verified, 0);
    Ok(())
}
