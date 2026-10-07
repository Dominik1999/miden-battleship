//! Shared MockChain harness for the battleship integration tests.
//!
//! Two players, each with a PRIVATE game account (NoAuth + BasicWallet + battleship) and a public
//! owner wallet. Game accounts are new accounts funded by a genesis P2ID note of the chain's fee
//! asset; their first transaction (consuming it) deploys them, exactly like on testnet. The chain
//! charges fees (`BASE_FEE`), so the NoAuth fee path is exercised everywhere.

#![allow(dead_code)]

use anyhow::{Context, Result};
use integration::battleship::*;
use miden_client::{
    account::{Account, AccountId},
    asset::FungibleAsset,
    note::{Note, PartialNote},
    transaction::{
        ExecutedTransaction, RawOutputNote, TransactionExecutorError, TransactionScript,
    },
    Felt, Word,
};
use miden_protocol::{errors::MasmError, testing::account_id::ACCOUNT_ID_FEE_FAUCET};
use miden_standards::tx_script::SendNotesTransactionScript;
use miden_testing::{Auth, MockChain, MockTransactionBuilder};

pub const BASE_FEE: u32 = 100;
pub const INITIAL_FEE_BALANCE: u64 = 10_000_000;
/// Fee-asset balance of each owner wallet at genesis (stakes are paid in the fee asset).
pub const WALLET_BALANCE: u64 = 100_000_000;
pub const STAKE: u64 = 5_000_000;
pub const STAKE_EXPIRY_DELTA: u64 = 60 * 24 * 3600;
pub const GAME_ID: [u64; 4] = [10, 20, 30, 40];
pub const SEED_A: [u8; 32] = [1; 32];
pub const SEED_B: [u8; 32] = [2; 32];
pub const SEED_C: [u8; 32] = [3; 32];

pub fn serial(n: u64) -> Word {
    word([n, 0, 0, 0])
}

/// A player: its private game account (seed word kept for the handshake) and its owner wallet.
#[derive(Clone)]
pub struct Player {
    pub id: AccountId,
    pub seed: Word,
    pub wallet: AccountId,
    /// The account object, used for the deploying first transaction.
    pub account: Account,
    pub deployed: bool,
}

/// A mock chain with the compiled battleship scripts, two players and a stranger C.
pub struct Game {
    pub chain: MockChain,
    pub scripts: BattleshipScripts,
    pub a: Player,
    pub b: Player,
    pub c: Player,
    next_serial: u64,
}

impl Game {
    pub fn new() -> Result<Self> {
        let scripts = BattleshipScripts::compile()?;
        let mut builder = MockChain::builder().verification_base_fee(BASE_FEE);
        let fee_faucet = AccountId::try_from(ACCOUNT_ID_FEE_FAUCET)?;
        let mut player = |seed: [u8; 32]| -> Result<Player> {
            let funds = FungibleAsset::new(fee_faucet, WALLET_BALANCE)?;
            let wallet = builder
                .add_existing_wallet_with_assets(Auth::IncrNonce, [funds.into()])?
                .id();
            let account = game_account_builder(seed, scripts.component.clone())
                .build()
                .context("failed to build game account")?;
            builder.add_p2id_note_with_fee(account.id(), INITIAL_FEE_BALANCE)?;
            Ok(Player {
                id: account.id(),
                seed: account.seed().context("new account has a seed")?,
                wallet,
                account,
                deployed: false,
            })
        };
        let a = player(SEED_A)?;
        let b = player(SEED_B)?;
        let c = player(SEED_C)?;
        let chain = builder.build()?;
        Ok(Self {
            chain,
            scripts,
            a,
            b,
            c,
            next_serial: 100,
        })
    }

    pub fn player(&self, id: AccountId) -> &Player {
        [&self.a, &self.b, &self.c]
            .into_iter()
            .find(|p| p.id == id)
            .expect("known player")
    }

    fn player_mut(&mut self, id: AccountId) -> &mut Player {
        [&mut self.a, &mut self.b, &mut self.c]
            .into_iter()
            .find(|p| p.id == id)
            .expect("known player")
    }

    pub fn opponent_of(&self, id: AccountId) -> &Player {
        if id == self.a.id {
            &self.b
        } else {
            &self.a
        }
    }

    // ------------------------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------------------------

    /// The current state of a game account. Game accounts are private, so the chain only knows
    /// their commitment; the harness keeps the full state and applies every transaction's patch.
    pub fn account(&self, id: AccountId) -> Result<Account> {
        Ok(self.player(id).account.clone())
    }

