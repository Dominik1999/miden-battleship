//! Plays a full staked battleship game between two players on testnet and asserts the state
//! after every step. This is the gate for frontend work: the browser mirrors exactly this flow
//! (same MASM, same notes, same transactions, same fee handling).
//!
//! Each player has its own client (store + keystore) with a private game account and a public
//! wallet, exactly like two browsers: note discovery between players goes through the node's
//! tag sync, never through a shared store.
//!
//! The forfeit path needs a 12-hour deadline to pass and is covered by the MockChain tests only.
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
/// Keep at least this many base units on each account (a move costs ~105).
const MIN_FEE_BALANCE: u64 = 2_000;
const NOTE_TIMEOUT: Duration = Duration::from_secs(240);

struct Player {
    label: &'static str,
    client: TestnetClient,
    id: AccountId,
    seed: Word,
    wallet: AccountId,
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
        word([self.next_serial, 7, 7, 7])
    }

    fn step(&self, label: &str) {
        println!("\n[{:>5.0}s] {label}", self.started.elapsed().as_secs_f64());
    }

    async fn state(&mut self, id: AccountId) -> Result<GameState> {
        let player = self.player(id);
        game_state(&player.client, id).await
    }

    async fn check_funded(&mut self, game: AccountId, account: AccountId) -> Result<()> {
        let fee_asset = self.fee_asset;
        let player = self.player(game);
        ensure_funded(&mut player.client, account, fee_asset, MIN_FEE_BALANCE).await?;
        Ok(())
    }

    async fn setup(&mut self, id: AccountId) -> Result<()> {
        let opponent = self.opponent_of(id);
        self.check_funded(id, id).await?;
        let scripts = self.scripts.clone();
        let player = self.player(id);
        let wallet = player.wallet;
        setup_game(
            &mut player.client,
            &scripts,
            id,
            opponent,
            wallet,
            word(GAME_ID),
        )
        .await?;
        let state = self.state(id).await?;
        ensure!(
            state.phase == PHASE_CHALLENGED,
            "setup: phase is {}",
            state.phase_name()
        );
        ensure!(state.game_id == word(GAME_ID), "setup: game id mismatch");
        ensure!(state.opponent_is(opponent), "setup: opponent mismatch");
        ensure!(
            state.owner_wallet == Some(wallet),
            "setup: owner wallet mismatch"
        );
        Ok(())
    }

    /// Waits until `receiver`'s client discovers `note` (via the account-target tag).
    async fn discover(&mut self, receiver: AccountId, note: &Note) -> Result<Note> {
        let id = note.id();
        let t0 = Instant::now();
        let player = self.player(receiver);
        let found = wait_for_note(&mut player.client, NOTE_TIMEOUT, |n| n.id() == id).await?;
        println!(
            "  {} discovered note {} after {:.0}s",
            player.label,
            note_id_hex(note),
            t0.elapsed().as_secs_f64()
        );
        Ok(found)
    }

    /// Publishes a handshake note from `from`'s game account and waits for the opponent to see it.
    async fn send_handshake(&mut self, from: AccountId, challenge: bool) -> Result<Note> {
        let script = if challenge {
            self.scripts.challenge_note.clone()
        } else {
            self.scripts.accept_note.clone()
        };
        let to = self.opponent_of(from);
        let serial = self.serial();
        let roots = self.scripts.roots();
        let sender = self.player(from);
        let storage = handshake_storage(word(GAME_ID), from, sender.seed, sender.wallet, &roots);
        let note = make_game_note(script, from, to, storage, serial)?;
        self.check_funded(from, from).await?;
        let sender = self.player(from);
        publish_note(&mut sender.client, from, note.clone()).await?;
        self.discover(to, &note).await
    }

    /// `shooter` plays one move: consumes `pending` (result and/or shot notes from the opponent)
    /// and fires at (row, col). Returns the shot note, and the result/defeat notes created for
    /// any opponent shot consumed in the move.
    async fn play(
        &mut self,
        shooter: AccountId,
        pending: &[Note],
        fire_at: Option<(u64, u64)>,
    ) -> Result<(Option<Note>, Vec<Note>)> {
        let opponent = self.opponent_of(shooter);
        self.check_funded(shooter, shooter).await?;
        let scripts = self.scripts.clone();
        let player = self.player(shooter);
        let mut mv = Move::default();
        let mut created = vec![];
        for note in pending {
            if note.script().root() == scripts.shot_note.root() {
                let (args, result, defeat) =
                    plan_resolution(&mut player.client, &scripts, shooter, note).await?;
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
                plan_shot(&mut player.client, &scripts, shooter, opponent, row, col).await?;
            mv.fire = Some(args);
            mv.expected.push(note.clone());
            shot = Some(note);
        }
        submit_move(&mut player.client, &scripts, shooter, mv).await?;
        Ok((shot, created))
    }
}

