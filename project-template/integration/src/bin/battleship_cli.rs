//! Interactive two-terminal battleship CLI.
//!
//! Usage (two separate terminals):
//!   cargo run --bin battleship_cli --release -- --player alice --role challenger --game-id myGame1
//!   cargo run --bin battleship_cli --release -- --player bob --role acceptor --game-id myGame1
//!
//! Prerequisites: local Miden node running on port 57291.
//! Both players must exchange account IDs out-of-band (printed at startup).

use integration::battleship::*;
use integration::helpers::*;

use anyhow::{bail, Context, Result};
use clap::Parser;
use miden_client::{
    account::AccountId,
    keystore::FilesystemKeyStore,
    note::{Note, NoteInputs, NoteRecipient, NoteScript, NoteTag},
    store::NoteFilter,
    transaction::{OutputNote, TransactionRequestBuilder},
    Client, Felt, Word,
};
use std::collections::HashSet;
use std::io::{self, Write as IoWrite};
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Parser)]
#[command(name = "battleship", about = "Miden Battleship CLI")]
struct Args {
    /// Player name (used for keystore/store isolation)
    #[arg(long)]
    player: String,

    /// Role: "challenger" (fires first) or "acceptor"
    #[arg(long)]
    role: String,

    /// Shared game ID (both players must use the same)
    #[arg(long)]
    game_id: String,

    /// Opponent's account ID (hex). If not provided, will prompt.
    #[arg(long)]
    opponent: Option<String>,
}

// ============================================================================
// Note tag scheme — both players subscribe to all tags
// ============================================================================

const TAG_CHALLENGE: u32 = 10;
const TAG_ACCEPT: u32 = 20;
const TAG_SHOT_BASE: u32 = 1000; // TAG_SHOT_BASE + turn_number
const TAG_RESULT: u32 = 40; // Used as shooter_tag in shot-note inputs
const TAG_ACTION: u32 = 50;
const TAG_REVEAL: u32 = 60;

/// Subscribe to all game note tags so sync discovers them.
async fn subscribe_to_game_tags(client: &mut Client<FilesystemKeyStore>) -> Result<()> {
    // Fixed tags
    for tag in [TAG_CHALLENGE, TAG_ACCEPT, TAG_RESULT, TAG_ACTION, TAG_REVEAL] {
        client.add_note_tag(NoteTag::new(tag)).await.ok(); // ignore "already tracked"
    }
    // Shot tags for up to 34 turns (17 shots each direction)
    for turn in 1..=34 {
        client
            .add_note_tag(NoteTag::new(TAG_SHOT_BASE + turn))
            .await
            .ok();
    }
    Ok(())
}

// ============================================================================
// Display helpers
// ============================================================================

fn print_board(title: &str, cells: &[[char; 10]; 10]) {
    println!("  {}", title);
    println!("    A B C D E F G H I J");
    for r in 0..10 {
        print!("  {:>2}", r + 1);
        for c in 0..10 {
            print!(" {}", cells[r][c]);
        }
        println!();
    }
}

fn print_boards(my_board: &[[char; 10]; 10], opp_board: &[[char; 10]; 10]) {
    println!();
    print_board("YOUR BOARD", my_board);
    println!();
    print_board("OPPONENT'S BOARD", opp_board);
    println!("  Legend: S=ship X=hit O=miss .=unknown/water");
    println!();
}

fn make_my_board_display(
    ship_cells: &[(u64, u64, u64)],
    hits_on_me: &[(usize, usize, bool)],
) -> [[char; 10]; 10] {
    let mut board = [['.'; 10]; 10];
    for (r, c, _) in ship_cells {
        board[*r as usize][*c as usize] = 'S';
    }
    for (r, c, is_hit) in hits_on_me {
        board[*r][*c] = if *is_hit { 'X' } else { 'O' };
    }
    board
}

fn make_opp_board_display(my_shots: &[(usize, usize, bool)]) -> [[char; 10]; 10] {
    let mut board = [['.'; 10]; 10];
    for (r, c, is_hit) in my_shots {
        board[*r][*c] = if *is_hit { 'X' } else { 'O' };
    }
    board
}