    pub fn state(&self, id: AccountId) -> Result<GameState> {
        Ok(GameState::from_account(&self.account(id)?))
    }

    pub fn cell(&self, id: AccountId, row: u64, col: u64) -> Result<u64> {
        Ok(read_board_cell(&self.account(id)?, row, col))
    }

    pub fn fee_balance(&self, id: AccountId) -> Result<u64> {
        let fee_faucet = self.chain.fee_faucet_id();
        Ok(self
            .account(id)?
            .vault()
            .get_balance(FungibleAsset::new(fee_faucet, 0)?.id())
            .map(|amount| amount.as_u64())
            .unwrap_or(0))
    }

    /// Timestamp of the latest block (the reference block of the next transaction).
    pub fn now(&self) -> u64 {
        self.chain.latest_block_header().timestamp() as u64
    }

    /// A deadline exactly 12 hours after the reference block.
    pub fn deadline(&self) -> u64 {
        self.now() + DEADLINE_DELTA
    }

    /// Proves an empty block `secs` after the latest one.
    pub fn advance_time(&mut self, secs: u64) -> Result<()> {
        let ts = (self.now() + secs) as u32;
        self.chain.prove_next_block_at(ts)?;
        Ok(())
    }

    pub fn fresh_serial(&mut self) -> Word {
        self.next_serial += 1;
        serial(self.next_serial)
    }

    // ------------------------------------------------------------------------------------------
    // Transactions
    // ------------------------------------------------------------------------------------------

