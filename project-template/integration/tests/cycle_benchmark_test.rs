/// Benchmark test: measures cycle counts and execution times for battleship transactions.
///
/// This answers the key question: is the remote prover slow because battleship TXs
/// are very complex (many cycles), or is the prover itself slow?
///
/// Run with:
///   cd project-template && cargo test -p integration --release -- cycle_benchmark --nocapture

use integration::helpers::{
    account_component_from_package, build_project_in_dir, create_testing_note_from_package,
    AccountCreationConfig, NoteCreationConfig,
};

use miden_client::{
    account::{
        component::NoAuth, Account, AccountBuilder, StorageSlot, StorageSlotName,
    },
    auth::AuthScheme,
    note::{Note, NoteMetadata, NoteRecipient, NoteScript, NoteStorage, NoteTag, NoteType},
    Felt, Word,
};
use miden_protocol::transaction::RawOutputNote;
use miden_testing::{Auth, MockChain};
use std::{path::Path, sync::Arc, time::Instant};

// ============================================================================
// Storage helpers (same as integration test)
// ============================================================================

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
    StorageSlotName::new("miden_battleship_account::battleship_account::opponent_commitment")
        .unwrap()
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

fn classic_ship_cells() -> Vec<(u64, u64, u64)> {
    let mut cells = Vec::new();
    for c in 0..5 {
        cells.push((0, c, 1));
    }
    for c in 0..4 {
        cells.push((1, c, 2));
    }
    for c in 0..3 {
        cells.push((2, c, 3));
    }
    for c in 0..3 {
        cells.push((3, c, 4));
    }
    for c in 0..2 {
        cells.push((4, c, 5));
    }
    cells
}

fn pack_board(ship_cells: &[(u64, u64, u64)]) -> [u64; 10] {
    let mut rows = [0u64; 10];
    for (r, c, ship_id) in ship_cells {
        let shift = c * 3;
        rows[*r as usize] |= ship_id << shift;
    }
    rows
}

fn build_setup_inputs(
    game_id: Word,
    opp_prefix: u64,
    opp_suffix: u64,
    commitment: Word,
    ship_cells: &[(u64, u64, u64)],
) -> Vec<Felt> {
    let mut inputs = Vec::new();
    for f in game_id.iter() {
        inputs.push(*f);
    }
    inputs.push(Felt::new(opp_prefix));
    inputs.push(Felt::new(opp_suffix));
    for f in commitment.iter() {
        inputs.push(*f);
    }
    let packed = pack_board(ship_cells);
    for row_val in packed.iter() {
        inputs.push(Felt::new(*row_val));
    }
    inputs
}

fn get_note_script_root(pkg: &miden_mast_package::Package) -> Word {
    let script = NoteScript::from_library(&pkg.mast).expect("from_library");
    script.root()
}

fn build_expected_result_note(
    result_note_pkg: &miden_mast_package::Package,
    serial_num: Word,
    sender_id: miden_client::account::AccountId,
    shooter_prefix: Felt,
    shooter_suffix: Felt,
    turn: Felt,
    encoded_result: Felt,
    tag: NoteTag,
) -> anyhow::Result<Note> {
    let script = NoteScript::from_library(&result_note_pkg.mast).expect("from_library");
    let inputs = NoteStorage::new(vec![shooter_prefix, shooter_suffix, turn, encoded_result])?;
    let recipient = NoteRecipient::new(serial_num, script, inputs);
    let metadata =
        NoteMetadata::new(sender_id, NoteType::Public).with_tag(tag);
    Ok(Note::new(Default::default(), metadata, recipient))
}

