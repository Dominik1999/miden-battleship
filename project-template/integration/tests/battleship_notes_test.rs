use integration::helpers::{
    account_component_from_package, build_project_in_dir, create_testing_account_from_package,
    create_testing_note_from_package, AccountCreationConfig, NoteCreationConfig,
};

use miden_client::{
    account::{
        component::NoAuth, Account, AccountBuilder, AccountId, StorageMap, StorageSlot,
        StorageSlotName,
    },
    note::{Note, NoteInputs, NoteMetadata, NoteRecipient, NoteScript, NoteTag, NoteType},
    transaction::OutputNote,
    Felt, Word,
};
use miden_testing::{Auth, MockChain};
use std::{path::Path, sync::Arc};

// ============================================================================
// Shared helpers (same as unit test — could be extracted to a shared module)
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

async fn create_game_account(pkg: Arc<miden_mast_package::Package>) -> anyhow::Result<Account> {
    create_game_account_with_seed(pkg, [3u8; 32]).await
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
    sender_id: AccountId,
    inputs: Vec<Felt>,
    serial_seed: u64,
) -> anyhow::Result<miden_client::note::Note> {
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
// Package building
// ============================================================================

struct NotePackages {
    contract: Arc<miden_mast_package::Package>,
    setup_note: Arc<miden_mast_package::Package>,
    action_note: Arc<miden_mast_package::Package>,
    shot_note: Arc<miden_mast_package::Package>,
    result_note: Arc<miden_mast_package::Package>,
    challenge_note: Arc<miden_mast_package::Package>,
    accept_note: Arc<miden_mast_package::Package>,
    reveal_note: Arc<miden_mast_package::Package>,
}

fn build_note_packages() -> anyhow::Result<NotePackages> {
    Ok(NotePackages {
        contract: Arc::new(build_project_in_dir(Path::new("../contracts/battleship-account"), true)?),
        setup_note: Arc::new(build_project_in_dir(Path::new("../contracts/setup-note"), true)?),
        action_note: Arc::new(build_project_in_dir(Path::new("../contracts/action-note"), true)?),
        shot_note: Arc::new(build_project_in_dir(Path::new("../contracts/shot-note"), true)?),
        result_note: Arc::new(build_project_in_dir(Path::new("../contracts/result-note"), true)?),
        challenge_note: Arc::new(build_project_in_dir(Path::new("../contracts/challenge-note"), true)?),
        accept_note: Arc::new(build_project_in_dir(Path::new("../contracts/accept-note"), true)?),
        reveal_note: Arc::new(build_project_in_dir(Path::new("../contracts/reveal-note"), true)?),
    })
}

/// Get the MAST root (script root) of a compiled note package
fn get_note_script_root(pkg: &miden_mast_package::Package) -> Word {
    let program = pkg.unwrap_program();
    let script = NoteScript::from_parts(
        program.mast_forest().clone(),
        program.entrypoint(),
    );
    script.root()
}

/// Helper: create an ACTIVE account (board set up + challenge accepted)
async fn create_active_account(
    pkgs: &NotePackages,
    builder: &mut miden_testing::MockChainBuilder,
    sender_id: AccountId,
    game_id: Word,
    opp_prefix: u64,
    opp_suffix: u64,
    note_tag_base: u32,
) -> anyhow::Result<(Account, Vec<miden_client::note::Note>)> {
    let account = create_game_account(pkgs.contract.clone()).await?;
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
    builder.add_output_note(OutputNote::Full(setup_note.clone()));
    builder.add_output_note(OutputNote::Full(accept_note.clone()));

    Ok((account, vec![setup_note, accept_note]))
}

/// Construct the expected result-note that the shot-note will create.
/// This must match exactly what the shot-note's output_note::create produces.
fn build_expected_result_note(
    result_note_pkg: &miden_mast_package::Package,
    serial_num: Word,
    sender_id: AccountId,  // the defender's account (executing the tx)
    shooter_prefix: Felt,
    shooter_suffix: Felt,
    turn: Felt,
    encoded_result: Felt,
    tag: NoteTag,
) -> anyhow::Result<Note> {
    let program = result_note_pkg.unwrap_program();
    let script = NoteScript::from_parts(
        program.mast_forest().clone(),
        program.entrypoint(),
    );

    let inputs = NoteInputs::new(vec![shooter_prefix, shooter_suffix, turn, encoded_result])?;
    let recipient = NoteRecipient::new(serial_num, script, inputs);
    let metadata = NoteMetadata::new(sender_id, NoteType::Public, tag);

    Ok(Note::new(Default::default(), metadata, recipient))
}

// ============================================================================
// Task 1C Tests: shot-note creates result-note (KEY RISK GATE)
// ============================================================================

/// Core test: shot-note calls process_shot and creates result-note as output.
/// This validates the note-creates-note pattern.
#[tokio::test]
async fn test_shot_note_creates_result_note() -> anyhow::Result<()> {
    let pkgs = build_note_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth)?;

    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let (mut account, setup_notes) = create_active_account(
        &pkgs, &mut builder, sender.id(), game_id, 42, 43, 100,
    ).await?;

    // Get the result-note's script root for the shot-note inputs
    let result_script_root = get_note_script_root(&pkgs.result_note);

    // Shot-note inputs: [row, col, turn, serial0..3, script_root0..3, shooter_prefix, shooter_suffix, shooter_tag]
    let result_serial = Word::from([Felt::new(99), Felt::new(98), Felt::new(97), Felt::new(96)]);
    let shooter_tag = Felt::new(500);

    let shot_inputs = vec![
        Felt::new(5), Felt::new(5), Felt::new(1),    // row=5, col=5, turn=1 (miss on water)
        result_serial[0], result_serial[1], result_serial[2], result_serial[3],
        result_script_root[0], result_script_root[1], result_script_root[2], result_script_root[3],
        Felt::new(77), Felt::new(78),                 // shooter_prefix, shooter_suffix
        shooter_tag,                                   // shooter_tag
    ];

    let shot_note = create_testing_note_from_package(
        pkgs.shot_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: shot_inputs,
            tag: NoteTag::new(200),
            ..Default::default()
        },
    )?;
    builder.add_output_note(OutputNote::Full(shot_note.clone()));

    let mut mock_chain = builder.build()?;

    // Setup + accept -> ACTIVE
    for note in setup_notes {
        execute_note_on_account(&mut mock_chain, &mut account, note).await?;
    }

    // Verify ACTIVE phase
    let config = account.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[2], Felt::new(2), "Should be ACTIVE");

    // Pre-construct the expected result-note for the advice provider.
    // Shot at (5,5) water -> encoded_result = 0 (miss, no game_over)
    let expected_result = build_expected_result_note(
        &pkgs.result_note,
        result_serial,
        account.id(),
        Felt::new(77), Felt::new(78),  // shooter_prefix, shooter_suffix
        Felt::new(1),                   // turn
        Felt::new(0),                   // encoded_result: miss=0
        NoteTag::new(500),
    )?;

    // Execute shot-note (this should call process_shot AND create a result-note)
    let tx_context = mock_chain
        .build_tx_context(account.id(), &[shot_note.id()], &[])?
        .extend_expected_output_notes(vec![OutputNote::Full(expected_result)])
        .build()?;
    let executed = tx_context.execute().await?;

    // KEY CHECK: the transaction should have created an output note (the result-note)
    let num_output = executed.output_notes().num_notes();
    assert!(num_output >= 1, "Shot-note should create at least 1 output note (result-note), got {}", num_output);

    println!("Output notes created: {}", num_output);

    // Apply delta and prove
    account.apply_delta(executed.account_delta())?;
    mock_chain.add_pending_executed_transaction(&executed)?;
    mock_chain.prove_next_block()?;

    // Verify board state was updated (process_shot ran)
    let cell_key = Word::from([Felt::new(0), Felt::new(0), Felt::new(5), Felt::new(5)]);
    let cell = account.storage().get_map_item(&board_slot(), cell_key).unwrap();
    assert_eq!(cell[3], Felt::new(7), "Cell (5,5) should be MISS (7)");

    // Verify turn advanced
    let config = account.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[3], Felt::new(3), "expected_turn should advance to 3");

    println!("test_shot_note_creates_result_note PASSED — note-creates-note validated!");
    Ok(())
}

