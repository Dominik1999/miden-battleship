use integration::helpers::{
    account_component_from_package, build_project_in_dir, create_testing_note_from_package,
    AccountCreationConfig, NoteCreationConfig,
};

use miden_client::{
    auth::AuthScheme,
    account::{
        component::NoAuth, Account, AccountBuilder, AccountId, StorageMap, StorageSlot,
        StorageSlotName,
    },
    note::{Note, NoteStorage, NoteMetadata, NoteRecipient, NoteScript, NoteTag, NoteType},
    transaction::OutputNote,
    Felt, Word,
};
use miden_testing::{Auth, MockChain};
use miden_protocol::transaction::RawOutputNote;
use std::{path::Path, sync::Arc};

// ============================================================================
// Storage helpers
// ============================================================================

fn board_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::my_board").unwrap()
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
    for c in 0..5 { cells.push((0, c, 1)); } // Carrier
    for c in 0..4 { cells.push((1, c, 2)); } // Battleship
    for c in 0..3 { cells.push((2, c, 3)); } // Cruiser
    for c in 0..3 { cells.push((3, c, 4)); } // Submarine
    for c in 0..2 { cells.push((4, c, 5)); } // Destroyer
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

// ============================================================================
// Package building
// ============================================================================

struct AllPackages {
    contract: Arc<miden_mast_package::Package>,
    setup_note: Arc<miden_mast_package::Package>,
    action_note: Arc<miden_mast_package::Package>,
    shot_note: Arc<miden_mast_package::Package>,
    result_note: Arc<miden_mast_package::Package>,
    challenge_note: Arc<miden_mast_package::Package>,
    accept_note: Arc<miden_mast_package::Package>,
    reveal_note: Arc<miden_mast_package::Package>,
}

