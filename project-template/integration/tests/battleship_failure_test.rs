use integration::helpers::{
    account_component_from_package, build_project_in_dir, create_testing_note_from_package,
    AccountCreationConfig, NoteCreationConfig,
};

use miden_client::{
    account::{
        component::NoAuth, Account, AccountBuilder, StorageMap, StorageSlot, StorageSlotName,
    },
    note::{NoteTag, NoteType},
    transaction::OutputNote,
    Felt, Word,
};
use miden_testing::{Auth, MockChain};
use std::{path::Path, sync::Arc};

// ============================================================================
// Shared helpers
// ============================================================================

fn board_slot() -> StorageSlotName {
    StorageSlotName::new("miden::component::miden_battleship_account::my_board").unwrap()
}
fn game_config_slot() -> StorageSlotName {
    StorageSlotName::new("miden::component::miden_battleship_account::game_config").unwrap()
}
fn opponent_slot() -> StorageSlotName {
    StorageSlotName::new("miden::component::miden_battleship_account::opponent").unwrap()
}
fn board_commitment_slot() -> StorageSlotName {
    StorageSlotName::new("miden::component::miden_battleship_account::board_commitment").unwrap()
}
fn opponent_commitment_slot() -> StorageSlotName {
    StorageSlotName::new("miden::component::miden_battleship_account::opponent_commitment").unwrap()
}
fn game_id_slot() -> StorageSlotName {
    StorageSlotName::new("miden::component::miden_battleship_account::game_id").unwrap()
}
fn reveal_status_slot() -> StorageSlotName {
    StorageSlotName::new("miden::component::miden_battleship_account::reveal_status").unwrap()
}

fn all_storage_slots() -> Vec<StorageSlot> {
    vec![
        StorageSlot::with_value(game_config_slot(), Word::default()),
        StorageSlot::with_value(opponent_slot(), Word::default()),
        StorageSlot::with_value(board_commitment_slot(), Word::default()),
        StorageSlot::with_value(opponent_commitment_slot(), Word::default()),
        StorageSlot::with_value(game_id_slot(), Word::default()),
        StorageSlot::with_value(reveal_status_slot(), Word::default()),
        StorageSlot::with_map(board_slot(), StorageMap::with_entries([]).unwrap()),
    ]
}

fn classic_ship_cells() -> Vec<(u64, u64, u64)> {
    let mut cells = Vec::new();
    for c in 0..5 { cells.push((0, c, 1)); }
    for c in 0..4 { cells.push((1, c, 2)); }
    for c in 0..3 { cells.push((2, c, 3)); }
    for c in 0..3 { cells.push((3, c, 4)); }
    for c in 0..2 { cells.push((4, c, 5)); }
    cells
}

fn build_setup_inputs(
    game_id: Word, opp_prefix: u64, opp_suffix: u64,
    commitment: Word, ship_cells: &[(u64, u64, u64)],
) -> Vec<Felt> {
    let mut inputs = Vec::new();
    for f in game_id.iter() { inputs.push(*f); }
    inputs.push(Felt::new(opp_prefix));
    inputs.push(Felt::new(opp_suffix));
    for f in commitment.iter() { inputs.push(*f); }
    for (r, c, s) in ship_cells {
        inputs.push(Felt::new(*r));
        inputs.push(Felt::new(*c));
        inputs.push(Felt::new(*s));
    }
    inputs
}

struct Packages {
    contract: Arc<miden_mast_package::Package>,
    setup_note: Arc<miden_mast_package::Package>,
    action_note: Arc<miden_mast_package::Package>,
    shot_test_note: Arc<miden_mast_package::Package>,
}

fn build_packages() -> anyhow::Result<Packages> {
    Ok(Packages {
        contract: Arc::new(build_project_in_dir(Path::new("../contracts/battleship-account"), true)?),
        setup_note: Arc::new(build_project_in_dir(Path::new("../contracts/setup-note"), true)?),
        action_note: Arc::new(build_project_in_dir(Path::new("../contracts/action-note"), true)?),
        shot_test_note: Arc::new(build_project_in_dir(Path::new("../contracts/shot-test-note"), true)?),
    })
}

async fn create_game_account_with_seed(
    pkg: Arc<miden_mast_package::Package>,
    seed: [u8; 32],
) -> anyhow::Result<Account> {
    let config = AccountCreationConfig {
        storage_slots: all_storage_slots(),
        ..Default::default()
    };
    let component = account_component_from_package(pkg, &config)?;
    let account = AccountBuilder::new(seed)
        .account_type(config.account_type)
        .storage_mode(config.storage_mode)
        .with_component(component)
        .with_auth_component(NoAuth)
        .build_existing()?;
    Ok(account)
}

async fn execute_note_on_account(
    mock_chain: &mut MockChain,
    account: &mut Account,
    note: miden_client::note::Note,
) -> anyhow::Result<()> {
    let tx_context = mock_chain
        .build_tx_context(account.id(), &[note.id()], &[])?
        .build()?;
    let executed = tx_context.execute().await?;
    account.apply_delta(executed.account_delta())?;
    mock_chain.add_pending_executed_transaction(&executed)?;
    mock_chain.prove_next_block()?;
    Ok(())
}

