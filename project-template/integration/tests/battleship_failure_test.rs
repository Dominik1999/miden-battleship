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