async fn new_player(
    label: &'static str,
    name: &str,
    scripts: &BattleshipScripts,
) -> Result<Player> {
    let ClientSetup { mut client, .. } = setup_testnet_client(name).await?;
    client.sync_state().await.context("initial sync failed")?;
    let account = create_game_account(&mut client, scripts).await?;
    let seed = account.seed().context("a new account carries its seed")?;
    let wallet = create_wallet_account(&mut client).await?.id();
    println!(
        "player {label}: game {} (private), wallet {}",
        account.id().to_bech32(NetworkId::Testnet),
        wallet.to_bech32(NetworkId::Testnet)
    );
    Ok(Player {
        label,
        client,
        id: account.id(),
        seed,
        wallet,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let started = Instant::now();
    println!("Battleship testnet validation (private accounts, stakes)");
    let scripts = BattleshipScripts::compile()?;
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
    let (wallet_a, wallet_b) = (v.a.wallet, v.b.wallet);

    v.step("funding both game accounts and both wallets from the faucet (deploys them)");
    for (game, account) in [(a, a), (a, wallet_a), (b, b), (b, wallet_b)] {
        let player = v.player(game);
        let balance = fund_from_faucet(&mut player.client, account, fee_asset).await?;
        println!(
            "  {} balance {balance}",
            account.to_bech32(NetworkId::Testnet)
        );
        ensure!(balance > 0, "faucet funding failed");
    }

    v.step("board setup on both game accounts");
    v.setup(a).await?;
    v.setup(b).await?;

    v.step("stakes: both wallets publish a stake note naming the opponent");
    let stake_a = stake(
        &mut v.a.client,
        &v.scripts,
        StakeParties {
            my_wallet: wallet_a,
            my_game: a,
            opp_wallet: wallet_b,
            opp_game: b,
        },
        fee_asset,
        TESTNET_STAKE,
    )
    .await?;
    let stake_b = stake(
        &mut v.b.client,
        &v.scripts,
        StakeParties {
            my_wallet: wallet_b,
            my_game: b,
            opp_wallet: wallet_a,
            opp_game: a,
        },
        fee_asset,
        TESTNET_STAKE,
    )
    .await?;
    v.discover(b, &stake_a).await?;
    let stake_b_seen = v.discover(a, &stake_b).await?;
    let balance_before = fee_asset_balance(&v.a.client, wallet_a, fee_asset).await?;

    v.step("handshake: A challenges, B accepts, A fires turn 1 while consuming the acceptance");
    let challenge = v.send_handshake(a, true).await?;
    v.play(b, &[challenge], None).await?;
    let sb = v.state(b).await?;
    ensure!(
        sb.phase == PHASE_ACTIVE && sb.role == ROLE_ACCEPTOR,
        "B after challenge: {sb:?}"
    );
    ensure!(
        sb.opponent_wallet == Some(wallet_a),
        "B stored the wrong opponent wallet"
    );
    let accept = v.send_handshake(b, false).await?;
    let cells = classic_ship_cells();
    let (shot, _) = v.play(a, &[accept], Some((cells[0].0, cells[0].1))).await?;
    let mut shot = shot.context("A fires turn 1")?;
    let sa = v.state(a).await?;
    ensure!(
        sa.phase == PHASE_ACTIVE && sa.role == ROLE_CHALLENGER,
        "A after accept: {sa:?}"
    );
    ensure!(
        sa.shots_fired == 1 && sa.last_shot.2 == 1,
        "A after turn 1: {sa:?}"
    );

    v.step("forfeit: A cannot reclaim its own shot before the deadline");
    let early = reclaim(&mut v.a.client, &v.scripts, a, shot.clone()).await;
    let err = early.err().context("an early reclaim must be rejected")?;
    ensure!(
        is_masm_error(&err, ERR_FORFEIT_TOO_EARLY),
        "an early reclaim must fail with the deadline error, got: {err:#}"
    );
    println!(
        "  rejected as expected (error code {})",
        masm_error_code(ERR_FORFEIT_TOO_EARLY)
    );

    v.step("gameplay: A sinks B's fleet, B misses in between (one transaction per move)");
    let mut pending_for_a: Vec<Note> = vec![];
    // B's move consumes the result of its last shot (none before turn 2) and A's next shot.
    let mut pending_for_b: Vec<Note> = vec![];
    for i in 0..cells.len() {
        let last = i == cells.len() - 1;
        let shot_seen = v.discover(b, &shot).await?;
        let parsed = ShotNoteStorage::from_note(&shot_seen)?;
        ensure!(parsed.turn == 2 * i as u64 + 1, "shot turn {}", parsed.turn);
        pending_for_b.push(shot_seen);
        let b_target = if last {
            None
        } else {
            Some((9 - i as u64 / 10, i as u64 % 10))
        };
        println!(
            "  B resolves turn {} and fires at {:?}",
            parsed.turn, b_target
        );
        let (b_shot, created) = v.play(b, &pending_for_b, b_target).await?;
        pending_for_b.clear();
        let result = created.first().context("result note")?.clone();
        let parsed = ResultNoteStorage::from_note(&result)?;
        ensure!(parsed.result.is_hit, "A's shot {i} should hit");
        ensure!(
            parsed.result.game_over == last,
            "game_over flag on shot {i}"
        );
        pending_for_a = vec![result];
        if let Some(b_shot) = b_shot {
            pending_for_a.push(b_shot);
        }
        if last {
            ensure!(created.len() == 2, "the 17th hit creates a defeat note too");
            break;
        }
        for note in &pending_for_a {
            v.discover(a, note).await?;
        }
        let next = cells[i + 1];
        println!(
            "  A answers and fires turn {} at ({}, {})",
            2 * i + 3,
            next.0,
            next.1
        );
        let (next_shot, created) = v.play(a, &pending_for_a, Some((next.0, next.1))).await?;
        let b_result = created.first().context("B's result")?.clone();
        ensure!(
            !ResultNoteStorage::from_note(&b_result)?.result.is_hit,
            "B's shot {i} should miss"
        );
        v.discover(b, &b_result).await?;
        pending_for_b.push(b_result);
        shot = next_shot.context("A's next shot")?;
    }
    let sb = v.state(b).await?;
    ensure!(
        sb.phase == PHASE_COMPLETE && sb.outcome == OUTCOME_LOST,
        "B at the end: {sb:?}"
    );
    ensure!(
        sb.ships_hit_count == TOTAL_SHIP_CELLS,
        "B hit count {}",
        sb.ships_hit_count
    );

    v.step("A processes the final result; its wallet claims the defeat note and both stakes");
    let final_result = v.discover(a, &pending_for_a[0]).await?;
    v.play(a, &[final_result], None).await?;
    let sa = v.state(a).await?;
    ensure!(
        sa.phase == PHASE_COMPLETE && sa.outcome == OUTCOME_WON,
        "A at the end: {sa:?}"
    );
    let defeat = v
        .discover(a, &expected_defeat_note(&v.scripts, b, wallet_a)?)
        .await?;
    claim(
        &mut v.a.client,
        wallet_a,
        vec![defeat, stake_a, stake_b_seen],
    )
    .await?;
    let balance_after = fee_asset_balance(&v.a.client, wallet_a, fee_asset).await?;
    println!("  A's wallet: {balance_before} -> {balance_after}");
    ensure!(
        balance_after > balance_before + 2 * TESTNET_STAKE - 1_000,
        "A's wallet should receive both stakes"
    );

    println!(
        "\nDONE in {:.0}s: full staked game validated on testnet",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}