fn parse_coordinates(input: &str) -> Option<(u64, u64)> {
    let input = input.trim().to_uppercase();
    if input.len() < 2 || input.len() > 3 {
        return None;
    }
    let col = (input.as_bytes()[0] as u64).checked_sub(b'A' as u64)?;
    let row: u64 = input[1..].parse::<u64>().ok()?.checked_sub(1)?;
    if row < 10 && col < 10 {
        Some((row, col))
    } else {
        None
    }
}

fn prompt(msg: &str) -> String {
    print!("{}", msg);
    io::stdout().flush().unwrap();
    let mut input = String::new();
    io::stdin().read_line(&mut input).unwrap();
    input.trim().to_string()
}

fn coord_label(row: u64, col: u64) -> String {
    format!("{}{}", (b'A' + col as u8) as char, row + 1)
}

// ============================================================================
// Transaction helpers
// ============================================================================

async fn publish_note(
    client: &mut Client<FilesystemKeyStore>,
    sender_id: AccountId,
    note: Note,
) -> Result<()> {
    let request = TransactionRequestBuilder::new()
        .own_output_notes(vec![OutputNote::Full(note)])
        .build()?;
    client.submit_new_transaction(sender_id, request).await?;
    client.sync_state().await?;
    Ok(())
}

async fn consume_note(
    client: &mut Client<FilesystemKeyStore>,
    account_id: AccountId,
    note: Note,
) -> Result<()> {
    let request = TransactionRequestBuilder::new()
        .input_notes([(note, None)])
        .build()?;
    client.submit_new_transaction(account_id, request).await?;
    client.sync_state().await?;
    Ok(())
}

async fn consume_shot_note(
    client: &mut Client<FilesystemKeyStore>,
    account_id: AccountId,
    shot_note: Note,
    result_recipient: NoteRecipient,
) -> Result<()> {
    let request = TransactionRequestBuilder::new()
        .input_notes([(shot_note, None)])
        .expected_output_recipients(vec![result_recipient])
        .build()?;
    client.submit_new_transaction(account_id, request).await?;
    client.sync_state().await?;
    Ok(())
}

// ============================================================================
// Note discovery via sync
// ============================================================================