/// Test that shot-note correctly handles a HIT and creates output note
#[tokio::test]
async fn test_shot_note_hit_creates_result_note() -> anyhow::Result<()> {
    let pkgs = build_note_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth)?;

    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let (mut account, setup_notes) = create_active_account(
        &pkgs, &mut builder, sender.id(), game_id, 42, 43, 100,
    ).await?;

    let result_script_root = get_note_script_root(&pkgs.result_note);
    let result_serial = Word::from([Felt::new(50), Felt::new(51), Felt::new(52), Felt::new(53)]);

    // Shot at (0,0) which has ship_id=1 (Carrier) -> HIT
    let shot_inputs = vec![
        Felt::new(0), Felt::new(0), Felt::new(1),    // row=0, col=0, turn=1
        result_serial[0], result_serial[1], result_serial[2], result_serial[3],
        result_script_root[0], result_script_root[1], result_script_root[2], result_script_root[3],
        Felt::new(77), Felt::new(78),
        Felt::new(500),
    ];

    let shot_note = create_testing_note_from_package(
        pkgs.shot_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: shot_inputs,
            tag: NoteTag::new(200),
            ..Default::default()
        },
    )?;
    builder.add_output_note(OutputNote::Full(shot_note.clone()));

    let mut mock_chain = builder.build()?;

    for note in setup_notes {
        execute_note_on_account(&mut mock_chain, &mut account, note).await?;
    }

    // Pre-construct expected result-note. Shot at (0,0) ship -> encoded_result = 2 (hit, no game_over)
    let expected_result = build_expected_result_note(
        &pkgs.result_note,
        result_serial,
        account.id(),
        Felt::new(77), Felt::new(78),
        Felt::new(1),    // turn
        Felt::new(2),    // encoded_result: hit=2
        NoteTag::new(500),
    )?;

    // Execute shot-note
    let tx_context = mock_chain
        .build_tx_context(account.id(), &[shot_note.id()], &[])?
        .extend_expected_output_notes(vec![OutputNote::Full(expected_result)])
        .build()?;
    let executed = tx_context.execute().await?;

    // Verify output note created
    assert!(executed.output_notes().num_notes() >= 1, "Should create result-note");

    account.apply_delta(executed.account_delta())?;
    mock_chain.add_pending_executed_transaction(&executed)?;
    mock_chain.prove_next_block()?;

    // Verify HIT
    let cell_key = Word::from([Felt::new(0), Felt::new(0), Felt::new(0), Felt::new(0)]);
    let cell = account.storage().get_map_item(&board_slot(), cell_key).unwrap();
    assert_eq!(cell[3], Felt::new(6), "Cell (0,0) should be HIT (6)");

    // Verify ships_hit_count
    let opp = account.storage().get_item(&opponent_slot()).unwrap();
    assert_eq!(opp[2], Felt::new(1), "ships_hit_count should be 1");

    println!("test_shot_note_hit_creates_result_note PASSED!");
    Ok(())
}

