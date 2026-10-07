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