fn print_measurements(
    label: &str,
    measurements: &miden_protocol::transaction::TransactionMeasurements,
) {
    println!("\n╔══════════════════════════════════════════════════╗");
    println!("║  {:<46}  ║", label);
    println!("╠══════════════════════════════════════════════════╣");
    println!("║  Prologue:              {:>10} cycles        ║", measurements.prologue);
    println!("║  Notes processing:      {:>10} cycles        ║", measurements.notes_processing);
    for (note_id, cycles) in &measurements.note_execution {
        println!("║    Note {:>16}: {:>10} cycles        ║", &format!("{}", note_id)[..16], cycles);
    }
    println!("║  TX script processing:  {:>10} cycles        ║", measurements.tx_script_processing);
    println!("║  Epilogue:              {:>10} cycles        ║", measurements.epilogue);
    println!("║  Auth procedure:        {:>10} cycles        ║", measurements.auth_procedure);
    println!("║  After-tx overhead:     {:>10} cycles        ║", measurements.after_tx_cycles_obtained);
    println!("╠══════════════════════════════════════════════════╣");
    println!("║  TOTAL CYCLES:          {:>10}               ║", measurements.total_cycles());
    println!("║  TRACE LENGTH:          {:>10} (next pow 2)  ║", measurements.trace_length());
    println!("╚══════════════════════════════════════════════════╝");
}

// ============================================================================
// Benchmark 1: Battleship setup-note consumption (simplest battleship TX)
// ============================================================================

#[tokio::test]
async fn benchmark_battleship_setup_note() -> anyhow::Result<()> {
    println!("\n\n=== BENCHMARK: Battleship setup-note consumption ===\n");

    let t_build = Instant::now();
    let contract_pkg =
        Arc::new(build_project_in_dir(Path::new("../contracts/battleship-account"), true)?);
    let setup_note_pkg =
        Arc::new(build_project_in_dir(Path::new("../contracts/setup-note"), true)?);
    println!("Packages built in {:.2}s", t_build.elapsed().as_secs_f64());

    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth {
        auth_scheme: AuthScheme::Falcon512Poseidon2,
    })?;

    let config = AccountCreationConfig {
        storage_slots: all_storage_slots(),
        ..Default::default()
    };
    let component = account_component_from_package(contract_pkg.clone(), &config)?;
    let mut account = AccountBuilder::new([1u8; 32])
        .account_type(config.account_type)
        .storage_mode(config.storage_mode)
        .with_component(component)
        .with_auth_component(NoAuth)
        .build_existing()?;

    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);
    let setup_inputs = build_setup_inputs(game_id, 42, 43, commitment, &classic_ship_cells());
    let setup_note = create_testing_note_from_package(
        setup_note_pkg.clone(),
        sender.id(),
        NoteCreationConfig {
            inputs: setup_inputs,
            tag: NoteTag::new(1),
            ..Default::default()
        },
    )?;

    builder.add_account(account.clone())?;
    builder.add_output_note(RawOutputNote::Full(setup_note.clone()));
    let mut mock_chain = builder.build()?;

    // Execute and measure
    let tx_context = mock_chain
        .build_tx_context(account.id(), &[setup_note.id()], &[])?
        .build()?;

    let t_exec = Instant::now();
    let executed = tx_context.execute().await?;
    let exec_time = t_exec.elapsed();

    print_measurements("Battleship: setup-note consumption", executed.measurements());
    println!("\n  Execution time (MockChain, no proving): {:.3}s", exec_time.as_secs_f64());

    account.apply_delta(executed.account_delta())?;
    mock_chain.add_pending_executed_transaction(&executed)?;
    mock_chain.prove_next_block()?;

    // Verify it worked
    let config_val = account.storage().get_item(&game_config_slot()).unwrap();
    assert_eq!(config_val[2], Felt::new(1), "Should be CHALLENGED phase");

    Ok(())
}

// ============================================================================
// Benchmark 2: Battleship shot-note consumption (creates output result-note)
// ============================================================================

