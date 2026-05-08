use integration::helpers::{
    build_project_in_dir, create_testing_account_from_package, create_testing_note_from_package,
    AccountCreationConfig, NoteCreationConfig,
};

use miden_client::{
    auth::AuthScheme,
    account::{Account, AccountId, StorageSlot, StorageSlotName},
    note::NoteTag,
    transaction::OutputNote,
    Felt, Word,
};
use miden_testing::{Auth, MockChain};
use miden_protocol::transaction::RawOutputNote;
use std::{path::Path, sync::Arc};

// Storage slot names
fn board_row_slot(n: u32) -> StorageSlotName {
    let name = match n {
        0 => "miden_battleship_account::battleship_account::board_row_0",
        1 => "miden_battleship_account::battleship_account::board_row_1",
        2 => "miden_battleship_account::battleship_account::board_row_2",
        3 => "miden_battleship_account::battleship_account::board_row_3",
        4 => "miden_battleship_account::battleship_account::board_row_4",
        5 => "miden_battleship_account::battleship_account::board_row_5",
        6 => "miden_battleship_account::battleship_account::board_row_6",
        7 => "miden_battleship_account::battleship_account::board_row_7",
        8 => "miden_battleship_account::battleship_account::board_row_8",
        9 => "miden_battleship_account::battleship_account::board_row_9",
        _ => panic!("invalid board row"),
    };
    StorageSlotName::new(name).unwrap()
}
fn game_config_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::game_config").unwrap()
}
fn opponent_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::opponent").unwrap()
}
fn board_commitment_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::board_commitment").unwrap()
}
fn opponent_commitment_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::opponent_commitment").unwrap()
}
fn game_id_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::game_id").unwrap()
}
fn reveal_status_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::reveal_status").unwrap()
}

fn all_storage_slots() -> Vec<StorageSlot> {
    let mut slots = vec![
        StorageSlot::with_value(game_config_slot(), Word::default()),
        StorageSlot::with_value(opponent_slot(), Word::default()),
        StorageSlot::with_value(board_commitment_slot(), Word::default()),
        StorageSlot::with_value(opponent_commitment_slot(), Word::default()),
        StorageSlot::with_value(game_id_slot(), Word::default()),
        StorageSlot::with_value(reveal_status_slot(), Word::default()),
    ];
    for i in 0..10u32 {
        slots.push(StorageSlot::with_value(board_row_slot(i), Word::default()));
    }
    slots
}

/// Classic ship placement: 17 cells total
fn classic_ship_cells() -> Vec<(u64, u64, u64)> {
    let mut cells = Vec::new();
    for c in 0..5 { cells.push((0, c, 1)); } // Carrier
    for c in 0..4 { cells.push((1, c, 2)); } // Battleship
    for c in 0..3 { cells.push((2, c, 3)); } // Cruiser
    for c in 0..3 { cells.push((3, c, 4)); } // Submarine
    for c in 0..2 { cells.push((4, c, 5)); } // Destroyer
    cells
}

/// Pack ship cells into 10 row values (3 bits per cell)
fn pack_board(ship_cells: &[(u64, u64, u64)]) -> [u64; 10] {
    let mut rows = [0u64; 10];
    for (r, c, ship_id) in ship_cells {
        let shift = c * 3;
        rows[*r as usize] |= ship_id << shift;
    }
    rows
}

/// Build 20-Felt inputs for setup-note (packed format)
fn build_setup_inputs(
    game_id: Word, opp_prefix: u64, opp_suffix: u64,
    commitment: Word, ship_cells: &[(u64, u64, u64)],
) -> Vec<Felt> {
    let mut inputs = Vec::new();
    for f in game_id.iter() { inputs.push(*f); }
    inputs.push(Felt::new(opp_prefix));
    inputs.push(Felt::new(opp_suffix));
    for f in commitment.iter() { inputs.push(*f); }
    let packed = pack_board(ship_cells);
    for row_val in packed.iter() {
        inputs.push(Felt::new(*row_val));
    }
    inputs
}

