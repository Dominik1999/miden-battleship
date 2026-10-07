//! Interactive two-terminal battleship on Miden testnet, with private boards and stakes.
//!
//! Each player runs this binary in its own terminal with its own `--player` name (SQLite store
//! and keystore), the same `--game-id` and opposite `--role`s. Every run creates and funds a
//! fresh private game account and a public wallet, and prints the game account's address for
//! the other player. The challenger fires first. Every move is one transaction: it consumes the
//! opponent's pending notes (the result of my last shot, their shot at me) and fires the next
//! shot. An opponent who does not move within 12 hours forfeits: the waiting player reclaims the
//! unanswered note, which sends a forfeit note to its wallet.
//!
//! With `--stake <units>` both wallets publish a stake note after the handshake; the winner's
//! wallet claims both stakes together with the defeat or forfeit note.
//!
//! Run: `cd project-template && cargo run --release --bin battleship_cli -- \
//!       --player alice --role challenger --game-id demo --stake 2000`

use std::{
    io::{self, Write},
    time::{Duration, Instant},
};

use anyhow::{bail, ensure, Context, Result};
use clap::{Parser, ValueEnum};
use integration::battleship::*;
use integration::helpers::*;
use miden_client::{
    account::{AccountId, NetworkId},
    asset::AssetId,
    note::Note,
    store::NoteFilter,
    Felt, Word,
};
use miden_protocol::Hasher;

/// Keep at least this many base units before every transaction.
const MIN_FEE_BALANCE: u64 = 2_000;
/// The opponent is a human in another terminal: poll until their note arrives or the deadline
/// of my own pending note passes.
const POLL_INTERVAL: Duration = Duration::from_secs(5);
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
    /// Stake in fee-asset base units (both players must pass the same value; 0 = no stake).
    #[arg(long, default_value_t = 0)]
    stake: u64,
}

struct Game {
    client: TestnetClient,
    scripts: BattleshipScripts,
    fee_asset: AssetId,
    me: AccountId,
    seed: Word,
    wallet: AccountId,
    opponent: AccountId,
    game_id: Word,
    ships: Vec<(u64, u64, u64)>,
    /// Shots the opponent fired at me: (row, col, hit).
    incoming: Vec<(u64, u64, bool)>,
    /// Shots I fired: (row, col, hit).
    outgoing: Vec<(u64, u64, bool)>,
    /// My last unanswered note (a shot or the result note my account created), for a reclaim.
    pending: Option<Note>,
    my_stake: Option<Note>,
    opp_stake: Option<Note>,
}

impl Game {
    async fn check_funded(&mut self, account: AccountId) -> Result<()> {
        ensure_funded(&mut self.client, account, self.fee_asset, MIN_FEE_BALANCE).await?;
        Ok(())
    }

    async fn state(&self) -> Result<GameState> {
        game_state(&self.client, self.me).await
    }

    fn opp_wallet(&self, state: &GameState) -> Result<AccountId> {
        state
            .opponent_wallet
            .context("the opponent's wallet is stored by the handshake")
    }

