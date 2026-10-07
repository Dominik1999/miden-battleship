//! Plays a full battleship game between two fresh game accounts on testnet and asserts the
//! on-chain state after every step. This is the gate for frontend work: the browser mirrors
//! exactly this flow (same MASM, same notes, same fee handling).
//!
//! Each player has its own client (store + keystore), exactly like two browsers, so note
//! discovery between players goes through the node's tag sync and not through a shared store.
//!
//! Run: `cd project-template && cargo run --bin validate_testnet --release`
//! State lives in `testnet-store-validate-{a,b}.sqlite3` / `testnet-keystore-validate-{a,b}/`.

use std::time::{Duration, Instant};

use anyhow::{ensure, Context, Result};
use integration::battleship::*;
use integration::helpers::*;
use miden_client::{
    account::{AccountId, NetworkId},
    asset::AssetId,
    note::Note,
    Word,
};

const GAME_ID: [u64; 4] = [10, 20, 30, 40];
const A_COMMITMENT: [u64; 4] = [100, 200, 300, 400];
const B_COMMITMENT: [u64; 4] = [500, 600, 700, 800];
/// Keep at least this many base units on each account (a shot round costs ~2 transactions).
const MIN_FEE_BALANCE: u64 = 2_000;
const NOTE_TIMEOUT: Duration = Duration::from_secs(240);

struct Player {
    label: &'static str,
    client: TestnetClient,
    id: AccountId,
}

struct Validator {
    scripts: BattleshipScripts,
    fee_asset: AssetId,
    a: Player,
    b: Player,
    next_serial: u64,
    started: Instant,
}

impl Validator {
    fn player(&mut self, id: AccountId) -> &mut Player {
        if id == self.a.id {
            &mut self.a
        } else {
            &mut self.b
        }
    }

    fn opponent_of(&self, id: AccountId) -> AccountId {
        if id == self.a.id {
            self.b.id
        } else {
            self.a.id
        }
    }

    fn serial(&mut self) -> Word {
        self.next_serial += 1;
        word([self.next_serial, 0, 0, 0])
    }

    fn step(&self, label: &str) {
        println!("\n[{:>5.0}s] {label}", self.started.elapsed().as_secs_f64());
    }

    async fn state(&mut self, id: AccountId) -> Result<GameState> {
        let player = self.player(id);
        Ok(GameState::from_account(
            &tracked_account(&player.client, id).await?,
        ))
    }

    async fn check_funded(&mut self, id: AccountId) -> Result<()> {
        let fee_asset = self.fee_asset;
        let player = self.player(id);
        ensure_funded(&mut player.client, id, fee_asset, MIN_FEE_BALANCE).await?;
        Ok(())
    }

    async fn run_script(
        &mut self,
        id: AccountId,
        script: miden_client::transaction::TransactionScript,
    ) -> Result<()> {
        self.check_funded(id).await?;
        let player = self.player(id);
        run_tx_script(&mut player.client, id, script, None, vec![]).await?;
        Ok(())
    }

    async fn setup(&mut self, id: AccountId, commitment: [u64; 4]) -> Result<()> {
        let opponent = self.opponent_of(id);
        self.check_funded(id).await?;
        let rows = pack_board(&classic_ship_cells());
        let payload = build_setup_payload(word(GAME_ID), opponent, word(commitment), &rows);
        let key = setup_payload_commitment(&payload);
        let script = self.scripts.setup_tx.clone();
        let player = self.player(id);
        run_tx_script(
            &mut player.client,
            id,
            script,
            Some(key),
            vec![(key, payload)],
        )
        .await?;
        let state = self.state(id).await?;
        ensure!(
            state.phase == PHASE_CHALLENGED,
            "setup: phase is {}",
            state.phase_name()
        );
        ensure!(state.game_id == word(GAME_ID), "setup: game id mismatch");
        ensure!(
            state.board_commitment == word(commitment),
            "setup: commitment mismatch"
        );
        ensure!(state.opponent_is(opponent), "setup: opponent mismatch");
        Ok(())
    }

    /// Publishes `note` from `from`'s account and waits until the *target* player's client
    /// discovers it (via the account-target tag). Returns the note as seen by the target.
    async fn send(&mut self, from: AccountId, note: Note) -> Result<Note> {
        self.check_funded(from).await?;
        let sender = self.player(from);
        publish_note(&mut sender.client, from, note.clone()).await?;
        let target = self.opponent_of(from);
        let id = note.id();
        let receiver = self.player(target);
        let t0 = Instant::now();
        let found = wait_for_note(&mut receiver.client, NOTE_TIMEOUT, |n| n.id() == id).await?;
        println!(
            "  {} discovered note {} after {:.0}s",
            receiver.label,
            note_id_hex(&note),
            t0.elapsed().as_secs_f64()
        );
        Ok(found)
    }