/// Read a single cell from the packed board storage
fn read_board_cell(account: &Account, row: u32, col: u32) -> u64 {
    let row_word = account.storage().get_item(&board_row_slot(row)).unwrap();
    let packed = row_word[0].as_canonical_u64();
    (packed >> (col as u64 * 3)) & 0x7
}

struct Packages {
    contract: Arc<miden_mast_package::Package>,
    setup_note: Arc<miden_mast_package::Package>,
    action_note: Arc<miden_mast_package::Package>,
    shot_test_note: Arc<miden_mast_package::Package>,
}

fn build_all_packages() -> anyhow::Result<Packages> {
    Ok(Packages {
        contract: Arc::new(build_project_in_dir(Path::new("../contracts/battleship-account"), true)?),
        setup_note: Arc::new(build_project_in_dir(Path::new("../contracts/setup-note"), true)?),
        action_note: Arc::new(build_project_in_dir(Path::new("../contracts/action-note"), true)?),
        shot_test_note: Arc::new(build_project_in_dir(Path::new("../contracts/shot-test-note"), true)?),
    })
}

async fn create_game_account(pkg: Arc<miden_mast_package::Package>) -> anyhow::Result<Account> {
    let config = AccountCreationConfig {
        storage_slots: all_storage_slots(),
        ..Default::default()
    };
    create_testing_account_from_package(pkg, config).await
}

/// Helper: setup board on an account. Returns the mock_chain with the account ready in CHALLENGED phase.
async fn setup_board_on_account(
    builder: &mut miden_testing::MockChainBuilder,
    account: &mut Account,
    pkgs: &Packages,
    sender_id: AccountId,
    game_id: Word,
    opp_prefix: u64,
    opp_suffix: u64,
    commitment: Word,
) -> anyhow::Result<()> {
    let inputs = build_setup_inputs(game_id, opp_prefix, opp_suffix, commitment, &classic_ship_cells());
    let note = create_testing_note_from_package(
        pkgs.setup_note.clone(), sender_id,
        NoteCreationConfig { inputs, ..Default::default() },
    )?;
    builder.add_output_note(RawOutputNote::Full(note.clone()));
    // We need to build, execute, then return. But the builder is consumed by build().
    // So this helper doesn't work well with the builder pattern.
    // Let's restructure to use a different approach.
    Ok(())
}

/// Execute a note on an account within an already-built mock chain
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

/// Create an action note with the given inputs
fn make_action_note(
    pkg: &Arc<miden_mast_package::Package>,
    sender_id: AccountId,
    inputs: Vec<Felt>,
    serial_seed: u64,
) -> anyhow::Result<miden_client::note::Note> {
    // Use different tags to ensure unique note IDs
    create_testing_note_from_package(
        pkg.clone(), sender_id,
        NoteCreationConfig {
            inputs,
            tag: NoteTag::new(serial_seed as u32),
            ..Default::default()
        },
    )
}

// ============================================================================
// Task 1A Tests
// ============================================================================

#[tokio::test]
async fn test_create_account_with_battleship_component() -> anyhow::Result<()> {
    let pkg = Arc::new(build_project_in_dir(Path::new("../contracts/battleship-account"), true)?);
    let account = create_game_account(pkg).await?;

    let config = account.storage().get_item(&game_config_slot()).expect("game_config not found");
    assert_eq!(config, Word::default(), "Initial game_config should be all zeros");

    println!("test_create_account passed!");
    Ok(())
}