fn build_all_packages() -> anyhow::Result<AllPackages> {
    Ok(AllPackages {
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

fn get_note_script_root(pkg: &miden_mast_package::Package) -> Word {
    
    let script = NoteScript::from_library(&pkg.mast).expect("from_library");
    script.root()
}

// ============================================================================
// Account helpers
// ============================================================================

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

/// Execute a shot-note that creates an output result-note.
/// Returns the number of output notes created.
async fn execute_shot_with_result(
    mock_chain: &mut MockChain,
    account: &mut Account,
    shot_note: miden_client::note::Note,
    expected_result_note: Note,
) -> anyhow::Result<usize> {
    let tx_context = mock_chain
        .build_tx_context(account.id(), &[shot_note.id()], &[])?
        .extend_expected_output_notes(vec![RawOutputNote::Full(expected_result_note)])
        .build()?;
    let executed = tx_context.execute().await?;
    let num_output = executed.output_notes().num_notes();
    account.apply_delta(executed.account_delta())?;
    mock_chain.add_pending_executed_transaction(&executed)?;
    mock_chain.prove_next_block()?;
    Ok(num_output)
}

fn build_expected_result_note(
    result_note_pkg: &miden_mast_package::Package,
    serial_num: Word,
    sender_id: AccountId,
    shooter_prefix: Felt,
    shooter_suffix: Felt,
    turn: Felt,
    encoded_result: Felt,
    tag: NoteTag,
) -> anyhow::Result<Note> {
    let script = NoteScript::from_library(&result_note_pkg.mast).expect("from_library");
    let inputs = NoteStorage::new(vec![shooter_prefix, shooter_suffix, turn, encoded_result])?;
    let recipient = NoteRecipient::new(serial_num, script, inputs);
    let metadata = NoteMetadata::new(sender_id, NoteType::Public).with_tag(tag);
    Ok(Note::new(Default::default(), metadata, recipient))
}

fn make_action_note(
    pkg: &Arc<miden_mast_package::Package>,
    sender_id: AccountId,
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

// ============================================================================
// Task 1G: Victory detection — 17th hit triggers REVEAL + game_over
// ============================================================================

/// Fire all 17 ship cells on the defender's board using shot-notes.
/// The 17th hit should set phase=REVEAL and game_over=1.
#[tokio::test]
async fn test_victory_detection_17th_hit() -> anyhow::Result<()> {
    let pkgs = build_all_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth { auth_scheme: AuthScheme::Falcon512Poseidon2 })?;

    // Set up defender (B) in ACTIVE state
    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let mut defender = create_game_account_with_seed(pkgs.contract.clone(), [1u8; 32]).await?;
    let commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);
    let opp_commitment = Word::from([Felt::new(500), Felt::new(600), Felt::new(700), Felt::new(800)]);

    // Setup board
    let setup_inputs = build_setup_inputs(game_id, 42, 43, commitment, &classic_ship_cells());
    let setup_note = create_testing_note_from_package(
        pkgs.setup_note.clone(), sender.id(),
        NoteCreationConfig { inputs: setup_inputs, tag: NoteTag::new(1), ..Default::default() },
    )?;

    // Accept challenge -> ACTIVE with expected_turn=1
    let accept_inputs = vec![
        Felt::new(2),
        game_id[0], game_id[1], game_id[2], game_id[3],
        Felt::new(42), Felt::new(43),
        opp_commitment[0], opp_commitment[1], opp_commitment[2], opp_commitment[3],
    ];
    let accept_note = make_action_note(&pkgs.action_note, sender.id(), accept_inputs, 2)?;

    builder.add_account(defender.clone())?;
    builder.add_output_note(RawOutputNote::Full(setup_note.clone()));
    builder.add_output_note(RawOutputNote::Full(accept_note.clone()));

    // Pre-create all 17 shot notes (one per ship cell)
    // Turns for defender: 1, 3, 5, 7, ... (odd turns, since accept_challenge sets expected_turn=1)
    let ship_cells = classic_ship_cells();
    let result_script_root = get_note_script_root(&pkgs.result_note);
    let mut shot_notes = Vec::new();

    for (i, (row, col, _ship_id)) in ship_cells.iter().enumerate() {
        let turn = (i as u64) * 2 + 1; // 1, 3, 5, ...
        let serial = Word::from([Felt::new(1000 + i as u64), Felt::new(0), Felt::new(0), Felt::new(0)]);

        let shot_inputs = vec![
            Felt::new(*row), Felt::new(*col), Felt::new(turn),
            serial[0], serial[1], serial[2], serial[3],
            result_script_root[0], result_script_root[1], result_script_root[2], result_script_root[3],
            Felt::new(77), Felt::new(78), // shooter prefix/suffix
            Felt::new(600),               // shooter tag
        ];
        let shot_note = create_testing_note_from_package(
            pkgs.shot_note.clone(), sender.id(),
            NoteCreationConfig {
                inputs: shot_inputs,
                tag: NoteTag::new(100 + i as u32),
                ..Default::default()
            },
        )?;
        builder.add_output_note(RawOutputNote::Full(shot_note.clone()));
        shot_notes.push((shot_note, turn, serial, i));
    }

    let mut mock_chain = builder.build()?;

    // Setup + accept
    execute_note_on_account(&mut mock_chain, &mut defender, setup_note).await?;
    execute_note_on_account(&mut mock_chain, &mut defender, accept_note).await?;

    let config = defender.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[2], Felt::new(2), "Should be ACTIVE");

    // Fire all 17 shots
    for (shot_note, turn, serial, i) in shot_notes {
        // All shots hit ships, so encoded_result = 2 (hit, no game_over)
        // except the 17th which is encoded_result = 3 (hit + game_over)
        let is_last = i == 16;
        let encoded_result = if is_last { Felt::new(3) } else { Felt::new(2) };

        let expected = build_expected_result_note(
            &pkgs.result_note, serial, defender.id(),
            Felt::new(77), Felt::new(78),
            Felt::new(turn), encoded_result,
            NoteTag::new(600),
        )?;

        let num_output = execute_shot_with_result(
            &mut mock_chain, &mut defender, shot_note, expected,
        ).await?;
        assert!(num_output >= 1, "Shot {} should create result-note", i);
    }

    // After 17 hits, phase should be REVEAL (3)
    let config = defender.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config[2], Felt::new(3), "Phase should be REVEAL after all ships sunk");

    // ships_hit_count should be 17
    let opp = defender.storage().get_item(&opponent_slot()).unwrap();
    assert_eq!(opp[2], Felt::new(17), "ships_hit_count should be 17");
    assert_eq!(opp[3], Felt::new(17), "total_shots_received should be 17");

    println!("test_victory_detection_17th_hit PASSED!");
    Ok(())
}

// ============================================================================
// Task 1H: Full game integration — setup, handshake, shots, victory, reveal
// ============================================================================