    async fn consume(&mut self, id: AccountId, note: &Note) -> Result<()> {
        self.check_funded(id).await?;
        let player = self.player(id);
        consume_notes(&mut player.client, id, vec![note.clone()]).await?;
        Ok(())
    }

    /// Fires at (row, col) from `shooter`; the defender resolves it and the shooter waits for the
    /// result note. Returns the decoded result.
    async fn fire(
        &mut self,
        shooter: AccountId,
        row: u64,
        col: u64,
        turn: u64,
        expected: ShotResult,
    ) -> Result<ShotResult> {
        let defender = self.opponent_of(shooter);
        let serial = self.serial();
        let result_serial = self.serial();
        let shot = make_game_note(
            self.scripts.shot_note.clone(),
            shooter,
            defender,
            shot_storage(
                row,
                col,
                turn,
                result_serial,
                self.scripts.result_script_root(),
            ),
            serial,
        )?;
        let shot = self.send(shooter, shot).await?;
        let parsed = ShotNoteStorage::from_note(&shot)?;
        ensure!(
            parsed.turn == turn && parsed.row == row && parsed.col == col,
            "shot note storage mismatch"
        );

        // the defender knows its own board, so it can declare the exact result note
        let result_note = expected_result_note(
            self.scripts.result_note.clone(),
            defender,
            shooter,
            turn,
            expected,
            result_serial,
        )?;
        self.check_funded(defender).await?;
        let d = self.player(defender);
        consume_shot_note(
            &mut d.client,
            defender,
            shot,
            result_note.recipient().clone(),
        )
        .await?;

        // the shooter discovers the result note during sync
        let result_id = result_note.id();
        let s = self.player(shooter);
        let note = wait_for_note(&mut s.client, NOTE_TIMEOUT, |n| n.id() == result_id).await?;
        let parsed = ResultNoteStorage::from_note(&note)?;
        ensure!(
            parsed.turn == turn,
            "result note turn {} != {turn}",
            parsed.turn
        );
        ensure!(
            parsed.result == expected,
            "result {:?} != expected {expected:?}",
            parsed.result
        );
        Ok(parsed.result)
    }

    async fn reveal_note(&mut self, from: AccountId, commitment: [u64; 4]) -> Result<Note> {
        let to = self.opponent_of(from);
        let serial = self.serial();
        make_game_note(
            self.scripts.reveal_note.clone(),
            from,
            to,
            word(commitment).iter().copied().collect(),
            serial,
        )
    }
}

async fn new_player(
    label: &'static str,
    name: &str,
    scripts: &BattleshipScripts,
) -> Result<Player> {
    let ClientSetup { mut client, .. } = setup_testnet_client(name).await?;
    client.sync_state().await.context("initial sync failed")?;
    let id = create_game_account(&mut client, scripts).await?.id();
    println!("player {label}: {}", id.to_bech32(NetworkId::Testnet));
    Ok(Player { label, client, id })
}