#[tokio::test]
async fn test_full_board_setup() -> anyhow::Result<()> {
    let pkgs = build_all_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth { auth_scheme: AuthScheme::Falcon512Poseidon2 })?;
    let mut account = create_game_account(pkgs.contract.clone()).await?;

    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);

    let inputs = build_setup_inputs(game_id, 42, 43, commitment, &classic_ship_cells());
    let setup_note = create_testing_note_from_package(
        pkgs.setup_note.clone(), sender.id(),
        NoteCreationConfig { inputs, ..Default::default() },
    )?;

    builder.add_account(account.clone())?;
    builder.add_output_note(RawOutputNote::Full(setup_note.clone()));
    let mut mock_chain = builder.build()?;

    execute_note_on_account(&mut mock_chain, &mut account, setup_note).await?;

    // Verify phase is CHALLENGED (1)
    let config = account.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[2], Felt::new(1), "Phase should be CHALLENGED");

    // Verify game_id
    let stored_gid = account.storage().get_item(&game_id_slot()).unwrap();
    assert_eq!(stored_gid, game_id);

    // Verify commitment
    let stored_commit = account.storage().get_item(&board_commitment_slot()).unwrap();
    assert_eq!(stored_commit, commitment);

    // Verify opponent
    let stored_opp = account.storage().get_item(&opponent_slot()).unwrap();
    assert_eq!(stored_opp[0], Felt::new(42));
    assert_eq!(stored_opp[1], Felt::new(43));

    // Verify ship cell (0,0) = ship_id 1
    assert_eq!(read_board_cell(&account, 0, 0), 1, "Cell (0,0) should be ship 1");

    // Verify water cell (5,5) = 0
    assert_eq!(read_board_cell(&account, 5, 5), 0, "Unoccupied cell should be water (0)");

    println!("test_full_board_setup passed!");
    Ok(())
}

#[tokio::test]
async fn test_accept_challenge_flow() -> anyhow::Result<()> {
    let pkgs = build_all_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth { auth_scheme: AuthScheme::Falcon512Poseidon2 })?;
    let mut account = create_game_account(pkgs.contract.clone()).await?;

    let game_id = Word::from([Felt::new(10), Felt::new(20), Felt::new(30), Felt::new(40)]);
    let commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);
    let opp_commitment = Word::from([Felt::new(500), Felt::new(600), Felt::new(700), Felt::new(800)]);

    // Setup note for board placement
    let setup_inputs = build_setup_inputs(game_id, 42, 43, commitment, &classic_ship_cells());
    let setup_note = create_testing_note_from_package(
        pkgs.setup_note.clone(), sender.id(),
        NoteCreationConfig { inputs: setup_inputs, ..Default::default() },
    )?;

    // Action note to accept challenge
    // Action 2: [2, gid0..3, opp_prefix, opp_suffix, commit0..3]
    let accept_inputs = vec![
        Felt::new(2), // action = accept_challenge
        Felt::new(10), Felt::new(20), Felt::new(30), Felt::new(40), // game_id
        Felt::new(42), Felt::new(43), // opponent (must match what was stored in setup)
        Felt::new(500), Felt::new(600), Felt::new(700), Felt::new(800), // opponent commitment
    ];
    let accept_note = make_action_note(&pkgs.action_note, sender.id(), accept_inputs, 1)?;

    builder.add_account(account.clone())?;
    builder.add_output_note(RawOutputNote::Full(setup_note.clone()));
    builder.add_output_note(RawOutputNote::Full(accept_note.clone()));
    let mut mock_chain = builder.build()?;

    // Step 1: Setup board -> CHALLENGED
    execute_note_on_account(&mut mock_chain, &mut account, setup_note).await?;
    let config = account.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[2], Felt::new(1), "Should be CHALLENGED after setup");

    // Step 2: Accept challenge -> ACTIVE
    execute_note_on_account(&mut mock_chain, &mut account, accept_note).await?;
    let config = account.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[2], Felt::new(2), "Should be ACTIVE after accept");
    assert_eq!(config[3], Felt::new(1), "Expected turn should be 1");

    // Verify opponent commitment stored
    let stored_opp_commit = account.storage().get_item(&opponent_commitment_slot()).unwrap();
    assert_eq!(stored_opp_commit, opp_commitment);

    println!("test_accept_challenge_flow passed!");
    Ok(())
}

// ============================================================================
// Task 1B Tests: process_shot + enter_reveal
// ============================================================================