    /// Syncs until a note matching `predicate` arrives (`Some`), or until my pending note's
    /// deadline passes (`deadline`, a block timestamp) without an answer (`None`).
    async fn wait(
        &mut self,
        what: &str,
        deadline: Option<u64>,
        mut predicate: impl FnMut(&Note) -> bool,
    ) -> Result<Option<Note>> {
        println!("  waiting for the opponent's {what}...");
        let mut last_report = Instant::now();
        loop {
            self.client.sync_state().await.context("sync failed")?;
            for record in self.client.get_input_notes(NoteFilter::Committed).await? {
                let Ok(note) = TryInto::<Note>::try_into(record) else {
                    continue;
                };
                if predicate(&note) {
                    return Ok(Some(note));
                }
            }
            if let Some(deadline) = deadline {
                let now = self.client.get_latest_block_header().await?.timestamp() as u64;
                if now > deadline {
                    return Ok(None);
                }
                if last_report.elapsed() > Duration::from_secs(300) {
                    println!(
                        "  still waiting; the opponent forfeits in {} min",
                        (deadline - now) / 60
                    );
                    last_report = Instant::now();
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    async fn setup(&mut self) -> Result<()> {
        self.check_funded(self.me).await?;
        let (me, opponent, wallet, game_id) = (self.me, self.opponent, self.wallet, self.game_id);
        let scripts = self.scripts.clone();
        setup_game(&mut self.client, &scripts, me, opponent, wallet, game_id).await?;
        let state = self.state().await?;
        ensure!(
            state.phase == PHASE_CHALLENGED && state.opponent_is(self.opponent),
            "setup left the account in an unexpected state: {state:?}"
        );
        Ok(())
    }

    /// Publishes my challenge or accept note.
    async fn send_handshake(&mut self, challenge: bool) -> Result<Note> {
        let script = if challenge {
            self.scripts.challenge_note.clone()
        } else {
            self.scripts.accept_note.clone()
        };
        let roots = self.scripts.roots();
        let storage = handshake_storage(self.game_id, self.me, self.seed, self.wallet, &roots);
        let note = make_game_note(script, self.me, self.opponent, storage, random_word())?;
        self.check_funded(self.me).await?;
        publish_note(&mut self.client, self.me, note.clone()).await?;
        println!("  note {} committed", note_id_hex(&note));
        Ok(note)
    }

    /// One move: consume `pending` (opponent notes) and optionally fire. Returns the shot note
    /// and the notes my account created while resolving an opponent shot.
    async fn play(
        &mut self,
        pending: &[Note],
        fire_at: Option<(u64, u64)>,
    ) -> Result<(Option<Note>, Vec<Note>)> {
        self.check_funded(self.me).await?;
        let scripts = self.scripts.clone();
        let (me, opponent) = (self.me, self.opponent);
        let mut mv = Move::default();
        let mut created = vec![];
        for note in pending {
            if note.script().root() == scripts.shot_note.root() {
                let (args, result, defeat) =
                    plan_resolution(&mut self.client, &scripts, me, note).await?;
                mv.inputs.push((note.clone(), Some(args)));
                mv.expected.push(result.clone());
                created.push(result);
                if let Some(defeat) = defeat {
                    mv.expected.push(defeat.clone());
                    created.push(defeat);
                }
            } else {
                mv.inputs.push((note.clone(), None));
            }
        }
        let mut shot = None;
        if let Some((row, col)) = fire_at {
            let (args, note) =
                plan_shot(&mut self.client, &scripts, me, opponent, row, col).await?;
            mv.fire = Some(args);
            mv.expected.push(note.clone());
            shot = Some(note);
        }
        submit_move(&mut self.client, &scripts, me, mv).await?;
        Ok((shot, created))
    }

    async fn handshake(&mut self, role: Role) -> Result<()> {
        let opponent = self.opponent;
        match role {
            Role::Challenger => {
                println!("  publishing the challenge note...");
                self.send_handshake(true).await?;
                let root = self.scripts.accept_note.root();
                let accept = self
                    .wait("accept note", None, |n| {
                        n.script().root() == root && n.metadata().sender() == opponent
                    })
                    .await?
                    .context("no deadline")?;
                // the acceptance is consumed by my first move (see `main`)
                self.pending = Some(accept);
            }
            Role::Acceptor => {
                let root = self.scripts.challenge_note.root();
                let challenge = self
                    .wait("challenge note", None, |n| {
                        n.script().root() == root && n.metadata().sender() == opponent
                    })
                    .await?
                    .context("no deadline")?;
                println!("  consuming the challenge note...");
                self.play(&[challenge], None).await?;
                println!("  publishing the accept note...");
                self.send_handshake(false).await?;
            }
        }
        Ok(())
    }

    /// Both wallets stake: publish mine, wait for the opponent's.
    async fn stake(&mut self, amount: u64) -> Result<()> {
        let state = self.state().await?;
        let opp_wallet = self.opp_wallet(&state)?;
        self.check_funded(self.wallet).await?;
        let parties = StakeParties {
            my_wallet: self.wallet,
            my_game: self.me,
            opp_wallet,
            opp_game: self.opponent,
        };
        let scripts = self.scripts.clone();
        println!("  publishing my stake note ({amount} base units)...");
        let mine = stake(&mut self.client, &scripts, parties, self.fee_asset, amount).await?;
        self.my_stake = Some(mine);
        let root = self.scripts.stake_note.root();
        let theirs = self
            .wait("stake note", None, |n| {
                n.script().root() == root && n.metadata().sender() == opp_wallet
            })
            .await?
            .context("no deadline")?;
        let stake_amount: u64 = theirs
            .assets()
            .iter()
            .filter(|a| a.is_fungible())
            .map(|a| a.unwrap_fungible().amount().as_u64())
            .sum();
        ensure!(
            stake_amount >= amount,
            "the opponent staked only {stake_amount} base units"
        );
        println!(
            "  opponent's stake note {} holds {stake_amount}",
            note_id_hex(&theirs)
        );
        self.opp_stake = Some(theirs);
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

    /// Records the opponent's shot locally and prints it.
    fn note_incoming(&mut self, shot: &Note) -> Result<()> {
        let parsed = ShotNoteStorage::from_note(shot)?;
        let is_hit = self
            .ships
            .iter()
            .any(|&(r, c, _)| r == parsed.row && c == parsed.col);
        println!(
            "  opponent fires at {}: {}",
            coord_label(parsed.row, parsed.col),
            if is_hit { "HIT" } else { "MISS" }
        );
        self.incoming.push((parsed.row, parsed.col, is_hit));
        Ok(())
    }

    /// Records the result of my last shot locally and prints it.
    fn note_result(&mut self, result: &Note) -> Result<ShotResult> {
        let parsed = ResultNoteStorage::from_note(result)?;
        let (row, col, _) = *self.outgoing.last().context("a result answers a shot")?;
        self.outgoing.last_mut().expect("just checked").2 = parsed.result.is_hit;
        let outcome = if parsed.result.is_hit {
            "HIT!"
        } else {
            "MISS."
        };
        println!("  {outcome} at {}", coord_label(row, col));
        if parsed.result.game_over {
            println!("  all enemy ships are sunk!");
        }
        Ok(parsed.result)
    }

    /// The opponent walked away: reclaim my pending note and let my wallet claim the forfeit.
    async fn claim_forfeit(&mut self) -> Result<()> {
        let pending = self.pending.take().context("a pending note")?;
        println!(
            "  the opponent did not answer in time; reclaiming note {}...",
            note_id_hex(&pending)
        );
        self.check_funded(self.me).await?;
        let scripts = self.scripts.clone();
        let forfeit = reclaim(&mut self.client, &scripts, self.me, pending).await?;
        self.claim_prize(forfeit).await
    }

    /// My wallet consumes the defeat/forfeit note together with both stakes.
    async fn claim_prize(&mut self, proof: Note) -> Result<()> {
        let proof = self.wait_for_wallet_note(&proof).await?;
        let mut notes = vec![proof];
        notes.extend(self.my_stake.take());
        notes.extend(self.opp_stake.take());
        let before = fee_asset_balance(&self.client, self.wallet, self.fee_asset).await?;
        self.check_funded(self.wallet).await?;
        println!("  wallet claims {} note(s)...", notes.len());
        claim(&mut self.client, self.wallet, notes).await?;
        let after = fee_asset_balance(&self.client, self.wallet, self.fee_asset).await?;
        println!("  wallet balance {before} -> {after}");
        Ok(())
    }

    /// Waits until my own client has the wallet note (created by the opponent's or my own game
    /// account) as a committed input note.
    async fn wait_for_wallet_note(&mut self, note: &Note) -> Result<Note> {
        let id = note.id();
        self.wait("wallet note", None, |n| n.id() == id)
            .await?
            .context("no deadline")
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

fn deadline_of(note: &Note) -> Option<u64> {
    let storage = note.storage().items();
    match storage.len() {
        SHOT_NUM_STORAGE_ITEMS => Some(storage[3].as_canonical_u64()),
        RESULT_NUM_STORAGE_ITEMS => Some(storage[4].as_canonical_u64()),
        _ => None,
    }
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

    let account = create_game_account(&mut client, &scripts).await?;
    let me = account.id();
    let seed = account.seed().context("a new account carries its seed")?;
    let wallet = create_wallet_account(&mut client).await?.id();
    println!("\nyour game account: {}", me.to_bech32(NetworkId::Testnet));
    println!(
        "your wallet:       {}",
        wallet.to_bech32(NetworkId::Testnet)
    );
    println!("(share the game account address with your opponent)\n");
    println!("funding the game account from the faucet (this also deploys it)...");
    let balance = fund_from_faucet(&mut client, me, fee_asset).await?;
    println!("  balance {balance}");
    println!("funding the wallet from the faucet...");
    let balance = fund_from_faucet(&mut client, wallet, fee_asset).await?;
    println!("  balance {balance}");

    let opponent = match args.opponent {
        Some(address) => address,
        None => prompt("opponent's game account (bech32): ")?,
    };
    let opponent = parse_account(&opponent)?;
    ensure!(opponent != me, "the opponent cannot be your own account");
    let game_id = game_id_word(&args.game_id);
    println!("game id word {game_id}");

    let mut game = Game {
        client,
        scripts,
        fee_asset,
        me,
        seed,
        wallet,
        opponent,
        game_id,
        ships: classic_ship_cells(),
        incoming: Vec::new(),
        outgoing: Vec::new(),
        pending: None,
        my_stake: None,
        opp_stake: None,
    };

    println!("\n[setup] classic ship placement, running the setup transaction...");
    game.setup().await?;
    println!("\n[handshake]");
    game.handshake(args.role).await?;
    if args.stake > 0 {
        println!("\n[stake]");
        game.stake(args.stake).await?;
    }
    let challenger = args.role == Role::Challenger;
    let first = if challenger { "you" } else { "your opponent" };
    println!("game ACTIVE; first shot: {first}");

    let shot_root = game.scripts.shot_note.root();
    let result_root = game.scripts.result_note.root();
    // the challenger's first move consumes the accept note; the acceptor's waits for a shot
    let mut to_consume: Vec<Note> = game.pending.take().into_iter().collect();
    let mut i_fired = false;
    let verdict = loop {
        game.print_boards();
        if !i_fired && !challenger || i_fired {
            // wait for the opponent's answer: the result of my shot (if any) and their shot
            let my_deadline = game.pending.as_ref().and_then(deadline_of);
            if i_fired {
                let turn = game.outgoing.len() as u64;
                let mine = game.me;
                match game
                    .wait("result note", my_deadline, |n| {
                        n.script().root() == result_root
                            && n.metadata().sender() == opponent
                            && ResultNoteStorage::from_note(n).is_ok_and(|r| r.shooter == mine)
                    })
                    .await?
                {
                    Some(result) => {
                        let outcome = game.note_result(&result)?;
                        to_consume.push(result);
                        if outcome.game_over {
                            println!(
                                "\n*** YOU WIN (turn {}) ***",
                                2 * turn - if challenger { 1 } else { 0 }
                            );
                            game.play(&to_consume, None).await?;
                            let defeat =
                                expected_defeat_note(&game.scripts, opponent, game.wallet)?;
                            game.claim_prize(defeat).await?;
                            break "YOU WIN";
                        }
                    }
                    None => {
                        game.claim_forfeit().await?;
                        break "YOU WIN BY FORFEIT";
                    }
                }
            }
            match game
                .wait("shot", my_deadline, |n| {
                    n.script().root() == shot_root && n.metadata().sender() == opponent
                })
                .await?
            {
                Some(shot) => {
                    game.note_incoming(&shot)?;
                    to_consume.push(shot);
                }
                None => {
                    game.claim_forfeit().await?;
                    break "YOU WIN BY FORFEIT";
                }
            }
        }
        let hits = game.incoming.iter().filter(|(_, _, h)| *h).count() as u64;
        if hits == TOTAL_SHIP_CELLS {
            // my account creates the final result and the defeat note; nothing left to fire
            println!("\n*** YOU LOSE ***");
            game.play(&to_consume, None).await?;
            break "YOU LOSE";
        }
        let (row, col) = game.prompt_target()?;
        println!("  firing at {}...", coord_label(row, col));
        let (shot, created) = game.play(&to_consume, Some((row, col))).await?;
        to_consume.clear();
        game.outgoing.push((row, col, false));
        game.pending = shot;
        // if I also resolved a shot, the opponent must answer the result note before my shot;
        // the result note deadline is the earlier one, so track it for the forfeit check
        if let Some(result) = created.first() {
            if deadline_of(result) < game.pending.as_ref().and_then(deadline_of) {
                game.pending = Some(result.clone());
            }
        }
        i_fired = true;
    };
    game.print_boards();
    let state = game.state().await?;
    let balance = fee_asset_balance(&game.client, me, fee_asset).await?;
    println!(
        "\n*** {verdict} *** final phase {} (outcome {}); remaining fee balance {balance}",
        state.phase_name(),
        state.outcome
    );
    if state.phase != PHASE_COMPLETE {
        bail!("game did not complete: {state:?}");
    }
    println!("Thanks for playing Miden Battleship!");
    Ok(())
}
