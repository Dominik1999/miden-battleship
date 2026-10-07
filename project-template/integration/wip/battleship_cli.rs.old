//! Interactive two-terminal battleship on Miden testnet.
//!
//! Each player runs this binary in its own terminal with its own `--player` name (SQLite store
//! and keystore), the same `--game-id` and opposite `--role`s. Every run creates and funds a fresh
//! game account and prints its address for the other player. The challenger fires first.
//!
//! Run: `cd project-template && cargo run --release --bin battleship_cli -- \
//!       --player alice --role challenger --game-id demo`

use std::{
    io::{self, Write},
    time::Duration,
};

use anyhow::{ensure, Context, Result};
use clap::{Parser, ValueEnum};
use integration::battleship::*;
use integration::helpers::*;
use miden_client::{
    account::{AccountId, NetworkId},
    asset::AssetId,
    note::{Note, NoteScript},
    transaction::TransactionScript,
    Felt, Word,
};
use miden_protocol::Hasher;

/// Keep at least this many base units before every transaction.
const MIN_FEE_BALANCE: u64 = 2_000;
/// The opponent is a human in another terminal: wait up to an hour for each of their notes.
const NOTE_TIMEOUT: Duration = Duration::from_secs(3600);
const GRID: usize = GRID_SIZE as usize;

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Role {
    Challenger,
    Acceptor,
}

#[derive(Parser)]
#[command(about = "Interactive two-terminal battleship on Miden testnet")]
struct Args {
    /// Store/keystore name (`testnet-store-<player>.sqlite3`, `testnet-keystore-<player>/`).
    #[arg(long)]
    player: String,
    /// The challenger publishes the challenge note and fires first.
    #[arg(long, value_enum)]
    role: Role,
    /// Shared game identifier; both players must pass the same string.
    #[arg(long)]
    game_id: String,
    /// Opponent's game account (bech32). Prompted on stdin when omitted.
    #[arg(long)]
    opponent: Option<String>,
}

struct Game {
    client: TestnetClient,
    scripts: BattleshipScripts,
    fee_asset: AssetId,
    me: AccountId,
    opponent: AccountId,
    game_id: Word,
    commitment: Word,
    ships: Vec<(u64, u64, u64)>,
    /// Shots the opponent fired at me: (row, col, hit).
    incoming: Vec<(u64, u64, bool)>,
    /// Shots I fired: (row, col, hit).
    outgoing: Vec<(u64, u64, bool)>,
}

impl Game {
    async fn check_funded(&mut self) -> Result<()> {
        ensure_funded(&mut self.client, self.me, self.fee_asset, MIN_FEE_BALANCE).await?;
        Ok(())
    }

    async fn state(&self) -> Result<GameState> {
        Ok(GameState::from_account(
            &tracked_account(&self.client, self.me).await?,
        ))
    }

    /// Publishes a game note from my account to the opponent and waits for it to commit.
    async fn send(&mut self, script: NoteScript, storage: Vec<Felt>) -> Result<Note> {
        let note = make_game_note(script, self.me, self.opponent, storage, random_word())?;
        self.check_funded().await?;
        publish_note(&mut self.client, self.me, note.clone()).await?;
        println!("  note {} committed", note_id_hex(&note));
        Ok(note)
    }

    /// Waits for a note with script root `root` sent by the opponent and consumes it.
    async fn receive_and_consume(&mut self, root: Word, what: &str) -> Result<()> {
        let opponent = self.opponent;
        println!("  waiting for the opponent's {what} note...");
        let note = wait_for_note(&mut self.client, NOTE_TIMEOUT, |n| {
            from_opponent(n, root, opponent)
        })
        .await
        .with_context(|| format!("waiting for the {what} note"))?;
        println!("  consuming {what} note {}...", note_id_hex(&note));
        self.check_funded().await?;
        consume_notes(&mut self.client, self.me, vec![note]).await?;
        Ok(())
    }

    async fn run_script(
        &mut self,
        script: TransactionScript,
        arg: Option<Word>,
        advice_map: Vec<(Word, Vec<Felt>)>,
    ) -> Result<()> {
        self.check_funded().await?;
        run_tx_script(&mut self.client, self.me, script, arg, advice_map).await?;
        Ok(())
    }