fn make_action_note(
    pkg: &Arc<miden_mast_package::Package>,
    sender_id: miden_client::account::AccountId,
    inputs: Vec<Felt>,
    tag_val: u32,
) -> anyhow::Result<miden_client::note::Note> {
    create_testing_note_from_package(
        pkg.clone(), sender_id,
        NoteCreationConfig {
            inputs,
            tag: NoteTag::new(tag_val),
            ..Default::default()
        },
    )
}

/// Create an ACTIVE account ready for shot processing.
/// Returns (account, notes_to_execute) where notes_to_execute are setup + accept.
async fn create_active_account(
    pkgs: &Packages,
    builder: &mut miden_testing::MockChainBuilder,
    sender_id: miden_client::account::AccountId,
    seed: [u8; 32],
    tag_base: u32,
) -> anyhow::Result<(Account, Vec<miden_client::note::Note>)> {
    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);
    let opp_commitment = Word::from([Felt::new(500), Felt::new(600), Felt::new(700), Felt::new(800)]);

    let account = create_game_account_with_seed(pkgs.contract.clone(), seed).await?;

    let setup_inputs = build_setup_inputs(game_id, 42, 43, commitment, &classic_ship_cells());
    let setup_note = create_testing_note_from_package(
        pkgs.setup_note.clone(), sender_id,
        NoteCreationConfig { inputs: setup_inputs, tag: NoteTag::new(tag_base), ..Default::default() },
    )?;

    let accept_inputs = vec![
        Felt::new(2), // action: accept_challenge
        game_id[0], game_id[1], game_id[2], game_id[3],
        Felt::new(42), Felt::new(43),
        opp_commitment[0], opp_commitment[1], opp_commitment[2], opp_commitment[3],
    ];
    let accept_note = make_action_note(&pkgs.action_note, sender_id, accept_inputs, tag_base + 1)?;

    builder.add_account(account.clone())?;
    builder.add_output_note(OutputNote::Full(setup_note.clone()));
    builder.add_output_note(OutputNote::Full(accept_note.clone()));

    Ok((account, vec![setup_note, accept_note]))
}

/// Helper to make an account ACTIVE and ready for shots.
async fn setup_active_account(
    mock_chain: &mut MockChain,
    account: &mut Account,
    notes: Vec<miden_client::note::Note>,
) -> anyhow::Result<()> {
    for note in notes {
        execute_note_on_account(mock_chain, account, note).await?;
    }
    Ok(())
}

// ============================================================================
// Task 1K: Wrong turn number → rejected
// ============================================================================

#[tokio::test]
async fn test_wrong_turn_number_rejected() -> anyhow::Result<()> {
    let pkgs = build_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth)?;

    let (mut account, setup_notes) = create_active_account(
        &pkgs, &mut builder, sender.id(), [1u8; 32], 100,
    ).await?;

    // Shot with wrong turn: expected is 1, send turn=5
    let shot_note = create_testing_note_from_package(
        pkgs.shot_test_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: vec![Felt::new(0), Felt::new(0), Felt::new(5)], // row=0, col=0, turn=5 (WRONG)
            tag: NoteTag::new(200),
            ..Default::default()
        },
    )?;
    builder.add_output_note(OutputNote::Full(shot_note.clone()));
    let mut mock_chain = builder.build()?;

    setup_active_account(&mut mock_chain, &mut account, setup_notes).await?;

    let result = execute_note_on_account(&mut mock_chain, &mut account, shot_note).await;
    assert!(result.is_err(), "Shot with wrong turn should fail");

    println!("test_wrong_turn_number_rejected PASSED!");
    Ok(())
}

// ============================================================================
// Task 1L: Same cell shot twice → rejected
// ============================================================================

#[tokio::test]
async fn test_duplicate_cell_rejected() -> anyhow::Result<()> {
    let pkgs = build_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth)?;

    let (mut account, setup_notes) = create_active_account(
        &pkgs, &mut builder, sender.id(), [1u8; 32], 100,
    ).await?;

    // First shot at (5,5) turn=1 → miss
    let shot1 = create_testing_note_from_package(
        pkgs.shot_test_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: vec![Felt::new(5), Felt::new(5), Felt::new(1)],
            tag: NoteTag::new(200),
            ..Default::default()
        },
    )?;
    // Second shot at same cell (5,5) turn=3
    let shot2 = create_testing_note_from_package(
        pkgs.shot_test_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: vec![Felt::new(5), Felt::new(5), Felt::new(3)],
            tag: NoteTag::new(201),
            ..Default::default()
        },
    )?;
    builder.add_output_note(OutputNote::Full(shot1.clone()));
    builder.add_output_note(OutputNote::Full(shot2.clone()));
    let mut mock_chain = builder.build()?;

    setup_active_account(&mut mock_chain, &mut account, setup_notes).await?;

    // First shot succeeds
    execute_note_on_account(&mut mock_chain, &mut account, shot1).await?;

    // Second shot at same cell should fail
    let result = execute_note_on_account(&mut mock_chain, &mut account, shot2).await;
    assert!(result.is_err(), "Duplicate cell shot should fail");

    println!("test_duplicate_cell_rejected PASSED!");
    Ok(())
}