/// Helper: create an account that's in ACTIVE phase (board set up + challenge accepted)
async fn create_active_account(
    pkgs: &Packages,
    builder: &mut miden_testing::MockChainBuilder,
    sender_id: AccountId,
    game_id: Word,
    opp_prefix: u64,
    opp_suffix: u64,
    note_tag_base: u32,
) -> anyhow::Result<(Account, Vec<miden_client::note::Note>)> {
    let mut account = create_game_account(pkgs.contract.clone()).await?;
    let commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);
    let opp_commitment = Word::from([Felt::new(500), Felt::new(600), Felt::new(700), Felt::new(800)]);

    let setup_inputs = build_setup_inputs(game_id, opp_prefix, opp_suffix, commitment, &classic_ship_cells());
    let setup_note = create_testing_note_from_package(
        pkgs.setup_note.clone(), sender_id,
        NoteCreationConfig {
            inputs: setup_inputs,
            tag: NoteTag::new(note_tag_base),
            ..Default::default()
        },
    )?;

    let accept_inputs = vec![
        Felt::new(2),
        game_id[0], game_id[1], game_id[2], game_id[3],
        Felt::new(opp_prefix), Felt::new(opp_suffix),
        opp_commitment[0], opp_commitment[1], opp_commitment[2], opp_commitment[3],
    ];
    let accept_note = make_action_note(&pkgs.action_note, sender_id, accept_inputs, (note_tag_base + 1) as u64)?;

    builder.add_account(account.clone())?;
    builder.add_output_note(RawOutputNote::Full(setup_note.clone()));
    builder.add_output_note(RawOutputNote::Full(accept_note.clone()));

    Ok((account, vec![setup_note, accept_note]))
}

#[tokio::test]
async fn test_process_shot_miss() -> anyhow::Result<()> {
    let pkgs = build_all_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth { auth_scheme: AuthScheme::Falcon512Poseidon2 })?;

    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let (mut account, setup_notes) = create_active_account(
        &pkgs, &mut builder, sender.id(), game_id, 42, 43, 100,
    ).await?;

    // Use dedicated shot-test-note: inputs = [row, col, turn]
    let shot_inputs = vec![Felt::new(5), Felt::new(5), Felt::new(1)];
    let shot_note = create_testing_note_from_package(
        pkgs.shot_test_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: shot_inputs,
            tag: NoteTag::new(200),
            ..Default::default()
        },
    )?;
    builder.add_output_note(RawOutputNote::Full(shot_note.clone()));

    let mut mock_chain = builder.build()?;

    // Setup + accept
    for note in setup_notes {
        execute_note_on_account(&mut mock_chain, &mut account, note).await?;
    }

    // Verify ACTIVE phase
    let config = account.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[2], Felt::new(2), "Should be ACTIVE");

    // Fire shot
    execute_note_on_account(&mut mock_chain, &mut account, shot_note).await?;

    // Check cell (5,5) is now MISS (7)
    assert_eq!(read_board_cell(&account, 5, 5), 7, "Cell should be MISS (7)");

    // Check total_shots_received incremented
    let opp = account.storage().get_item(&opponent_slot()).unwrap();
    assert_eq!(opp[3], Felt::new(1), "total_shots_received should be 1");
    assert_eq!(opp[2], Felt::new(0), "ships_hit_count should still be 0");

    // Expected turn should advance by 2 (1 -> 3)
    let config = account.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[3], Felt::new(3), "expected_turn should be 3");

    println!("test_process_shot_miss passed!");
    Ok(())
}

#[tokio::test]
async fn test_process_shot_hit() -> anyhow::Result<()> {
    let pkgs = build_all_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth { auth_scheme: AuthScheme::Falcon512Poseidon2 })?;

    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let (mut account, setup_notes) = create_active_account(
        &pkgs, &mut builder, sender.id(), game_id, 42, 43, 100,
    ).await?;

    // Shot at (0,0) which has ship_id=1 (Carrier), turn=1
    // Use dedicated shot-test-note: inputs = [row, col, turn]
    let shot_inputs = vec![Felt::new(0), Felt::new(0), Felt::new(1)];
    let shot_note = create_testing_note_from_package(
        pkgs.shot_test_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: shot_inputs,
            tag: NoteTag::new(200),
            ..Default::default()
        },
    )?;
    builder.add_output_note(RawOutputNote::Full(shot_note.clone()));

    let mut mock_chain = builder.build()?;

    for note in setup_notes {
        execute_note_on_account(&mut mock_chain, &mut account, note).await?;
    }

    execute_note_on_account(&mut mock_chain, &mut account, shot_note).await?;

    // Check cell (0,0) is now HIT (6)
    assert_eq!(read_board_cell(&account, 0, 0), 6, "Cell should be HIT (6)");

    // ships_hit_count should be 1
    let opp = account.storage().get_item(&opponent_slot()).unwrap();
    assert_eq!(opp[2], Felt::new(1), "ships_hit_count should be 1");
    assert_eq!(opp[3], Felt::new(1), "total_shots_received should be 1");

    println!("test_process_shot_hit passed!");
    Ok(())
}