    async fn setup(&mut self) -> Result<()> {
        let rows = pack_board(&self.ships);
        let payload = build_setup_payload(self.game_id, self.opponent, self.commitment, &rows);
        let arg = setup_payload_commitment(&payload);
        self.run_script(
            self.scripts.setup_tx.clone(),
            Some(arg),
            vec![(arg, payload)],
        )
        .await?;
        let state = self.state().await?;
        ensure!(
            state.phase == PHASE_CHALLENGED && state.opponent_is(self.opponent),
            "setup left the account in an unexpected state: {state:?}"
        );
        Ok(())
    }

    async fn handshake(&mut self, role: Role) -> Result<()> {
        let storage = handshake_storage(self.game_id, self.me, self.commitment);
        match role {
            Role::Challenger => {
                println!("  publishing the challenge note...");
                self.send(self.scripts.challenge_note.clone(), storage)
                    .await?;
                let root = script_root(&self.scripts.accept_note);
                self.receive_and_consume(root, "accept").await?;
            }
            Role::Acceptor => {
                let root = script_root(&self.scripts.challenge_note);
                self.receive_and_consume(root, "challenge").await?;
                println!("  publishing the accept note...");
                self.send(self.scripts.accept_note.clone(), storage).await?;
            }
        }
        let state = self.state().await?;
        ensure!(
            state.phase == PHASE_ACTIVE && state.opponent_commitment != Word::default(),
            "handshake left the account in an unexpected state: {state:?}"
        );
        Ok(())
    }

    fn prompt_target(&self) -> Result<(u64, u64)> {
        loop {
            let input = prompt("  your shot (column letter + row number, e.g. B7): ")?;
            let Some((row, col)) = parse_coordinate(&input) else {
                println!("  invalid coordinate; use A-J and 1-10, e.g. A5 or J10");
                continue;
            };
            if self.outgoing.iter().any(|(r, c, _)| *r == row && *c == col) {
                println!("  you already fired at {}", coord_label(row, col));
                continue;
            }
            return Ok((row, col));
        }
    }

    /// My turn: publish a shot note and wait for the opponent's result note.
    async fn fire(&mut self, turn: u64) -> Result<ShotResult> {
        let (row, col) = self.prompt_target()?;
        let result_serial = random_word();
        let result_root = self.scripts.result_script_root();
        println!("  firing at {} (turn {turn})...", coord_label(row, col));
        let storage = shot_storage(row, col, turn, result_serial, result_root);
        self.send(self.scripts.shot_note.clone(), storage).await?;
        println!("  waiting for the result note...");
        let note = wait_for_note(&mut self.client, NOTE_TIMEOUT, |n| {
            script_root(n.script()) == result_root && n.recipient().serial_num() == result_serial
        })
        .await
        .context("waiting for the result note")?;
        let parsed = ResultNoteStorage::from_note(&note)?;
        ensure!(
            parsed.turn == turn,
            "result note is for turn {}, expected {turn}",
            parsed.turn
        );
        let result = parsed.result;
        self.outgoing.push((row, col, result.is_hit));
        let outcome = if result.is_hit { "HIT!" } else { "MISS." };
        println!("  {outcome} at {}", coord_label(row, col));
        if result.game_over {
            println!("  all enemy ships are sunk!");
        }
        Ok(result)
    }