/// Complete end-to-end game: two accounts, handshake, A sinks all B's ships,
/// both enter reveal phase, both verify opponent's reveal → COMPLETE.
#[tokio::test]
async fn test_full_game_a_wins() -> anyhow::Result<()> {
    let pkgs = build_all_packages()?;
    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth { auth_scheme: AuthScheme::Falcon512Poseidon2 })?;

    let game_id = Word::from([Felt::new(10), Felt::new(20), Felt::new(30), Felt::new(40)]);
    let a_commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);
    let b_commitment = Word::from([Felt::new(500), Felt::new(600), Felt::new(700), Felt::new(800)]);

    // Create both accounts with unique seeds
    let mut account_a = create_game_account_with_seed(pkgs.contract.clone(), [1u8; 32]).await?;
    let mut account_b = create_game_account_with_seed(pkgs.contract.clone(), [2u8; 32]).await?;

    let a_prefix = account_a.id().prefix().as_felt();
    let a_suffix = account_a.id().suffix();
    let b_prefix = account_b.id().prefix().as_felt();
    let b_suffix = account_b.id().suffix();

    // ── Setup boards ──
    let a_setup = create_testing_note_from_package(
        pkgs.setup_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: build_setup_inputs(game_id, b_prefix.as_canonical_u64(), b_suffix.as_canonical_u64(), a_commitment, &classic_ship_cells()),
            tag: NoteTag::new(1), ..Default::default()
        },
    )?;
    let b_setup = create_testing_note_from_package(
        pkgs.setup_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: build_setup_inputs(game_id, a_prefix.as_canonical_u64(), a_suffix.as_canonical_u64(), b_commitment, &classic_ship_cells()),
            tag: NoteTag::new(2), ..Default::default()
        },
    )?;

    // ── Handshake notes ──
    // Challenge: A→B (B consumes, calls accept_challenge with A's info)
    let challenge_note = create_testing_note_from_package(
        pkgs.challenge_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: vec![
                game_id[0], game_id[1], game_id[2], game_id[3],
                a_prefix, a_suffix,
                a_commitment[0], a_commitment[1], a_commitment[2], a_commitment[3],
            ],
            tag: NoteTag::new(3), ..Default::default()
        },
    )?;
    // Accept: B→A (A consumes, calls receive_acceptance with B's info)
    let accept_note = create_testing_note_from_package(
        pkgs.accept_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: vec![
                game_id[0], game_id[1], game_id[2], game_id[3],
                b_prefix, b_suffix,
                b_commitment[0], b_commitment[1], b_commitment[2], b_commitment[3],
            ],
            tag: NoteTag::new(4), ..Default::default()
        },
    )?;

    builder.add_account(account_a.clone())?;
    builder.add_account(account_b.clone())?;
    builder.add_output_note(RawOutputNote::Full(a_setup.clone()));
    builder.add_output_note(RawOutputNote::Full(b_setup.clone()));
    builder.add_output_note(RawOutputNote::Full(challenge_note.clone()));
    builder.add_output_note(RawOutputNote::Full(accept_note.clone()));

    // ── Pre-create all 17 shot-notes (A fires at B's ship cells) ──
    let ship_cells = classic_ship_cells();
    let result_script_root = get_note_script_root(&pkgs.result_note);
    let mut shot_notes = Vec::new();

    for (i, (row, col, _)) in ship_cells.iter().enumerate() {
        let turn = (i as u64) * 2 + 1; // B's expected turns: 1, 3, 5, ...
        let serial = Word::from([Felt::new(2000 + i as u64), Felt::new(0), Felt::new(0), Felt::new(0)]);

        let shot_note = create_testing_note_from_package(
            pkgs.shot_note.clone(), sender.id(),
            NoteCreationConfig {
                inputs: vec![
                    Felt::new(*row), Felt::new(*col), Felt::new(turn),
                    serial[0], serial[1], serial[2], serial[3],
                    result_script_root[0], result_script_root[1], result_script_root[2], result_script_root[3],
                    a_prefix, a_suffix, // shooter = A
                    Felt::new(700),     // shooter tag
                ],
                tag: NoteTag::new(100 + i as u32),
                ..Default::default()
            },
        )?;
        builder.add_output_note(RawOutputNote::Full(shot_note.clone()));
        shot_notes.push((shot_note, turn, serial, i));
    }

    // ── Enter-reveal and mark-reveal action notes ──
    // Extra input differentiates notes with same action code (serial is always [0;4])
    let a_enter_reveal = make_action_note(&pkgs.action_note, sender.id(), vec![Felt::new(4), Felt::new(1)], 500)?;
    let a_mark_reveal = make_action_note(&pkgs.action_note, sender.id(), vec![Felt::new(5), Felt::new(1)], 501)?;
    let b_mark_reveal = make_action_note(&pkgs.action_note, sender.id(), vec![Felt::new(5), Felt::new(2)], 502)?;

    // ── Reveal notes ──
    let a_reveal_note = create_testing_note_from_package(
        pkgs.reveal_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: vec![a_commitment[0], a_commitment[1], a_commitment[2], a_commitment[3]],
            tag: NoteTag::new(600), ..Default::default()
        },
    )?;
    let b_reveal_note = create_testing_note_from_package(
        pkgs.reveal_note.clone(), sender.id(),
        NoteCreationConfig {
            inputs: vec![b_commitment[0], b_commitment[1], b_commitment[2], b_commitment[3]],
            tag: NoteTag::new(601), ..Default::default()
        },
    )?;

    builder.add_output_note(RawOutputNote::Full(a_enter_reveal.clone()));
    builder.add_output_note(RawOutputNote::Full(a_mark_reveal.clone()));
    builder.add_output_note(RawOutputNote::Full(b_mark_reveal.clone()));
    builder.add_output_note(RawOutputNote::Full(a_reveal_note.clone()));
    builder.add_output_note(RawOutputNote::Full(b_reveal_note.clone()));

    let mut mock_chain = builder.build()?;

    // ════════════════════════════════════════════════════════════════
    // Phase 1: Board setup
    // ════════════════════════════════════════════════════════════════
    execute_note_on_account(&mut mock_chain, &mut account_a, a_setup).await?;
    execute_note_on_account(&mut mock_chain, &mut account_b, b_setup).await?;
    assert_eq!(account_a.storage().get_item(&game_config_slot()).unwrap()[2], Felt::new(1));
    assert_eq!(account_b.storage().get_item(&game_config_slot()).unwrap()[2], Felt::new(1));

    // ════════════════════════════════════════════════════════════════
    // Phase 2: Handshake
    // ════════════════════════════════════════════════════════════════
    // B consumes challenge → ACTIVE (expected_turn=1)
    execute_note_on_account(&mut mock_chain, &mut account_b, challenge_note).await?;
    assert_eq!(account_b.storage().get_item(&game_config_slot()).unwrap()[2], Felt::new(2));

    // A consumes accept → ACTIVE (expected_turn=2)
    execute_note_on_account(&mut mock_chain, &mut account_a, accept_note).await?;
    assert_eq!(account_a.storage().get_item(&game_config_slot()).unwrap()[2], Felt::new(2));

    // ════════════════════════════════════════════════════════════════
    // Phase 3: A fires 17 shots at B (all hits)
    // ════════════════════════════════════════════════════════════════
    for (shot_note, turn, serial, i) in shot_notes {
        let is_last = i == 16;
        let encoded_result = if is_last { Felt::new(3) } else { Felt::new(2) };

        let expected = build_expected_result_note(
            &pkgs.result_note, serial, account_b.id(),
            a_prefix, a_suffix,
            Felt::new(turn), encoded_result,
            NoteTag::new(700),
        )?;

        execute_shot_with_result(&mut mock_chain, &mut account_b, shot_note, expected).await?;
    }

    // B should now be in REVEAL (process_shot auto-transitions on 17th hit)
    assert_eq!(account_b.storage().get_item(&game_config_slot()).unwrap()[2], Felt::new(3),
        "B should be REVEAL after all ships sunk");
    assert_eq!(account_b.storage().get_item(&opponent_slot()).unwrap()[2], Felt::new(17),
        "B ships_hit_count should be 17");

    // A is still ACTIVE (winner, hasn't entered reveal yet)
    assert_eq!(account_a.storage().get_item(&game_config_slot()).unwrap()[2], Felt::new(2));

    // ════════════════════════════════════════════════════════════════
    // Phase 4: Reveal
    // ════════════════════════════════════════════════════════════════
    // A enters reveal (winner calls enter_reveal)
    execute_note_on_account(&mut mock_chain, &mut account_a, a_enter_reveal).await?;
    assert_eq!(account_a.storage().get_item(&game_config_slot()).unwrap()[2], Felt::new(3));

    // Both mark their own reveal
    execute_note_on_account(&mut mock_chain, &mut account_a, a_mark_reveal).await?;
    execute_note_on_account(&mut mock_chain, &mut account_b, b_mark_reveal).await?;
    assert_eq!(account_a.storage().get_item(&reveal_status_slot()).unwrap()[0], Felt::new(1));
    assert_eq!(account_b.storage().get_item(&reveal_status_slot()).unwrap()[0], Felt::new(1));

    // B consumes A's reveal-note → opponent_verified=1 → COMPLETE (my_revealed already 1)
    execute_note_on_account(&mut mock_chain, &mut account_b, a_reveal_note).await?;
    assert_eq!(account_b.storage().get_item(&game_config_slot()).unwrap()[2], Felt::new(4),
        "B should be COMPLETE");

    // A consumes B's reveal-note → opponent_verified=1 → COMPLETE (my_revealed already 1)
    execute_note_on_account(&mut mock_chain, &mut account_a, b_reveal_note).await?;
    assert_eq!(account_a.storage().get_item(&game_config_slot()).unwrap()[2], Felt::new(4),
        "A should be COMPLETE");

    println!("test_full_game_a_wins PASSED — complete game lifecycle verified!");
    Ok(())
}