#[tokio::main]
async fn main() -> Result<()> {
    let started = Instant::now();
    println!("Battleship testnet validation");
    let scripts = BattleshipScripts::compile()?;
    println!(
        "result note script root: {:?}",
        scripts
            .result_script_root()
            .iter()
            .map(|f| f.as_canonical_u64())
            .collect::<Vec<_>>()
    );
    let mut a = new_player("A", "validate-a", &scripts).await?;
    let b = new_player("B", "validate-b", &scripts).await?;
    let fee_asset = fee_asset_id(&mut a.client).await?;
    println!(
        "fee asset: {}",
        fee_asset.faucet_id().to_bech32(NetworkId::Testnet)
    );

    let mut v = Validator {
        scripts,
        fee_asset,
        a,
        b,
        next_serial: 0,
        started,
    };
    let (a, b) = (v.a.id, v.b.id);

    v.step("funding both game accounts from the faucet (deploys them)");
    let balance_a = fund_from_faucet(&mut v.a.client, a, fee_asset).await?;
    let balance_b = fund_from_faucet(&mut v.b.client, b, fee_asset).await?;
    println!("  A balance {balance_a}, B balance {balance_b}");
    ensure!(balance_a > 0 && balance_b > 0, "faucet funding failed");

    v.step("board setup on both accounts");
    v.setup(a, A_COMMITMENT).await?;
    v.setup(b, B_COMMITMENT).await?;

    v.step("handshake: A challenges, B accepts");
    let serial = v.serial();
    let challenge = make_game_note(
        v.scripts.challenge_note.clone(),
        a,
        b,
        handshake_storage(word(GAME_ID), a, word(A_COMMITMENT)),
        serial,
    )?;
    let challenge = v.send(a, challenge).await?;
    v.consume(b, &challenge).await?;
    let sb = v.state(b).await?;
    ensure!(
        sb.phase == PHASE_ACTIVE && sb.expected_turn == ACCEPTOR_FIRST_TURN,
        "B after challenge: {sb:?}"
    );
    ensure!(
        sb.opponent_commitment == word(A_COMMITMENT),
        "B stored the wrong commitment"
    );

    let serial = v.serial();
    let accept = make_game_note(
        v.scripts.accept_note.clone(),
        b,
        a,
        handshake_storage(word(GAME_ID), b, word(B_COMMITMENT)),
        serial,
    )?;
    let accept = v.send(b, accept).await?;
    v.consume(a, &accept).await?;
    let sa = v.state(a).await?;
    ensure!(
        sa.phase == PHASE_ACTIVE && sa.expected_turn == CHALLENGER_FIRST_TURN,
        "A after accept: {sa:?}"
    );
    ensure!(
        sa.opponent_commitment == word(B_COMMITMENT),
        "A stored the wrong commitment"
    );

    v.step("gameplay: A sinks B's fleet, B misses in between");
    let cells = classic_ship_cells();
    let hit = ShotResult {
        is_hit: true,
        game_over: false,
    };
    let miss = ShotResult {
        is_hit: false,
        game_over: false,
    };
    for (i, (row, col, _)) in cells.iter().enumerate() {
        let last = i == cells.len() - 1;
        let turn = i as u64 * 2 + 1;
        println!("  turn {turn}: A fires at ({row}, {col})");
        v.fire(
            a,
            *row,
            *col,
            turn,
            ShotResult {
                game_over: last,
                ..hit
            },
        )
        .await?;
        if !last {
            let (brow, bcol) = (9 - i as u64 / 10, i as u64 % 10);
            println!("  turn {}: B fires at ({brow}, {bcol})", turn + 1);
            v.fire(b, brow, bcol, turn + 1, miss).await?;
        }
    }
    let sb = v.state(b).await?;
    ensure!(
        sb.phase == PHASE_REVEAL,
        "B after 17 hits: {}",
        sb.phase_name()
    );
    ensure!(
        sb.ships_hit_count == TOTAL_SHIP_CELLS && sb.total_shots_received == TOTAL_SHIP_CELLS,
        "B counters: {sb:?}"
    );
    let account_b = tracked_account(&v.b.client, b).await?;
    ensure!(
        read_board_cell(&account_b, 0, 0) == CELL_HIT,
        "B cell (0,0) is not HIT"
    );
    let account_a = tracked_account(&v.a.client, a).await?;
    ensure!(
        read_board_cell(&account_a, 9, 0) == CELL_MISS,
        "A cell (9,0) is not MISS"
    );

    v.step("reveal: A enters reveal, both reveal and verify");
    let enter_reveal = v.scripts.enter_reveal_tx.clone();
    v.run_script(a, enter_reveal).await?;
    ensure!(
        v.state(a).await?.phase == PHASE_REVEAL,
        "A did not enter reveal"
    );

    let reveal_a = v.reveal_note(a, A_COMMITMENT).await?;
    let reveal_a = v.send(a, reveal_a).await?;
    let mark = v.scripts.mark_my_reveal_tx.clone();
    v.run_script(a, mark.clone()).await?;

    let reveal_b = v.reveal_note(b, B_COMMITMENT).await?;
    let reveal_b = v.send(b, reveal_b).await?;
    v.run_script(b, mark).await?;

    v.consume(b, &reveal_a).await?;
    ensure!(
        v.state(b).await?.phase == PHASE_COMPLETE,
        "B did not complete"
    );
    v.consume(a, &reveal_b).await?;
    ensure!(
        v.state(a).await?.phase == PHASE_COMPLETE,
        "A did not complete"
    );

    let balance_a = fee_asset_balance(&v.a.client, a, fee_asset).await?;
    let balance_b = fee_asset_balance(&v.b.client, b, fee_asset).await?;
    v.step(&format!(
        "DONE: both accounts COMPLETE; remaining fee balance A {balance_a}, B {balance_b}"
    ));
    Ok(())
}