#[tokio::test]
async fn benchmark_battleship_shot_note() -> anyhow::Result<()> {
    println!("\n\n=== BENCHMARK: Battleship shot-note consumption ===\n");

    let t_build = Instant::now();
    let contract_pkg =
        Arc::new(build_project_in_dir(Path::new("../contracts/battleship-account"), true)?);
    let setup_note_pkg =
        Arc::new(build_project_in_dir(Path::new("../contracts/setup-note"), true)?);
    let action_note_pkg =
        Arc::new(build_project_in_dir(Path::new("../contracts/action-note"), true)?);
    let shot_note_pkg =
        Arc::new(build_project_in_dir(Path::new("../contracts/shot-note"), true)?);
    let result_note_pkg =
        Arc::new(build_project_in_dir(Path::new("../contracts/result-note"), true)?);
    println!("Packages built in {:.2}s", t_build.elapsed().as_secs_f64());

    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth {
        auth_scheme: AuthScheme::Falcon512Poseidon2,
    })?;

    let config = AccountCreationConfig {
        storage_slots: all_storage_slots(),
        ..Default::default()
    };
    let component = account_component_from_package(contract_pkg.clone(), &config)?;
    let mut account = AccountBuilder::new([1u8; 32])
        .account_type(config.account_type)
        .storage_mode(config.storage_mode)
        .with_component(component)
        .with_auth_component(NoAuth)
        .build_existing()?;

    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);
    let opp_commitment =
        Word::from([Felt::new(500), Felt::new(600), Felt::new(700), Felt::new(800)]);

    // Setup note
    let setup_inputs = build_setup_inputs(game_id, 42, 43, commitment, &classic_ship_cells());
    let setup_note = create_testing_note_from_package(
        setup_note_pkg.clone(),
        sender.id(),
        NoteCreationConfig {
            inputs: setup_inputs,
            tag: NoteTag::new(1),
            ..Default::default()
        },
    )?;

    // Accept challenge action note (transitions to ACTIVE with expected_turn=1)
    let accept_inputs = vec![
        Felt::new(2),
        game_id[0],
        game_id[1],
        game_id[2],
        game_id[3],
        Felt::new(42),
        Felt::new(43),
        opp_commitment[0],
        opp_commitment[1],
        opp_commitment[2],
        opp_commitment[3],
    ];
    let accept_note = create_testing_note_from_package(
        action_note_pkg.clone(),
        sender.id(),
        NoteCreationConfig {
            inputs: accept_inputs,
            tag: NoteTag::new(2),
            ..Default::default()
        },
    )?;

    // Shot note (fires at row=0, col=0 which is a carrier cell = HIT)
    let result_script_root = get_note_script_root(&result_note_pkg);
    let serial =
        Word::from([Felt::new(1000), Felt::new(0), Felt::new(0), Felt::new(0)]);
    let shot_inputs = vec![
        Felt::new(0),
        Felt::new(0),
        Felt::new(1), // turn=1
        serial[0],
        serial[1],
        serial[2],
        serial[3],
        result_script_root[0],
        result_script_root[1],
        result_script_root[2],
        result_script_root[3],
        Felt::new(77),
        Felt::new(78), // shooter prefix/suffix
        Felt::new(600),               // shooter tag
    ];
    let shot_note = create_testing_note_from_package(
        shot_note_pkg.clone(),
        sender.id(),
        NoteCreationConfig {
            inputs: shot_inputs,
            tag: NoteTag::new(100),
            ..Default::default()
        },
    )?;

    builder.add_account(account.clone())?;
    builder.add_output_note(RawOutputNote::Full(setup_note.clone()));
    builder.add_output_note(RawOutputNote::Full(accept_note.clone()));
    builder.add_output_note(RawOutputNote::Full(shot_note.clone()));
    let mut mock_chain = builder.build()?;

    // First: execute setup (just to get to right state)
    let tx = mock_chain
        .build_tx_context(account.id(), &[setup_note.id()], &[])?
        .build()?;
    let exec = tx.execute().await?;
    account.apply_delta(exec.account_delta())?;
    mock_chain.add_pending_executed_transaction(&exec)?;
    mock_chain.prove_next_block()?;

    // Second: execute accept (get to ACTIVE)
    let tx = mock_chain
        .build_tx_context(account.id(), &[accept_note.id()], &[])?
        .build()?;
    let exec = tx.execute().await?;
    print_measurements("Battleship: accept-challenge (action-note)", exec.measurements());
    account.apply_delta(exec.account_delta())?;
    mock_chain.add_pending_executed_transaction(&exec)?;
    mock_chain.prove_next_block()?;

    // Third: execute shot (the main benchmark)
    let expected_result = build_expected_result_note(
        &result_note_pkg,
        serial,
        account.id(),
        Felt::new(77),
        Felt::new(78),
        Felt::new(1),
        Felt::new(2), // hit, no game_over
        NoteTag::new(600),
    )?;

    let tx = mock_chain
        .build_tx_context(account.id(), &[shot_note.id()], &[])?
        .extend_expected_output_notes(vec![RawOutputNote::Full(expected_result)])
        .build()?;

    let t_exec = Instant::now();
    let exec = tx.execute().await?;
    let exec_time = t_exec.elapsed();

    print_measurements("Battleship: shot-note consumption (with result output)", exec.measurements());
    println!("\n  Execution time (MockChain, no proving): {:.3}s", exec_time.as_secs_f64());

    Ok(())
}