/// Poll sync_state until a note with the given tag appears that we haven't seen before.
/// Returns the discovered Note.
async fn poll_for_note(
    client: &mut Client<FilesystemKeyStore>,
    tag: u32,
    seen_ids: &HashSet<miden_client::note::NoteId>,
    timeout_secs: u64,
) -> Result<Note> {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        client.sync_state().await?;
        let notes = client.get_input_notes(NoteFilter::Unspent).await?;
        for record in notes {
            if seen_ids.contains(&record.id()) {
                continue;
            }
            if let Some(metadata) = record.metadata() {
                if metadata.tag() == NoteTag::new(tag) {
                    let note: Note = record
                        .try_into()
                        .map_err(|e| anyhow::anyhow!("InputNoteRecord→Note: {:?}", e))?;
                    return Ok(note);
                }
            }
        }
        if Instant::now() > deadline {
            bail!("Timeout ({}s) waiting for note with tag {}", timeout_secs, tag);
        }
        print!(".");
        io::stdout().flush()?;
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

/// Poll for a result-note (TAG_RESULT) that we haven't seen before.
async fn poll_for_result_note(
    client: &mut Client<FilesystemKeyStore>,
    seen_ids: &HashSet<miden_client::note::NoteId>,
    timeout_secs: u64,
) -> Result<Note> {
    poll_for_note(client, TAG_RESULT, seen_ids, timeout_secs).await
}

fn game_id_from_string(s: &str) -> Word {
    // Simple hash: use first 4 bytes padded with zeros
    let bytes = s.as_bytes();
    Word::from([
        Felt::new(bytes.first().copied().unwrap_or(0) as u64),
        Felt::new(bytes.get(1).copied().unwrap_or(0) as u64),
        Felt::new(bytes.get(2).copied().unwrap_or(0) as u64),
        Felt::new(bytes.get(3).copied().unwrap_or(0) as u64),
    ])
}

// ============================================================================
// Shot-note input parsing
// ============================================================================

/// Extract fields from a shot-note's inputs.
/// Input layout: [row, col, turn, serial[4], result_script_root[4], shooter_prefix, shooter_suffix, shooter_tag]
struct ShotNoteInputs {
    row: u64,
    col: u64,
    turn: u64,
    serial: Word,
}

impl ShotNoteInputs {
    fn from_note(note: &Note) -> Result<Self> {
        let inputs = note.recipient().inputs().values();
        if inputs.len() < 14 {
            bail!("Shot note has {} inputs, expected 14", inputs.len());
        }
        Ok(Self {
            row: inputs[0].as_int(),
            col: inputs[1].as_int(),
            turn: inputs[2].as_int(),
            serial: Word::from([inputs[3], inputs[4], inputs[5], inputs[6]]),
        })
    }
}

// ============================================================================
// Main
// ============================================================================

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    if args.role != "challenger" && args.role != "acceptor" {
        bail!("Role must be 'challenger' or 'acceptor'");
    }
    let is_challenger = args.role == "challenger";

    println!("=== Miden Battleship ===");
    println!(
        "Player: {}, Role: {}, Game: {}",
        args.player, args.role, args.game_id
    );

    // ── Setup client ──
    let ClientSetup {
        mut client,
        keystore,
    } = setup_local_client_for_player(&args.player).await?;
    client.sync_state().await?;
    println!("Connected to local node.");

    // Subscribe to all game tags for note discovery
    subscribe_to_game_tags(&mut client).await?;

    // ── Build packages ──
    println!("Building contracts...");
    let pkgs = build_all_packages_from(Path::new("contracts"))?;
    println!("Contracts ready.");

    // ── Create accounts ──
    let config = AccountCreationConfig {
        storage_slots: all_storage_slots(),
        ..Default::default()
    };

    let sender = create_basic_wallet_account(
        &mut client,
        keystore.clone(),
        AccountCreationConfig::default(),
    )
    .await?;
    let my_account = create_authenticated_game_account(
        &mut client,
        keystore.clone(),
        pkgs.contract.clone(),
        config,
    )
    .await?;

    println!("Your account ID: {}", my_account.id().to_hex());
    println!("(Share this with your opponent)");
    println!();

    let game_id = game_id_from_string(&args.game_id);
    let ship_cells = classic_ship_cells();
    let commitment =
        Word::from([Felt::new(100), Felt::new(200), Felt::new(300), Felt::new(400)]);

    // ── Get opponent ID ──
    let opponent_hex = if let Some(opp) = args.opponent {
        opp
    } else {
        prompt("Enter opponent's account ID (hex): ")
    };
    let opponent_id = AccountId::from_hex(&opponent_hex).context("Invalid opponent account ID")?;
    let opp_prefix = opponent_id.prefix().as_felt();
    let opp_suffix = opponent_id.suffix();

    // ── Board setup ──
    println!("Setting up board with classic ship placement...");
    let setup_inputs = build_setup_inputs(
        game_id,
        opp_prefix.as_int(),
        opp_suffix.as_int(),
        commitment,
        &ship_cells,
    );
    let setup_note = create_note_from_package(
        &mut client,
        pkgs.setup_note.clone(),
        sender.id(),
        NoteCreationConfig {
            inputs: setup_inputs,
            tag: NoteTag::new(1), // internal, not discovered by opponent
            ..Default::default()
        },
    )?;
    publish_note(&mut client, sender.id(), setup_note.clone()).await?;
    consume_note(&mut client, my_account.id(), setup_note).await?;
    println!("Board set up!");

    let my_prefix = my_account.id().prefix().as_felt();
    let my_suffix = my_account.id().suffix();

    // Track all note IDs we've seen/consumed to avoid duplicates
    let mut seen_note_ids: HashSet<miden_client::note::NoteId> = HashSet::new();

    // ── Handshake ──
    if is_challenger {
        // A: Send challenge → wait for accept
        println!("Sending challenge...");
        let challenge_note = create_note_from_package(
            &mut client,
            pkgs.challenge_note.clone(),
            sender.id(),
            NoteCreationConfig {
                inputs: vec![
                    game_id[0],
                    game_id[1],
                    game_id[2],
                    game_id[3],
                    my_prefix,
                    my_suffix,
                    commitment[0],
                    commitment[1],
                    commitment[2],
                    commitment[3],
                ],
                tag: NoteTag::new(TAG_CHALLENGE),
                ..Default::default()
            },
        )?;
        publish_note(&mut client, sender.id(), challenge_note).await?;
        println!("Challenge sent! Waiting for opponent to accept...");

        // Poll for accept-note from opponent
        let accept_note =
            poll_for_note(&mut client, TAG_ACCEPT, &seen_note_ids, 300).await?;
        println!("\nAccept-note received!");
        seen_note_ids.insert(accept_note.id());
        consume_note(&mut client, my_account.id(), accept_note).await?;
        println!("Game is ACTIVE! You fire first.");
    } else {
        // B: Wait for challenge → send accept
        println!("Waiting for challenge from opponent...");
        let challenge_note =
            poll_for_note(&mut client, TAG_CHALLENGE, &seen_note_ids, 300).await?;
        println!("\nChallenge received!");
        seen_note_ids.insert(challenge_note.id());
        consume_note(&mut client, my_account.id(), challenge_note).await?;

        // Send accept back
        println!("Sending accept...");
        let accept_note = create_note_from_package(
            &mut client,
            pkgs.accept_note.clone(),
            sender.id(),
            NoteCreationConfig {
                inputs: vec![
                    game_id[0],
                    game_id[1],
                    game_id[2],
                    game_id[3],
                    my_prefix,
                    my_suffix,
                    commitment[0],
                    commitment[1],
                    commitment[2],
                    commitment[3],
                ],
                tag: NoteTag::new(TAG_ACCEPT),
                ..Default::default()
            },
        )?;
        publish_note(&mut client, sender.id(), accept_note).await?;
        println!("Accepted! Waiting for opponent's first shot...");
    }

    // ── Shot loop ──
    let result_script_root = get_note_script_root(&pkgs.result_note);
    let result_program = pkgs.result_note.unwrap_program();
    let result_script = NoteScript::from_parts(
        result_program.mast_forest().clone(),
        result_program.entrypoint(),
    );

    let mut my_shots: Vec<(usize, usize, bool)> = Vec::new();
    let mut hits_on_me: Vec<(usize, usize, bool)> = Vec::new();
    let mut my_turn_counter: u64 = if is_challenger { 1 } else { 2 };
    let mut opp_turn_counter: u64 = if is_challenger { 2 } else { 1 };
    let mut my_ships_hit: u64 = 0;
    let mut opp_ships_hit: u64 = 0;
    let mut cells_hit_on_me: HashSet<(u64, u64)> = HashSet::new();
    let mut game_over = false;
    let mut i_won = false;

    while !game_over {
        let my_board = make_my_board_display(&ship_cells, &hits_on_me);
        let opp_board = make_opp_board_display(&my_shots);
        print_boards(&my_board, &opp_board);

        // Determine whose turn it is
        // Challenger fires odd turns, acceptor fires even turns
        let my_turn_first = is_challenger; // challenger always acts first in each round

        if my_turn_first {
            // My turn: fire
            game_over = fire_shot(
                &mut client,
                &sender,
                &my_account,
                &pkgs,
                &result_script_root,
                &result_script,
                my_prefix,
                my_suffix,
                my_turn_counter,
                &mut my_shots,
                &mut opp_ships_hit,
                &mut seen_note_ids,
            )
            .await?;

            if game_over {
                i_won = true;
                break;
            }
            my_turn_counter += 2;

            // Opponent's turn: defend
            game_over = defend_shot(
                &mut client,
                &my_account,
                &result_script,
                &ship_cells,
                opp_turn_counter,
                &mut hits_on_me,
                &mut my_ships_hit,
                &mut cells_hit_on_me,
                &mut seen_note_ids,
            )
            .await?;

            if game_over {
                i_won = false;
                break;
            }
            opp_turn_counter += 2;
        } else {
            // Opponent's turn first: defend
            game_over = defend_shot(
                &mut client,
                &my_account,
                &result_script,
                &ship_cells,
                opp_turn_counter,
                &mut hits_on_me,
                &mut my_ships_hit,
                &mut cells_hit_on_me,
                &mut seen_note_ids,
            )
            .await?;

            if game_over {
                i_won = false;
                break;
            }
            opp_turn_counter += 2;

            // Show updated board before my turn
            let my_board = make_my_board_display(&ship_cells, &hits_on_me);
            let opp_board = make_opp_board_display(&my_shots);
            print_boards(&my_board, &opp_board);

            // My turn: fire
            game_over = fire_shot(
                &mut client,
                &sender,
                &my_account,
                &pkgs,
                &result_script_root,
                &result_script,
                my_prefix,
                my_suffix,
                my_turn_counter,
                &mut my_shots,
                &mut opp_ships_hit,
                &mut seen_note_ids,
            )
            .await?;

            if game_over {
                i_won = true;
                break;
            }
            my_turn_counter += 2;
        }
    }

    // ── Game over ──
    println!();
    if i_won {
        println!("*** YOU WIN! All enemy ships sunk! ***");
    } else {
        println!("*** YOU LOSE! All your ships are sunk! ***");
    }

    // Show final boards
    let my_board = make_my_board_display(&ship_cells, &hits_on_me);
    let opp_board = make_opp_board_display(&my_shots);
    print_boards(&my_board, &opp_board);

    // ── Reveal phase ──
    println!("Entering reveal phase...");
    let enter_reveal = create_note_from_package(
        &mut client,
        pkgs.action_note.clone(),
        sender.id(),
        NoteCreationConfig {
            inputs: vec![Felt::new(4), Felt::new(99)],
            tag: NoteTag::new(TAG_ACTION),
            ..Default::default()
        },
    )?;
    publish_note(&mut client, sender.id(), enter_reveal.clone()).await?;
    consume_note(&mut client, my_account.id(), enter_reveal).await?;

    let mark_reveal = create_note_from_package(
        &mut client,
        pkgs.action_note.clone(),
        sender.id(),
        NoteCreationConfig {
            inputs: vec![Felt::new(5), Felt::new(98)], // different input to avoid nullifier collision
            tag: NoteTag::new(TAG_ACTION),
            ..Default::default()
        },
    )?;
    publish_note(&mut client, sender.id(), mark_reveal.clone()).await?;
    consume_note(&mut client, my_account.id(), mark_reveal).await?;

    println!("Reveal complete. Thanks for playing Miden Battleship!");
    Ok(())
}