// ============================================================================
// Task 1M: Shot during wrong phase → rejected
// ============================================================================

#[tokio::test]
async fn test_shot_wrong_phase_rejected() -> anyhow::Result<()> {
    let pkgs = build_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth)?;

    // Account in CHALLENGED phase (not ACTIVE)
    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);
    let mut account = create_game_account_with_seed(pkgs.contract.clone(), [1u8; 32]).await?;

    let setup_inputs = build_setup_inputs(game_id, 42, 43, commitment, &classic_ship_cells());
    let setup_note = create_testing_note_from_package(
        pkgs.setup_note.clone(), sender.id(),
        NoteCreationConfig { inputs: setup_inputs, tag: NoteTag::new(100), ..Default::default() },
    )?;

    // Shot note during CHALLENGED phase
    let shot_note = create_testing_note_from_package(
        pkgs.shot_test_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: vec![Felt::new(0), Felt::new(0), Felt::new(1)],
            tag: NoteTag::new(200),
            ..Default::default()
        },
    )?;

    builder.add_account(account.clone())?;
    builder.add_output_note(OutputNote::Full(setup_note.clone()));
    builder.add_output_note(OutputNote::Full(shot_note.clone()));
    let mut mock_chain = builder.build()?;

    // Setup board → CHALLENGED
    execute_note_on_account(&mut mock_chain, &mut account, setup_note).await?;
    assert_eq!(account.storage().get_item(&game_config_slot()).unwrap()[2], Felt::new(1));

    // Shot during CHALLENGED should fail
    let result = execute_note_on_account(&mut mock_chain, &mut account, shot_note).await;
    assert!(result.is_err(), "Shot during CHALLENGED phase should fail");

    println!("test_shot_wrong_phase_rejected PASSED!");
    Ok(())
}

// ============================================================================
// Task 1M (cont): Enter reveal during wrong phase → rejected
// ============================================================================

#[tokio::test]
async fn test_enter_reveal_wrong_phase_rejected() -> anyhow::Result<()> {
    let pkgs = build_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth)?;

    // Account in CHALLENGED phase
    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);
    let mut account = create_game_account_with_seed(pkgs.contract.clone(), [1u8; 32]).await?;

    let setup_inputs = build_setup_inputs(game_id, 42, 43, commitment, &classic_ship_cells());
    let setup_note = create_testing_note_from_package(
        pkgs.setup_note.clone(), sender.id(),
        NoteCreationConfig { inputs: setup_inputs, tag: NoteTag::new(100), ..Default::default() },
    )?;

    let enter_reveal = make_action_note(&pkgs.action_note, sender.id(), vec![Felt::new(4)], 200)?;

    builder.add_account(account.clone())?;
    builder.add_output_note(OutputNote::Full(setup_note.clone()));
    builder.add_output_note(OutputNote::Full(enter_reveal.clone()));
    let mut mock_chain = builder.build()?;

    execute_note_on_account(&mut mock_chain, &mut account, setup_note).await?;

    // Enter reveal during CHALLENGED should fail
    let result = execute_note_on_account(&mut mock_chain, &mut account, enter_reveal).await;
    assert!(result.is_err(), "enter_reveal during CHALLENGED should fail");

    println!("test_enter_reveal_wrong_phase_rejected PASSED!");
    Ok(())
}

// ============================================================================
// Task 1N (partial): Wrong commitment in reveal → rejected
// ============================================================================

#[tokio::test]
async fn test_wrong_commitment_reveal_rejected() -> anyhow::Result<()> {
    let pkgs = build_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth)?;

    let (mut account, setup_notes) = create_active_account(
        &pkgs, &mut builder, sender.id(), [1u8; 32], 100,
    ).await?;

    // Enter reveal
    let enter_reveal = make_action_note(&pkgs.action_note, sender.id(), vec![Felt::new(4), Felt::new(1)], 200)?;

    // Reveal note with WRONG commitment (stored is [500,600,700,800])
    let wrong_commitment = Word::from([Felt::new(999), Felt::new(998), Felt::new(997), Felt::new(996)]);
    let reveal_note = create_testing_note_from_package(
        pkgs.action_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: vec![Felt::new(6), wrong_commitment[0], wrong_commitment[1], wrong_commitment[2], wrong_commitment[3]],
            tag: NoteTag::new(201),
            ..Default::default()
        },
    )?;

    builder.add_output_note(OutputNote::Full(enter_reveal.clone()));
    builder.add_output_note(OutputNote::Full(reveal_note.clone()));
    let mut mock_chain = builder.build()?;

    setup_active_account(&mut mock_chain, &mut account, setup_notes).await?;
    execute_note_on_account(&mut mock_chain, &mut account, enter_reveal).await?;

    // Wrong commitment should fail
    let result = execute_note_on_account(&mut mock_chain, &mut account, reveal_note).await;
    assert!(result.is_err(), "Wrong commitment reveal should fail");

    println!("test_wrong_commitment_reveal_rejected PASSED!");
    Ok(())
}