// ============================================================================
// Benchmark 3: Baseline — empty wallet TX (no custom component, no notes)
// This gives us the "floor" for Miden TX overhead.
// ============================================================================

#[tokio::test]
async fn benchmark_baseline_wallet() -> anyhow::Result<()> {
    println!("\n\n=== BENCHMARK: Baseline wallet (no custom component) ===\n");

    let mut builder = MockChain::builder();
    let wallet = builder.add_existing_wallet(Auth::BasicAuth {
        auth_scheme: AuthScheme::Falcon512Poseidon2,
    })?;

    let mock_chain = builder.build()?;

    // Execute a minimal TX (no notes consumed, just the wallet TX)
    let tx_context = mock_chain
        .build_tx_context(wallet.id(), &[], &[])?
        .build()?;

    let t_exec = Instant::now();
    let executed = tx_context.execute().await?;
    let exec_time = t_exec.elapsed();

    print_measurements("Baseline: empty wallet TX (Falcon512 auth)", executed.measurements());
    println!("\n  Execution time (MockChain, no proving): {:.3}s", exec_time.as_secs_f64());

    Ok(())
}

// ============================================================================
// Summary: Run all benchmarks and print comparison
// ============================================================================

#[tokio::test]
async fn benchmark_summary() -> anyhow::Result<()> {
    println!("\n\n╔══════════════════════════════════════════════════════════╗");
    println!("║            BATTLESHIP CYCLE COUNT BENCHMARKS             ║");
    println!("╚══════════════════════════════════════════════════════════╝\n");

    // --- Baseline ---
    let mut builder = MockChain::builder();
    let wallet = builder.add_existing_wallet(Auth::BasicAuth {
        auth_scheme: AuthScheme::Falcon512Poseidon2,
    })?;
    let mock_chain = builder.build()?;
    let tx = mock_chain.build_tx_context(wallet.id(), &[], &[])?.build()?;
    let t = Instant::now();
    let baseline = tx.execute().await?;
    let baseline_time = t.elapsed();

    // --- Battleship setup ---
    let contract_pkg =
        Arc::new(build_project_in_dir(Path::new("../contracts/battleship-account"), true)?);
    let setup_note_pkg =
        Arc::new(build_project_in_dir(Path::new("../contracts/setup-note"), true)?);
    let action_note_pkg =
        Arc::new(build_project_in_dir(Path::new("../contracts/action-note"), true)?);
    let shot_note_pkg =
        Arc::new(build_project_in_dir(Path::new("../contracts/shot-note"), true)?);
    let result_note_pkg =
        Arc::new(build_project_in_dir(Path::new("../contracts/result-note"), true)?);

    let mut builder = MockChain::builder();
    let sender = builder.add_existing_wallet(Auth::BasicAuth {
        auth_scheme: AuthScheme::Falcon512Poseidon2,
    })?;

    let config = AccountCreationConfig {
        storage_slots: all_storage_slots(),
        ..Default::default()
    };
    let component = account_component_from_package(contract_pkg.clone(), &config)?;
    let mut account = AccountBuilder::new([1u8; 32])
        .account_type(config.account_type)
        .storage_mode(config.storage_mode)
        .with_component(component)
        .with_auth_component(NoAuth)
        .build_existing()?;

    let game_id = Word::from([Felt::new(1), Felt::new(2), Felt::new(3), Felt::new(4)]);
    let commitment = Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);
    let opp_commitment =
        Word::from([Felt::new(500), Felt::new(600), Felt::new(700), Felt::new(800)]);

    let setup_inputs = build_setup_inputs(game_id, 42, 43, commitment, &classic_ship_cells());
    let setup_note = create_testing_note_from_package(
        setup_note_pkg.clone(),
        sender.id(),
        NoteCreationConfig {
            inputs: setup_inputs,
            tag: NoteTag::new(1),
            ..Default::default()
        },
    )?;

    let accept_inputs = vec![
        Felt::new(2),
        game_id[0], game_id[1], game_id[2], game_id[3],
        Felt::new(42), Felt::new(43),
        opp_commitment[0], opp_commitment[1], opp_commitment[2], opp_commitment[3],
    ];
    let accept_note = create_testing_note_from_package(
        action_note_pkg.clone(),
        sender.id(),
        NoteCreationConfig {
            inputs: accept_inputs,
            tag: NoteTag::new(2),
            ..Default::default()
        },
    )?;

    let result_script_root = get_note_script_root(&result_note_pkg);
    let serial = Word::from([Felt::new(1000), Felt::new(0), Felt::new(0), Felt::new(0)]);
    let shot_inputs = vec![
        Felt::new(0), Felt::new(0), Felt::new(1),
        serial[0], serial[1], serial[2], serial[3],
        result_script_root[0], result_script_root[1], result_script_root[2], result_script_root[3],
        Felt::new(77), Felt::new(78),
        Felt::new(600),
    ];
    let shot_note = create_testing_note_from_package(
        shot_note_pkg.clone(),
        sender.id(),
        NoteCreationConfig {
            inputs: shot_inputs,
            tag: NoteTag::new(100),
            ..Default::default()
        },
    )?;

    builder.add_account(account.clone())?;
    builder.add_output_note(RawOutputNote::Full(setup_note.clone()));
    builder.add_output_note(RawOutputNote::Full(accept_note.clone()));
    builder.add_output_note(RawOutputNote::Full(shot_note.clone()));
    let mut mock_chain = builder.build()?;

    // Execute setup
    let tx = mock_chain.build_tx_context(account.id(), &[setup_note.id()], &[])?.build()?;
    let t = Instant::now();
    let setup_exec = tx.execute().await?;
    let setup_time = t.elapsed();
    account.apply_delta(setup_exec.account_delta())?;
    mock_chain.add_pending_executed_transaction(&setup_exec)?;
    mock_chain.prove_next_block()?;

    // Execute accept
    let tx = mock_chain.build_tx_context(account.id(), &[accept_note.id()], &[])?.build()?;
    let t = Instant::now();
    let accept_exec = tx.execute().await?;
    let accept_time = t.elapsed();
    account.apply_delta(accept_exec.account_delta())?;
    mock_chain.add_pending_executed_transaction(&accept_exec)?;
    mock_chain.prove_next_block()?;

    // Execute shot
    let expected_result = build_expected_result_note(
        &result_note_pkg, serial, account.id(),
        Felt::new(77), Felt::new(78), Felt::new(1), Felt::new(2),
        NoteTag::new(600),
    )?;
    let tx = mock_chain
        .build_tx_context(account.id(), &[shot_note.id()], &[])?
        .extend_expected_output_notes(vec![RawOutputNote::Full(expected_result)])
        .build()?;
    let t = Instant::now();
    let shot_exec = tx.execute().await?;
    let shot_time = t.elapsed();

    // Print summary
    println!("╔═══════════════════════════════════════════════════════════════════════╗");
    println!("║                        CYCLE COUNT COMPARISON                        ║");
    println!("╠═══════════════════════════════════════════════════════════════╦═══════╣");
    println!("║ Transaction                    │ Total Cycles │ Trace Length ║ Time  ║");
    println!("╠════════════════════════════════╪══════════════╪═════════════╬═══════╣");
    println!("║ Baseline (empty wallet/Falcon) │ {:>12} │ {:>11} ║ {:>5.1}s ║",
        baseline.measurements().total_cycles(),
        baseline.measurements().trace_length(),
        baseline_time.as_secs_f64());
    println!("║ Battleship: setup-note         │ {:>12} │ {:>11} ║ {:>5.1}s ║",
        setup_exec.measurements().total_cycles(),
        setup_exec.measurements().trace_length(),
        setup_time.as_secs_f64());
    println!("║ Battleship: accept-challenge   │ {:>12} │ {:>11} ║ {:>5.1}s ║",
        accept_exec.measurements().total_cycles(),
        accept_exec.measurements().trace_length(),
        accept_time.as_secs_f64());
    println!("║ Battleship: shot (w/ result)   │ {:>12} │ {:>11} ║ {:>5.1}s ║",
        shot_exec.measurements().total_cycles(),
        shot_exec.measurements().trace_length(),
        shot_time.as_secs_f64());
    println!("╚════════════════════════════════╧══════════════╧═════════════╩═══════╝");

    // Proving time estimation
    println!("\n--- Proving Time Estimates ---");
    println!("Remote prover observed: ~32s for battleship TX");
    let setup_cycles = setup_exec.measurements().total_cycles();
    let baseline_cycles = baseline.measurements().total_cycles();
    println!("Battleship setup is {:.1}x more cycles than baseline",
        setup_cycles as f64 / baseline_cycles as f64);
    println!("Trace length {} means the prover must process a {} x ~70 column matrix",
        setup_exec.measurements().trace_length(),
        setup_exec.measurements().trace_length());

    // Detailed breakdown for the setup note
    print_measurements("DETAIL: Battleship setup-note", setup_exec.measurements());
    print_measurements("DETAIL: Battleship shot-note", shot_exec.measurements());
    print_measurements("DETAIL: Baseline wallet", baseline.measurements());

    println!("\n--- Key Insight ---");
    let setup_trace = setup_exec.measurements().trace_length();
    if setup_trace >= 1 << 18 {
        println!("Trace length {} (>= 2^18 = 262144) is LARGE.", setup_trace);
        println!("Proving time scales roughly O(n * log(n)) with trace length.");
        println!("For trace length 2^18, expect ~10-30s proving time on good hardware.");
        println!("For trace length 2^20, expect ~60-120s proving time.");
        println!("32s remote proving time may be EXPECTED for this complexity.");
    } else if setup_trace >= 1 << 16 {
        println!("Trace length {} (>= 2^16) is MODERATE.", setup_trace);
        println!("32s proving time seems HIGH for this complexity.");
        println!("Possible bottleneck: network latency, prover queue, or serialization overhead.");
    } else {
        println!("Trace length {} is SMALL.", setup_trace);
        println!("32s proving time is VERY HIGH for this complexity.");
        println!("The bottleneck is NOT transaction complexity but prover infrastructure.");
    }

    Ok(())
}