// ============================================================================
// Fire a shot (my turn)
// ============================================================================

#[allow(clippy::too_many_arguments)]
async fn fire_shot(
    client: &mut Client<FilesystemKeyStore>,
    sender: &miden_client::account::Account,
    my_account: &miden_client::account::Account,
    pkgs: &AllPackages,
    result_script_root: &Word,
    _result_script: &NoteScript,
    my_prefix: Felt,
    my_suffix: Felt,
    turn: u64,
    my_shots: &mut Vec<(usize, usize, bool)>,
    opp_ships_hit: &mut u64,
    seen_ids: &mut HashSet<miden_client::note::NoteId>,
) -> Result<bool> {
    // Prompt for coordinates
    let (row, col) = loop {
        let input = prompt(&format!(
            "Your turn (turn {}). Enter target (e.g. A5): ",
            turn
        ));
        if let Some(coords) = parse_coordinates(&input) {
            if my_shots
                .iter()
                .any(|(r, c, _)| *r == coords.0 as usize && *c == coords.1 as usize)
            {
                println!("  Already fired there! Try again.");
                continue;
            }
            break coords;
        }
        println!("  Invalid input. Use format like A5, B10, J1.");
    };

    println!("  Firing at {}...", coord_label(row, col));

    let serial = Word::from([
        Felt::new(5000 + turn),
        Felt::new(0),
        Felt::new(0),
        Felt::new(0),
    ]);
    let shot_note = create_note_from_package(
        client,
        pkgs.shot_note.clone(),
        sender.id(),
        NoteCreationConfig {
            inputs: vec![
                Felt::new(row),
                Felt::new(col),
                Felt::new(turn),
                serial[0],
                serial[1],
                serial[2],
                serial[3],
                result_script_root[0],
                result_script_root[1],
                result_script_root[2],
                result_script_root[3],
                my_prefix,
                my_suffix,
                Felt::new(TAG_RESULT as u64), // shooter_tag: result-notes get this tag
            ],
            tag: NoteTag::new(TAG_SHOT_BASE + turn as u32),
            ..Default::default()
        },
    )?;

    publish_note(client, sender.id(), shot_note).await?;
    println!("  Shot published. Waiting for result...");

    // Poll for result-note from opponent's defense
    let result_note = poll_for_result_note(client, seen_ids, 120).await?;
    seen_ids.insert(result_note.id());
    println!();

    // Read result from note inputs: [shooter_prefix, shooter_suffix, turn, encoded_result]
    let result_inputs = result_note.recipient().inputs().values();
    if result_inputs.len() < 4 {
        bail!("Result note has too few inputs");
    }
    let encoded_result = result_inputs[3].as_int();
    let is_hit = encoded_result >= 2; // encoded = result * 2 + game_over
    let is_game_over = encoded_result % 2 == 1;

    my_shots.push((row as usize, col as usize, is_hit));

    if is_hit {
        *opp_ships_hit += 1;
        println!(
            "  HIT! ({}/17 ships hit)",
            opp_ships_hit
        );
    } else {
        println!("  Miss.");
    }

    // Consume the result-note to clean up (optional but good practice)
    // Note: result-note targets us (shooter), so we can consume it
    let _ = consume_note(client, my_account.id(), result_note).await;

    Ok(is_game_over)
}