    /// Executes a transaction on the private game account `id` from the harness's copy of its
    /// state and, on success, commits it in a new block and applies the patch to that copy.
    pub async fn execute(
        &mut self,
        id: AccountId,
        configure: impl for<'a> FnOnce(MockTransactionBuilder<'a>) -> MockTransactionBuilder<'a>,
    ) -> Result<ExecutedTransaction> {
        let account = self.player(id).account.clone();
        let tx = configure(self.chain.build_transaction(account)).build()?;
        let executed = tx.execute().await?;
        self.chain.add_pending_executed_transaction(&executed)?;
        self.chain.prove_next_block()?;
        let player = self.player_mut(id);
        player.account.apply_patch(executed.account_patch())?;
        player.deployed = true;
        Ok(executed)
    }

    /// Executes a transaction on a public wallet account (owner wallets).
    pub async fn execute_wallet(
        &mut self,
        wallet: AccountId,
        configure: impl for<'a> FnOnce(MockTransactionBuilder<'a>) -> MockTransactionBuilder<'a>,
    ) -> Result<ExecutedTransaction> {
        let tx = configure(self.chain.build_transaction(wallet)).build()?;
        let executed = tx.execute().await?;
        self.chain.add_pending_executed_transaction(&executed)?;
        self.chain.prove_next_block()?;
        Ok(executed)
    }

    /// Consumes the genesis funding note: deploys the game account.
    pub async fn fund(&mut self, id: AccountId) -> Result<ExecutedTransaction> {
        let note = self
            .chain
            .committed_notes()
            .values()
            .find(|n| {
                n.metadata().tag() == miden_client::note::NoteTag::with_account_target(id)
                    && n.metadata().sender() != id
            })
            .map(|n| n.id())
            .context("funding note for the account")?;
        self.execute(id, move |b| b.authenticated_input_note(note))
            .await
    }

    pub async fn run_script(
        &mut self,
        id: AccountId,
        script: TransactionScript,
        script_arg: Option<Word>,
        advice_map: Vec<(Word, Vec<Felt>)>,
        expected: Vec<Note>,
    ) -> Result<ExecutedTransaction> {
        self.execute(id, move |mut builder| {
            builder = builder.tx_script(script);
            if let Some(arg) = script_arg {
                builder = builder.tx_script_args(arg);
            }
            for (key, value) in advice_map {
                builder = builder.add_advice_map_entry(key, value);
            }
            for note in expected {
                builder = builder.expected_output_note(RawOutputNote::Full(note));
            }
            builder
        })
        .await
    }

    /// Runs the setup transaction script on `id` with the classic board (`b` is `a`'s opponent).
    pub async fn setup(&mut self, id: AccountId) -> Result<ExecutedTransaction> {
        self.setup_with_rows(id, pack_board(&classic_ship_cells()))
            .await
    }

    pub async fn setup_with_rows(
        &mut self,
        id: AccountId,
        rows: [u64; 10],
    ) -> Result<ExecutedTransaction> {
        let opponent = self.opponent_of(id).id;
        let wallet = self.player(id).wallet;
        let payload = build_setup_payload(
            word(GAME_ID),
            opponent,
            wallet,
            &rows,
            &self.scripts.roots(),
        );
        let key = setup_payload_commitment(&payload);
        let script = self.scripts.setup_tx.clone();
        self.run_script(id, script, Some(key), vec![(key, payload)], vec![])
            .await
    }

    /// Publishes `note` from `from`'s game account via the BasicWallet send-notes script, exactly
    /// like the client's `own_output_notes`. The note is committed once this returns.
    pub async fn publish(&mut self, from: AccountId, note: Note) -> Result<ExecutedTransaction> {
        let account = self.account(from)?;
        let interface = account.code().interface(from);
        let script =
            SendNotesTransactionScript::new(&interface, &[PartialNote::from(note.clone())])
                .context("failed to build send-notes script")?;
        self.execute(from, move |builder| {
            builder
                .send_notes_script(&script)
                .expected_output_note(RawOutputNote::Full(note))
        })
        .await
    }

    /// Consumes a committed note on `id`, optionally with note args and expected output notes.
    pub async fn consume_with(
        &mut self,
        id: AccountId,
        note: &Note,
        args: Option<Word>,
        expected: Vec<Note>,
        tx_script: Option<(TransactionScript, Word)>,
    ) -> Result<ExecutedTransaction> {
        let note_id = note.id();
        self.execute(id, move |mut builder| {
            builder = builder.authenticated_input_note(note_id);
            if let Some(args) = args {
                builder = builder.extend_note_args([(note_id, args)].into_iter().collect());
            }
            for n in expected {
                builder = builder.expected_output_note(RawOutputNote::Full(n));
            }
            if let Some((script, arg)) = tx_script {
                builder = builder.tx_script(script).tx_script_args(arg);
            }
            builder
        })
        .await
    }

    pub async fn consume(&mut self, id: AccountId, note: &Note) -> Result<ExecutedTransaction> {
        self.consume_with(id, note, None, vec![], None).await
    }

    // ------------------------------------------------------------------------------------------
    // Game flow
    // ------------------------------------------------------------------------------------------

    pub fn handshake_note(&mut self, from: AccountId, challenge: bool) -> Result<Note> {
        let script = if challenge {
            self.scripts.challenge_note.clone()
        } else {
            self.scripts.accept_note.clone()
        };
        let serial = self.fresh_serial();
        let sender = self.player(from).clone();
        let to = self.opponent_of(from).id;
        let roots = self.scripts.roots();
        make_game_note(
            script,
            from,
            to,
            handshake_storage(word(GAME_ID), from, sender.seed, sender.wallet, &roots),
            serial,
        )
    }

    pub fn challenge_note(&mut self) -> Result<Note> {
        let a = self.a.id;
        self.handshake_note(a, true)
    }

    pub fn accept_note(&mut self) -> Result<Note> {
        let b = self.b.id;
        self.handshake_note(b, false)
    }

    /// The turn `id` fires next, from its on-chain state.
    pub fn next_fire_turn(&self, id: AccountId) -> Result<u64> {
        let s = self.state(id)?;
        Ok(if s.role == ROLE_CHALLENGER {
            2 * s.shots_fired + 1
        } else {
            2 * s.shots_fired + 2
        })
    }

    /// The shot note `fire_shot` will create for the next shot of `shooter`.
    pub fn shot_note_for(
        &self,
        shooter: AccountId,
        row: u64,
        col: u64,
        deadline: u64,
    ) -> Result<Note> {
        let turn = self.next_fire_turn(shooter)?;
        expected_shot_note(
            &self.scripts,
            shooter,
            self.opponent_of(shooter).id,
            row,
            col,
            turn,
            deadline,
        )
    }

    /// Fires a shot from `shooter` (ACTIVE, its turn) with the default 12-hour deadline.
    pub async fn fire(&mut self, shooter: AccountId, row: u64, col: u64) -> Result<Note> {
        let deadline = self.deadline();
        self.fire_with_deadline(shooter, row, col, deadline).await
    }

    pub async fn fire_with_deadline(
        &mut self,
        shooter: AccountId,
        row: u64,
        col: u64,
        deadline: u64,
    ) -> Result<Note> {
        let shot = self.shot_note_for(shooter, row, col, deadline)?;
        let script = self.scripts.fire_tx.clone();
        self.run_script(
            shooter,
            script,
            Some(fire_args(row, col, deadline)),
            vec![],
            vec![shot.clone()],
        )
        .await?;
        Ok(shot)
    }

    /// Both players set up, A challenges B, B accepts, A fires turn 1 at (row, col) while
    /// consuming the accept note. Returns A's first shot note.
    pub async fn handshake(&mut self, row: u64, col: u64) -> Result<Note> {
        let (a, b) = (self.a.id, self.b.id);
        self.fund(a).await?;
        self.fund(b).await?;
        self.setup(a).await?;
        self.setup(b).await?;
        let challenge = self.challenge_note()?;
        self.publish(a, challenge.clone()).await?;
        self.consume(b, &challenge).await?;
        let accept = self.accept_note()?;
        self.publish(b, accept.clone()).await?;
        self.accept_and_fire(&accept, row, col).await
    }

    /// A consumes the accept note and fires turn 1 in the same transaction.
    pub async fn accept_and_fire(&mut self, accept: &Note, row: u64, col: u64) -> Result<Note> {
        let a = self.a.id;
        let deadline = self.deadline();
        let shot = expected_shot_note(&self.scripts, a, self.b.id, row, col, 1, deadline)?;
        let script = self.scripts.fire_tx.clone();
        self.consume_with(
            a,
            accept,
            None,
            vec![shot.clone()],
            Some((script, fire_args(row, col, deadline))),
        )
        .await?;
        Ok(shot)
    }

    /// What the defender's client predicts for an incoming shot (mirrors `process_shot`).
    pub fn predict(&self, defender: AccountId, row: u64, col: u64) -> Result<ShotResult> {
        let account = self.account(defender)?;
        let cell = read_board_cell(&account, row, col);
        let is_hit = (1..=5).contains(&cell);
        let hits = GameState::from_account(&account).ships_hit_count;
        Ok(ShotResult {
            is_hit,
            game_over: is_hit && hits + 1 >= TOTAL_SHIP_CELLS,
        })
    }

    /// The defender resolves `shot`; returns the result note (and the defeat note on the 17th hit).
    pub async fn resolve(
        &mut self,
        defender: AccountId,
        shot: &Note,
    ) -> Result<(Note, Option<Note>)> {
        let deadline = self.deadline();
        self.resolve_with_deadline(defender, shot, deadline).await
    }

    pub async fn resolve_with_deadline(
        &mut self,
        defender: AccountId,
        shot: &Note,
        result_deadline: u64,
    ) -> Result<(Note, Option<Note>)> {
        let parsed = ShotNoteStorage::from_note(shot)?;
        let shooter = shot.metadata().sender();
        let result = self.predict(defender, parsed.row, parsed.col)?;
        let result_note = expected_result_note(
            &self.scripts,
            defender,
            shooter,
            parsed.turn,
            result,
            result_deadline,
        )?;
        let defeat = if result.game_over {
            Some(expected_defeat_note(
                &self.scripts,
                defender,
                self.opponent_of(defender).wallet,
            )?)
        } else {
            None
        };
        let mut expected = vec![result_note.clone()];
        expected.extend(defeat.clone());
        self.consume_with(
            defender,
            shot,
            Some(shot_note_args(result_deadline)),
            expected,
            None,
        )
        .await?;
        Ok((result_note, defeat))
    }

    /// The shooter consumes the result note and fires its next shot in the same transaction.
    pub async fn answer(
        &mut self,
        shooter: AccountId,
        result: &Note,
        row: u64,
        col: u64,
    ) -> Result<Note> {
        let deadline = self.deadline();
        let turn = self.next_fire_turn(shooter)?;
        let shot = expected_shot_note(
            &self.scripts,
            shooter,
            self.opponent_of(shooter).id,
            row,
            col,
            turn,
            deadline,
        )?;
        let script = self.scripts.fire_tx.clone();
        self.consume_with(
            shooter,
            result,
            None,
            vec![shot.clone()],
            Some((script, fire_args(row, col, deadline))),
        )
        .await?;
        Ok(shot)
    }

    /// The sender reclaims its own note after the deadline; returns the forfeit note.
    pub async fn reclaim(&mut self, id: AccountId, note: &Note) -> Result<Note> {
        let forfeit = expected_forfeit_note(&self.scripts, id, self.player(id).wallet)?;
        self.consume_with(id, note, None, vec![forfeit.clone()], None)
            .await?;
        Ok(forfeit)
    }

    /// Fee-asset balance of a public owner wallet.
    pub fn wallet_balance(&self, wallet: AccountId) -> Result<u64> {
        let fee_faucet = self.chain.fee_faucet_id();
        Ok(self
            .chain
            .committed_account(wallet)?
            .vault()
            .get_balance(FungibleAsset::new(fee_faucet, 0)?.id())
            .map(|amount| amount.as_u64())
            .unwrap_or(0))
    }

    /// `player`'s wallet creates a stake note of `STAKE` fee-asset units naming the opponent.
    pub async fn stake(&mut self, player: AccountId) -> Result<Note> {
        let opp_game = self.opponent_of(player).id;
        let expiry = self.now() + STAKE_EXPIRY_DELTA;
        self.stake_custom(player, opp_game, expiry).await
    }

    /// A stake note from `player`'s wallet with an explicit opponent game account and expiry.
    pub async fn stake_custom(
        &mut self,
        player: AccountId,
        opp_game: AccountId,
        expiry: u64,
    ) -> Result<Note> {
        let me = self.player(player).clone();
        let opp_wallet = self.opponent_of(player).wallet;
        let fee_faucet = self.chain.fee_faucet_id();
        let asset = FungibleAsset::new(fee_faucet, STAKE)?.into();
        let serial = self.fresh_serial();
        let note = make_stake_note(
            &self.scripts,
            me.wallet,
            me.id,
            opp_wallet,
            opp_game,
            expiry,
            asset,
            serial,
        )?;
        let account = self.chain.committed_account(me.wallet)?.clone();
        let interface = account.code().interface(me.wallet);
        let script =
            SendNotesTransactionScript::new(&interface, &[PartialNote::from(note.clone())])
                .context("failed to build send-notes script for the stake")?;
        let out = note.clone();
        self.execute_wallet(me.wallet, move |builder| {
            builder
                .send_notes_script(&script)
                .expected_output_note(RawOutputNote::Full(out))
        })
        .await?;
        Ok(note)
    }

    /// `wallet` consumes `notes` in one transaction (a claim or a refund).
    pub async fn claim(
        &mut self,
        wallet: AccountId,
        notes: &[&Note],
    ) -> Result<ExecutedTransaction> {
        let ids: Vec<_> = notes.iter().map(|n| n.id()).collect();
        self.execute_wallet(wallet, move |builder| {
            builder.authenticated_input_notes(ids)
        })
        .await
    }

    /// Plays a complete game after the handshake: A sinks B's classic fleet while B misses.
    /// Returns the defeat note B's account created for A's wallet.
    pub async fn play_to_defeat(&mut self) -> Result<Note> {
        let (a, b) = (self.a.id, self.b.id);
        let cells = classic_ship_cells();
        let mut shot = self.handshake(cells[0].0, cells[0].1).await?;
        for i in 0..cells.len() {
            let (result, defeat) = self.resolve(b, &shot).await?;
            if i == cells.len() - 1 {
                self.consume(a, &result).await?;
                return defeat.context("the 17th hit creates a defeat note");
            }
            let b_shot = self.fire(b, 9 - (i as u64 / 10), i as u64 % 10).await?;
            let (b_result, _) = self.resolve(a, &b_shot).await?;
            let (nrow, ncol, _) = cells[i + 1];
            shot = self.answer(a, &result, nrow, ncol).await?;
            self.consume(b, &b_result).await?;
        }
        unreachable!()
    }

    pub fn is_committed(&self, note: &Note) -> bool {
        self.chain.is_note_committed(&note.id())
    }
}

/// Asserts that `result` failed with the MASM assertion `message`.
pub fn assert_masm_error<T: std::fmt::Debug>(result: Result<T>, message: &str) {
    let err = match result {
        Ok(_) => panic!("expected the transaction to fail with {message:?}, but it succeeded"),
        Err(err) => err,
    };
    let Some(TransactionExecutorError::TransactionProgramExecutionFailed(exec_err)) =
        err.downcast_ref::<TransactionExecutorError>()
    else {
        panic!("expected a transaction execution failure with {message:?}, got: {err:?}");
    };
    assert!(
        MasmError::new(message.to_string()).matches_execution_error(exec_err),
        "expected the MASM error {message:?}, got:\n{err}"
    );
}