// ============================================================================
// Task 1D Tests: challenge-note + accept-note handshake
// ============================================================================

/// Full two-account handshake: A sets up board, sends challenge-note to B.
/// B sets up board, consumes challenge-note -> ACTIVE.
/// B sends accept-note to A. A consumes accept-note -> ACTIVE.
#[tokio::test]
async fn test_challenge_accept_handshake() -> anyhow::Result<()> {
    let pkgs = build_note_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth)?;

    let game_id = Word::from([Felt::new(10), Felt::new(20), Felt::new(30), Felt::new(40)]);
    let a_commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);
    let b_commitment = Word::from([Felt::new(500), Felt::new(600), Felt::new(700), Felt::new(800)]);

    // Create Player A (challenger) and Player B (acceptor) with different seeds
    let mut account_a = create_game_account_with_seed(pkgs.contract.clone(), [1u8; 32]).await?;
    let mut account_b = create_game_account_with_seed(pkgs.contract.clone(), [2u8; 32]).await?;

    // Extract actual account ID parts for use as opponent identifiers
    let a_prefix = account_a.id().prefix().as_felt();
    let a_suffix = account_a.id().suffix();
    let b_prefix = account_b.id().prefix().as_felt();
    let b_suffix = account_b.id().suffix();

    // A sets up board: stores B as opponent
    let a_setup_inputs = build_setup_inputs(
        game_id, b_prefix.as_int(), b_suffix.as_int(), a_commitment, &classic_ship_cells(),
    );
    let a_setup_note = create_testing_note_from_package(
        pkgs.setup_note.clone(), sender.id(),
        NoteCreationConfig { inputs: a_setup_inputs, tag: NoteTag::new(10), ..Default::default() },
    )?;

    // B sets up board: stores A as opponent
    let b_setup_inputs = build_setup_inputs(
        game_id, a_prefix.as_int(), a_suffix.as_int(), b_commitment, &classic_ship_cells(),
    );
    let b_setup_note = create_testing_note_from_package(
        pkgs.setup_note.clone(), sender.id(),
        NoteCreationConfig { inputs: b_setup_inputs, tag: NoteTag::new(20), ..Default::default() },
    )?;

    // Challenge note: A -> B. Carries A's ID (B's stored opponent) and A's commitment.
    let challenge_inputs = vec![
        game_id[0], game_id[1], game_id[2], game_id[3],
        a_prefix, a_suffix,  // A's ID = B's stored opponent
        a_commitment[0], a_commitment[1], a_commitment[2], a_commitment[3],
    ];
    let challenge_note = create_testing_note_from_package(
        pkgs.challenge_note.clone(), sender.id(),
        NoteCreationConfig { inputs: challenge_inputs, tag: NoteTag::new(30), ..Default::default() },
    )?;

    // Accept note: B -> A. Carries B's ID (A's stored opponent) and B's commitment.
    let accept_inputs = vec![
        game_id[0], game_id[1], game_id[2], game_id[3],
        b_prefix, b_suffix,  // B's ID = A's stored opponent
        b_commitment[0], b_commitment[1], b_commitment[2], b_commitment[3],
    ];
    let accept_note = create_testing_note_from_package(
        pkgs.accept_note.clone(), sender.id(),
        NoteCreationConfig { inputs: accept_inputs, tag: NoteTag::new(40), ..Default::default() },
    )?;

    builder.add_account(account_a.clone())?;
    builder.add_account(account_b.clone())?;
    builder.add_output_note(OutputNote::Full(a_setup_note.clone()));
    builder.add_output_note(OutputNote::Full(b_setup_note.clone()));
    builder.add_output_note(OutputNote::Full(challenge_note.clone()));
    builder.add_output_note(OutputNote::Full(accept_note.clone()));
    let mut mock_chain = builder.build()?;

    // Step 1: A sets up board -> CHALLENGED
    execute_note_on_account(&mut mock_chain, &mut account_a, a_setup_note).await?;
    let a_config = account_a.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(a_config[2], Felt::new(1), "A should be CHALLENGED");

    // Step 2: B sets up board -> CHALLENGED
    execute_note_on_account(&mut mock_chain, &mut account_b, b_setup_note).await?;
    let b_config = account_b.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(b_config[2], Felt::new(1), "B should be CHALLENGED");

    // Step 3: B consumes challenge-note from A -> ACTIVE (expected_turn=1)
    execute_note_on_account(&mut mock_chain, &mut account_b, challenge_note).await?;
    let b_config = account_b.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(b_config[2], Felt::new(2), "B should be ACTIVE");
    assert_eq!(b_config[3], Felt::new(1), "B expected_turn should be 1");

    // Verify B stored A's commitment as opponent_commitment
    let b_opp_commit = account_b.storage().get_item(&opponent_commitment_slot()).unwrap();
    assert_eq!(b_opp_commit, a_commitment, "B should store A's commitment");

    // Step 4: A consumes accept-note from B -> ACTIVE (expected_turn=2)
    execute_note_on_account(&mut mock_chain, &mut account_a, accept_note).await?;
    let a_config = account_a.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(a_config[2], Felt::new(2), "A should be ACTIVE");
    assert_eq!(a_config[3], Felt::new(2), "A expected_turn should be 2");

    // Verify A stored B's commitment as opponent_commitment
    let a_opp_commit = account_a.storage().get_item(&opponent_commitment_slot()).unwrap();
    assert_eq!(a_opp_commit, b_commitment, "A should store B's commitment");

    println!("test_challenge_accept_handshake PASSED!");
    Ok(())
}