#[tokio::test]
async fn test_enter_reveal() -> anyhow::Result<()> {
    let pkgs = build_all_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth { auth_scheme: AuthScheme::Falcon512Poseidon2 })?;

    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let (mut account, setup_notes) = create_active_account(
        &pkgs, &mut builder, sender.id(), game_id, 42, 43, 100,
    ).await?;

    // enter_reveal action
    let reveal_inputs = vec![Felt::new(4)]; // action 4
    let reveal_note = make_action_note(&pkgs.action_note, sender.id(), reveal_inputs, 200)?;
    builder.add_output_note(RawOutputNote::Full(reveal_note.clone()));

    let mut mock_chain = builder.build()?;

    for note in setup_notes {
        execute_note_on_account(&mut mock_chain, &mut account, note).await?;
    }

    // Should be ACTIVE
    let config = account.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[2], Felt::new(2));

    // Enter reveal
    execute_note_on_account(&mut mock_chain, &mut account, reveal_note).await?;

    // Should be REVEAL (3)
    let config = account.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[2], Felt::new(3), "Phase should be REVEAL");

    println!("test_enter_reveal passed!");
    Ok(())
}

#[tokio::test]
async fn test_mark_reveal_and_verify_complete() -> anyhow::Result<()> {
    let pkgs = build_all_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth { auth_scheme: AuthScheme::Falcon512Poseidon2 })?;

    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let (mut account, setup_notes) = create_active_account(
        &pkgs, &mut builder, sender.id(), game_id, 42, 43, 100,
    ).await?;

    // enter_reveal, mark_my_reveal, verify_opponent_reveal
    let enter_reveal = make_action_note(&pkgs.action_note, sender.id(), vec![Felt::new(4)], 200)?;
    let mark_reveal = make_action_note(&pkgs.action_note, sender.id(), vec![Felt::new(5)], 201)?;

    // verify_opponent_reveal with opponent commitment (matches what was stored in accept_challenge)
    let opp_commitment = Word::from([Felt::new(500), Felt::new(600), Felt::new(700), Felt::new(800)]);
    let verify_inputs = vec![
        Felt::new(6), opp_commitment[0], opp_commitment[1], opp_commitment[2], opp_commitment[3],
    ];
    let verify_note = make_action_note(&pkgs.action_note, sender.id(), verify_inputs, 202)?;

    builder.add_output_note(RawOutputNote::Full(enter_reveal.clone()));
    builder.add_output_note(RawOutputNote::Full(mark_reveal.clone()));
    builder.add_output_note(RawOutputNote::Full(verify_note.clone()));

    let mut mock_chain = builder.build()?;

    // Setup + accept -> ACTIVE
    for note in setup_notes {
        execute_note_on_account(&mut mock_chain, &mut account, note).await?;
    }

    // Enter reveal -> REVEAL
    execute_note_on_account(&mut mock_chain, &mut account, enter_reveal).await?;
    assert_eq!(account.storage().get_item(&game_config_slot()).unwrap()[2], Felt::new(3));

    // Mark my reveal
    execute_note_on_account(&mut mock_chain, &mut account, mark_reveal).await?;
    let status = account.storage().get_item(&reveal_status_slot()).unwrap();
    assert_eq!(status[0], Felt::new(1), "my_revealed should be 1");

    // Verify opponent -> should transition to COMPLETE
    execute_note_on_account(&mut mock_chain, &mut account, verify_note).await?;
    let status = account.storage().get_item(&reveal_status_slot()).unwrap();
    assert_eq!(status[1], Felt::new(1), "opponent_verified should be 1");

    let config = account.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[2], Felt::new(4), "Phase should be COMPLETE (4)");

    println!("test_mark_reveal_and_verify_complete passed!");
    Ok(())
}