    /// Opponent's turn: wait for the shot note and resolve it against my board.
    async fn defend(&mut self, turn: u64) -> Result<ShotResult> {
        let state = self.state().await?;
        ensure!(
            state.expected_turn == turn,
            "account expects incoming turn {}, the game is at turn {turn}",
            state.expected_turn
        );
        let shot_root = script_root(&self.scripts.shot_note);
        let opponent = self.opponent;
        println!("  waiting for the opponent's shot (turn {turn})...");
        let note = wait_for_note(&mut self.client, NOTE_TIMEOUT, |n| {
            from_opponent(n, shot_root, opponent)
                && ShotNoteStorage::from_note(n).is_ok_and(|s| s.turn == turn)
        })
        .await
        .context("waiting for the shot note")?;
        let shot = ShotNoteStorage::from_note(&note)?;
        ensure!(
            shot.result_script_root == self.scripts.result_script_root(),
            "shot note carries an unknown result script root"
        );
        let same_cell = |r: u64, c: u64| r == shot.row && c == shot.col;
        ensure!(
            !self.incoming.iter().any(|&(r, c, _)| same_cell(r, c)),
            "opponent fired at {} twice; the contract rejects repeated shots",
            coord_label(shot.row, shot.col)
        );
        let is_hit = self.ships.iter().any(|&(r, c, _)| same_cell(r, c));
        let hits = self.incoming.iter().filter(|(_, _, h)| *h).count() as u64 + is_hit as u64;
        let result = ShotResult {
            is_hit,
            game_over: is_hit && hits == TOTAL_SHIP_CELLS,
        };
        let outcome = if is_hit { "HIT" } else { "MISS" };
        println!(
            "  opponent fires at {}: {outcome}",
            coord_label(shot.row, shot.col)
        );
        let result_note = expected_result_note(
            self.scripts.result_note.clone(),
            self.me,
            self.opponent,
            turn,
            result,
            shot.result_serial_num,
        )?;
        self.check_funded().await?;
        consume_shot_note(
            &mut self.client,
            self.me,
            note,
            result_note.recipient().clone(),
        )
        .await?;
        println!("  result note {} published", note_id_hex(&result_note));
        self.incoming.push((shot.row, shot.col, is_hit));
        Ok(result)
    }

    /// Reveal phase: the winner enters reveal, then both reveal, mark and verify the opponent.
    async fn reveal(&mut self, i_won: bool) -> Result<()> {
        if i_won {
            println!("  entering the reveal phase...");
            self.run_script(self.scripts.enter_reveal_tx.clone(), None, vec![])
                .await?;
        }
        println!("  publishing my reveal note...");
        let storage = self.commitment.iter().copied().collect();
        self.send(self.scripts.reveal_note.clone(), storage).await?;
        println!("  marking my reveal...");
        self.run_script(self.scripts.mark_my_reveal_tx.clone(), None, vec![])
            .await?;
        let root = script_root(&self.scripts.reveal_note);
        self.receive_and_consume(root, "reveal").await
    }

