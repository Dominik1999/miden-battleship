//! Stake note tests: conditional P2IDs claimed by the winner's wallet with a defeat or forfeit note.

mod common;

use anyhow::Result;
use common::*;
use integration::battleship::*;

#[tokio::test]
async fn winner_wallet_claims_both_stakes_with_defeat_note() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let (wallet_a, wallet_b) = (game.a.wallet, game.b.wallet);
    let stake_a = game.stake(a).await?;
    let stake_b = game.stake(b).await?;
    assert!(game.wallet_balance(wallet_a)? <= WALLET_BALANCE - STAKE);
    let defeat = game.play_to_defeat().await?;

    let before = game.wallet_balance(wallet_a)?;
    game.claim(wallet_a, &[&defeat, &stake_a, &stake_b]).await?;
    let after = game.wallet_balance(wallet_a)?;
    assert!(
        after > before + 2 * STAKE - 10_000,
        "winner receives both stakes minus the fee: {before} -> {after}"
    );
    assert!(game.wallet_balance(wallet_b)? <= WALLET_BALANCE - STAKE);
    Ok(())
}

#[tokio::test]
async fn winner_wallet_claims_with_forfeit_note() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let wallet_a = game.a.wallet;
    let stake_a = game.stake(a).await?;
    let stake_b = game.stake(b).await?;
    let shot = game.handshake(0, 0).await?;
    game.advance_time(DEADLINE_DELTA + 1)?;
    let forfeit = game.reclaim(a, &shot).await?;
    let before = game.wallet_balance(wallet_a)?;
    game.claim(wallet_a, &[&forfeit, &stake_a, &stake_b])
        .await?;
    assert!(game.wallet_balance(wallet_a)? > before + 2 * STAKE - 10_000);
    Ok(())
}

#[tokio::test]
async fn loser_wallet_cannot_claim() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let wallet_b = game.b.wallet;
    let stake_a = game.stake(a).await?;
    let _stake_b = game.stake(b).await?;
    let _defeat = game.play_to_defeat().await?;
    // the loser's wallet with the winner's stake alone: no proof note
    let result = game.claim(wallet_b, &[&stake_a]).await;
    assert_masm_error(
        result,
        "stake note: the consuming wallet has no claim on this stake",
    );
    Ok(())
}

#[tokio::test]
async fn stake_rejects_defeat_from_wrong_game() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b, c) = (game.a.id, game.b.id, game.c.id);
    let wallet_a = game.a.wallet;
    // B's stake wrongly names C as its own game account
    let me = game.b.clone();
    let expiry = game.now() + STAKE_EXPIRY_DELTA;
    let fee_faucet = game.chain.fee_faucet_id();
    let asset = miden_client::asset::FungibleAsset::new(fee_faucet, STAKE)?.into();
    let parties = StakeParties {
        my_wallet: me.wallet,
        my_game: c,
        opp_wallet: wallet_a,
        opp_game: a,
    };
    let bogus = make_stake_note(&game.scripts, parties, expiry, asset, serial(999))?;
    let account = game.chain.committed_account(me.wallet)?.clone();
    let interface = account.code().interface(me.wallet);
    let script = miden_standards::tx_script::SendNotesTransactionScript::new(
        &interface,
        &[miden_client::note::PartialNote::from(bogus.clone())],
    )?;
    let out = bogus.clone();
    game.execute_wallet(me.wallet, move |builder| {
        builder
            .send_notes_script(&script)
            .expected_output_note(miden_client::transaction::RawOutputNote::Full(out))
    })
    .await?;
    let _stake_a = game.stake(a).await?;
    let defeat = game.play_to_defeat().await?;
    // the defeat note comes from B, but the stake names C: no claim
    let result = game.claim(wallet_a, &[&defeat, &bogus]).await;
    assert_masm_error(
        result,
        "stake note: the consuming wallet has no claim on this stake",
    );
    let _ = b;
    Ok(())
}

#[tokio::test]
async fn staker_refunds_after_expiry_only() -> Result<()> {
    let mut game = Game::new()?;
    let a = game.a.id;
    let wallet_a = game.a.wallet;
    let expiry = game.now() + 1000;
    let opp_game = game.b.id;
    let stake_a = game.stake_custom(a, opp_game, expiry).await?;
    let result = game.claim(wallet_a, &[&stake_a]).await;
    assert_masm_error(
        result,
        "stake note: the consuming wallet has no claim on this stake",
    );
    game.advance_time(2000)?;
    let before = game.wallet_balance(wallet_a)?;
    game.claim(wallet_a, &[&stake_a]).await?;
    assert!(game.wallet_balance(wallet_a)? > before + STAKE - 10_000);
    Ok(())
}

#[tokio::test]
async fn winner_recovers_own_stake_with_opponents_defeat() -> Result<()> {
    let mut game = Game::new()?;
    let (a, b) = (game.a.id, game.b.id);
    let wallet_a = game.a.wallet;
    let stake_a = game.stake(a).await?;
    let _stake_b = game.stake(b).await?;
    let defeat = game.play_to_defeat().await?;
    let before = game.wallet_balance(wallet_a)?;
    game.claim(wallet_a, &[&defeat, &stake_a]).await?;
    assert!(game.wallet_balance(wallet_a)? > before + STAKE - 10_000);
    Ok(())
}