// ============================================================================
// Task 1F Tests: reveal-note verification
// ============================================================================

/// Test reveal-note: after entering REVEAL phase, player sends reveal-note
/// to opponent. Opponent consumes it -> verify_opponent_reveal -> COMPLETE.
#[tokio::test]
async fn test_reveal_note_flow() -> anyhow::Result<()> {
    let pkgs = build_note_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth)?;

    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let (mut account, setup_notes) = create_active_account(
        &pkgs, &mut builder, sender.id(), game_id, 42, 43, 100,
    ).await?;

    // Enter reveal (action 4), mark my reveal (action 5)
    let enter_reveal = make_action_note(&pkgs.action_note, sender.id(), vec![Felt::new(4)], 200)?;
    let mark_reveal = make_action_note(&pkgs.action_note, sender.id(), vec![Felt::new(5)], 201)?;

    // Reveal note from opponent: carries opponent's commitment
    // The stored opponent_commitment is [500, 600, 700, 800] (set in create_active_account)
    let opp_commitment = Word::from([Felt::new(500), Felt::new(600), Felt::new(700), Felt::new(800)]);
    let reveal_note = create_testing_note_from_package(
        pkgs.reveal_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: vec![opp_commitment[0], opp_commitment[1], opp_commitment[2], opp_commitment[3]],
            tag: NoteTag::new(202),
            ..Default::default()
        },
    )?;

    builder.add_output_note(OutputNote::Full(enter_reveal.clone()));
    builder.add_output_note(OutputNote::Full(mark_reveal.clone()));
    builder.add_output_note(OutputNote::Full(reveal_note.clone()));
    let mut mock_chain = builder.build()?;

    // Setup + accept -> ACTIVE
    for note in setup_notes {
        execute_note_on_account(&mut mock_chain, &mut account, note).await?;
    }

    // Enter reveal -> REVEAL
    execute_note_on_account(&mut mock_chain, &mut account, enter_reveal).await?;
    assert_eq!(account.storage().get_item(&game_config_slot()).unwrap()[2], Felt::new(3));

    // Mark my reveal -> my_revealed=1
    execute_note_on_account(&mut mock_chain, &mut account, mark_reveal).await?;
    let status = account.storage().get_item(&reveal_status_slot()).unwrap();
    assert_eq!(status[0], Felt::new(1), "my_revealed should be 1");

    // Consume reveal-note -> verify_opponent_reveal -> opponent_verified=1 -> COMPLETE
    execute_note_on_account(&mut mock_chain, &mut account, reveal_note).await?;
    let status = account.storage().get_item(&reveal_status_slot()).unwrap();
    assert_eq!(status[1], Felt::new(1), "opponent_verified should be 1");

    let config = account.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[2], Felt::new(4), "Phase should be COMPLETE (4)");

    println!("test_reveal_note_flow PASSED!");
    Ok(())
}