    fn print_boards(&self) {
        let mine = board_rows(&self.incoming, &self.ships);
        let target = board_rows(&self.outgoing, &[]);
        println!("\n     YOUR BOARD              TARGETING");
        println!("     A B C D E F G H I J     A B C D E F G H I J");
        for (r, (a, b)) in mine.iter().zip(&target).enumerate() {
            println!("  {:>2}{a}    {:>2}{b}", r + 1, r + 1);
        }
        println!("  S=ship X=hit O=miss .=water/unknown");
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn script_root(script: &NoteScript) -> Word {
    Word::from(script.root())
}

fn from_opponent(note: &Note, root: Word, opponent: AccountId) -> bool {
    script_root(note.script()) == root && note.metadata().sender() == opponent
}

/// Four random field elements (a `u64 >> 1` always fits in the field).
fn random_word() -> Word {
    Word::from([(); 4].map(|_| felt(rand::random::<u64>() >> 1)))
}

/// Both players derive the same game id word from the same string.
fn game_id_word(s: &str) -> Word {
    let felts: Vec<Felt> = s.bytes().map(|b| felt(b as u64)).collect();
    Hasher::hash_elements(&felts)
}

fn parse_account(s: &str) -> Result<AccountId> {
    let (network, id) = AccountId::from_bech32(s.trim())
        .map_err(|e| anyhow::anyhow!("invalid account address {s:?}: {e}"))?;
    ensure!(
        network == NetworkId::Testnet,
        "account address {s:?} is not a testnet address"
    );
    Ok(id)
}

fn prompt(msg: &str) -> Result<String> {
    print!("{msg}");
    io::stdout().flush().context("flushing stdout")?;
    let mut input = String::new();
    let read = io::stdin().read_line(&mut input).context("reading stdin")?;
    ensure!(read > 0, "stdin closed");
    Ok(input.trim().to_string())
}

/// Parses "A5" / "j10" into (row, col): letter = column A-J, number = row 1-10.
fn parse_coordinate(input: &str) -> Option<(u64, u64)> {
    let input = input.trim().to_ascii_uppercase();
    let (letter, number) = input.split_at_checked(1)?;
    let col = (letter.as_bytes()[0] as u64).checked_sub(b'A' as u64)?;
    let row = number.parse::<u64>().ok()?.checked_sub(1)?;
    (row < GRID_SIZE && col < GRID_SIZE).then_some((row, col))
}

fn coord_label(row: u64, col: u64) -> String {
    format!("{}{}", (b'A' + col as u8) as char, row + 1)
}

/// One " x x x ..." string per row: ships as S, hits as X, misses as O, the rest as '.'.
fn board_rows(marks: &[(u64, u64, bool)], ships: &[(u64, u64, u64)]) -> Vec<String> {
    let mut board = [['.'; GRID]; GRID];
    for (r, c, _) in ships {
        board[*r as usize][*c as usize] = 'S';
    }
    for (r, c, hit) in marks {
        board[*r as usize][*c as usize] = if *hit { 'X' } else { 'O' };
    }
    board
        .iter()
        .map(|row| row.iter().map(|c| format!(" {c}")).collect())
        .collect()
}

// ============================================================================
// Main
// ============================================================================

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(!args.game_id.is_empty(), "--game-id must not be empty");
    println!("=== Miden Battleship (testnet) ===");
    let ClientSetup { mut client, .. } = setup_testnet_client(&args.player).await?;
    client.sync_state().await.context("initial sync failed")?;
    println!("compiling game scripts...");
    let scripts = BattleshipScripts::compile_with(|| client.code_builder())?;
    let fee_asset = fee_asset_id(&mut client).await?;

    let me = create_game_account(&mut client, &scripts).await?.id();
    println!("\nyour game account: {}", me.to_bech32(NetworkId::Testnet));
    println!("(share this address with your opponent)\n");
    println!("funding from the faucet (this also deploys the account)...");
    let balance = fund_from_faucet(&mut client, me, fee_asset).await?;
    println!("  balance {balance}");

    let opponent = match args.opponent {
        Some(address) => address,
        None => prompt("opponent's game account (bech32): ")?,
    };
    let opponent = parse_account(&opponent)?;
    ensure!(opponent != me, "the opponent cannot be your own account");
    let game_id = game_id_word(&args.game_id);
    let commitment = random_word();
    println!("game id word   {game_id}");
    println!("my commitment  {commitment}");

    let mut game = Game {
        client,
        scripts,
        fee_asset,
        me,
        opponent,
        game_id,
        commitment,
        ships: classic_ship_cells(),
        incoming: Vec::new(),
        outgoing: Vec::new(),
    };

    println!("\n[setup] classic ship placement, running the setup transaction...");
    game.setup().await?;
    println!("\n[handshake]");
    game.handshake(args.role).await?;
    let challenger = args.role == Role::Challenger;
    let first = if challenger { "you" } else { "your opponent" };
    println!("game ACTIVE; first shot: {first}");

    let mut turn = 1;
    let i_won = loop {
        let my_turn = (turn % 2 == 1) == challenger;
        game.print_boards();
        let who = if my_turn {
            "you fire"
        } else {
            "opponent fires"
        };
        println!("\n[turn {turn}] {who}");
        let result = if my_turn {
            game.fire(turn).await?
        } else {
            game.defend(turn).await?
        };
        if result.game_over {
            break my_turn;
        }
        turn += 1;
    };
    game.print_boards();
    let verdict = if i_won { "YOU WIN" } else { "YOU LOSE" };
    println!("\n*** {verdict} ***");

    println!("\n[reveal]");
    game.reveal(i_won).await?;
    let state = game.state().await?;
    let balance = fee_asset_balance(&game.client, me, fee_asset).await?;
    println!(
        "\nfinal phase {}; remaining fee balance {balance}",
        state.phase_name()
    );
    ensure!(
        state.phase == PHASE_COMPLETE && state.my_revealed == 1 && state.opponent_verified == 1,
        "game did not complete: {state:?}"
    );
    println!("Thanks for playing Miden Battleship!");
    Ok(())
}