// ============================================================================
// Defend a shot (opponent's turn)
// ============================================================================

#[allow(clippy::too_many_arguments)]
async fn defend_shot(
    client: &mut Client<FilesystemKeyStore>,
    my_account: &miden_client::account::Account,
    result_script: &NoteScript,
    ship_cells: &[(u64, u64, u64)],
    expected_turn: u64,
    hits_on_me: &mut Vec<(usize, usize, bool)>,
    my_ships_hit: &mut u64,
    cells_hit_on_me: &mut HashSet<(u64, u64)>,
    seen_ids: &mut HashSet<miden_client::note::NoteId>,
) -> Result<bool> {
    println!(
        "  Opponent's turn (turn {}). Waiting for incoming shot...",
        expected_turn
    );

    // Poll for shot-note targeting our account
    let shot_tag = TAG_SHOT_BASE + expected_turn as u32;
    let shot_note = poll_for_note(client, shot_tag, seen_ids, 300).await?;
    seen_ids.insert(shot_note.id());
    println!();

    // Parse shot-note inputs
    let shot_inputs = ShotNoteInputs::from_note(&shot_note)?;
    let row = shot_inputs.row;
    let col = shot_inputs.col;
    println!(
        "  Incoming shot at {}! Processing...",
        coord_label(row, col)
    );

    // Determine result from our board
    let is_hit = ship_cells.iter().any(|(r, c, _)| *r == row && *c == col);
    if is_hit && !cells_hit_on_me.contains(&(row, col)) {
        *my_ships_hit += 1;
        cells_hit_on_me.insert((row, col));
    }
    hits_on_me.push((row as usize, col as usize, is_hit));

    let result: u64 = if is_hit { 1 } else { 0 };
    let game_over: u64 = if *my_ships_hit >= 17 { 1 } else { 0 };
    let encoded = result * 2 + game_over;

    // Build expected result-note recipient
    // Result-note inputs: [shooter_prefix, shooter_suffix, turn, encoded_result]
    let shot_all_inputs = shot_note.recipient().inputs().values();
    let shooter_prefix = shot_all_inputs[11]; // from shot-note input layout
    let shooter_suffix = shot_all_inputs[12];

    let result_inputs =
        NoteInputs::new(vec![shooter_prefix, shooter_suffix, Felt::new(shot_inputs.turn), Felt::new(encoded)])?;
    let result_recipient =
        NoteRecipient::new(shot_inputs.serial, result_script.clone(), result_inputs);

    // Consume the shot-note (this creates the result-note in the VM)
    consume_shot_note(client, my_account.id(), shot_note, result_recipient).await?;

    if is_hit {
        println!(
            "  They HIT your ship! ({}/17)",
            my_ships_hit
        );
        if game_over == 1 {
            println!("  All your ships are sunk!");
        }
    } else {
        println!("  They missed!");
    }

    Ok(game_over == 1)
}
