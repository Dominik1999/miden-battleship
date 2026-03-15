//! Deploys two battleship game accounts to testnet and runs game setup through ACTIVE state.
//!
//! Usage:
//!   cd project-template && cargo run --bin deploy_testnet --release
//!
//! Outputs: bech32 addresses for both game accounts and the result_script_root.

use integration::battleship::*;
use integration::helpers::*;

use anyhow::{Context, Result};
use miden_client::{
    note::NoteTag,
    transaction::{OutputNote, TransactionRequestBuilder},
    Felt, Word,
};
use miden_client::address::NetworkId;
use std::path::Path;

/// Wait for sync to reflect changes, with retries.
async fn sync_and_wait(
    client: &mut miden_client::Client<miden_client::keystore::FilesystemKeyStore>,
) -> Result<()> {
    for _ in 0..15 {
        client.sync_state().await?;
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Ok(())
}

/// Publish a note from the sender account.
async fn publish_note(
    client: &mut miden_client::Client<miden_client::keystore::FilesystemKeyStore>,
    sender_id: miden_client::account::AccountId,
    note: miden_client::note::Note,
) -> Result<()> {
    let request = TransactionRequestBuilder::new()
        .own_output_notes(vec![OutputNote::Full(note)])
        .build()
        .context("Failed to build publish request")?;
    client
        .submit_new_transaction(sender_id, request)
        .await
        .context("Failed to submit publish transaction")?;
    sync_and_wait(client).await?;
    Ok(())
}

/// Consume a note on the target account.
async fn consume_note(
    client: &mut miden_client::Client<miden_client::keystore::FilesystemKeyStore>,
    account_id: miden_client::account::AccountId,
    note: miden_client::note::Note,
) -> Result<()> {
    let request = TransactionRequestBuilder::new()
        .input_notes([(note, None)])
        .build()
        .context("Failed to build consume request")?;
    client
        .submit_new_transaction(account_id, request)
        .await
        .context("Failed to submit consume transaction")?;
    sync_and_wait(client).await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    println!("=== Battleship Testnet Deployment ===\n");

    // ── Setup client (testnet) ──
    println!("[1/5] Connecting to testnet...");
    let ClientSetup {
        mut client,
        keystore,
    } = setup_client().await?;
    let sync = client.sync_state().await?;
    println!("  Connected. Latest block: {}", sync.block_num);

    // ── Build packages ──
    println!("[2/5] Building contracts...");
    let pkgs = build_all_packages_from(Path::new("contracts"))?;
    println!("  All 8 packages built.");

    // Get result_script_root for frontend config
    let result_script_root = get_note_script_root(&pkgs.result_note);
    println!("  result_script_root: [{}, {}, {}, {}]",
        result_script_root[0].as_int(),
        result_script_root[1].as_int(),
        result_script_root[2].as_int(),
        result_script_root[3].as_int(),
    );

    // ── Create accounts ──
    println!("[3/5] Creating accounts...");
    let config = AccountCreationConfig {
        storage_slots: all_storage_slots(),
        ..Default::default()
    };

    let sender = create_basic_wallet_account(&mut client, keystore.clone(), AccountCreationConfig::default()).await?;
    println!("  Sender wallet: {}", sender.id().to_bech32(NetworkId::Testnet));

    let account_a = create_authenticated_game_account(
        &mut client, keystore.clone(), pkgs.contract.clone(), config.clone(),
    ).await?;
    println!("  Player A (challenger): {}", account_a.id().to_bech32(NetworkId::Testnet));

    let account_b = create_authenticated_game_account(
        &mut client, keystore.clone(), pkgs.contract.clone(), config.clone(),
    ).await?;
    println!("  Player B (acceptor): {}", account_b.id().to_bech32(NetworkId::Testnet));

    let a_prefix = account_a.id().prefix().as_felt();
    let a_suffix = account_a.id().suffix();
    let b_prefix = account_b.id().prefix().as_felt();
    let b_suffix = account_b.id().suffix();

    let game_id = Word::from([Felt::new(10), Felt::new(20), Felt::new(30), Felt::new(40)]);
    let a_commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);
    let b_commitment = Word::from([Felt::new(500), Felt::new(600), Felt::new(700), Felt::new(800)]);

    // ── Board setup ──
    println!("[4/5] Setting up boards and handshake...");

    let a_setup_note = create_note_from_package(
        &mut client, pkgs.setup_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: build_setup_inputs(game_id, b_prefix.as_int(), b_suffix.as_int(), a_commitment, &classic_ship_cells()),
            tag: NoteTag::new(1),
            ..Default::default()
        },
    )?;
    let b_setup_note = create_note_from_package(
        &mut client, pkgs.setup_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: build_setup_inputs(game_id, a_prefix.as_int(), a_suffix.as_int(), b_commitment, &classic_ship_cells()),
            tag: NoteTag::new(2),
            ..Default::default()
        },
    )?;

    publish_note(&mut client, sender.id(), a_setup_note.clone()).await?;
    consume_note(&mut client, account_a.id(), a_setup_note).await?;

    publish_note(&mut client, sender.id(), b_setup_note.clone()).await?;
    consume_note(&mut client, account_b.id(), b_setup_note).await?;

    // Challenge: A → B
    let challenge_note = create_note_from_package(
        &mut client, pkgs.challenge_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: vec![
                game_id[0], game_id[1], game_id[2], game_id[3],
                a_prefix, a_suffix,
                a_commitment[0], a_commitment[1], a_commitment[2], a_commitment[3],
            ],
            tag: NoteTag::new(3),
            ..Default::default()
        },
    )?;
    publish_note(&mut client, sender.id(), challenge_note.clone()).await?;
    consume_note(&mut client, account_b.id(), challenge_note).await?;

    // Accept: B → A
    let accept_note = create_note_from_package(
        &mut client, pkgs.accept_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: vec![
                game_id[0], game_id[1], game_id[2], game_id[3],
                b_prefix, b_suffix,
                b_commitment[0], b_commitment[1], b_commitment[2], b_commitment[3],
            ],
            tag: NoteTag::new(4),
            ..Default::default()
        },
    )?;
    publish_note(&mut client, sender.id(), accept_note.clone()).await?;
    consume_note(&mut client, account_a.id(), accept_note).await?;

    println!("  Setup and handshake complete. Both accounts are ACTIVE.");

    // ── Output config for frontend ──
    println!("\n[5/5] Frontend configuration:\n");
    println!("=== COPY TO frontend-template/src/config.ts ===");
    println!("GAME_ACCOUNT_A = \"{}\";", account_a.id().to_bech32(NetworkId::Testnet));
    println!("GAME_ACCOUNT_B = \"{}\";", account_b.id().to_bech32(NetworkId::Testnet));
    println!("RESULT_SCRIPT_ROOT = [{}, {}, {}, {}]n;",
        result_script_root[0].as_int(),
        result_script_root[1].as_int(),
        result_script_root[2].as_int(),
        result_script_root[3].as_int(),
    );

    println!("\n=== DEPLOYMENT COMPLETE ===");
    Ok(())
}
