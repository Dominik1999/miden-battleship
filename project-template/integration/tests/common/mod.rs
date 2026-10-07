//! Shared MockChain harness for the battleship integration tests.
//!
//! Every transaction runs on a fee-charging chain (`BASE_FEE`), so the `NoAuth` fee payment path
//! is exercised exactly as on testnet. Game accounts A and B are funded with the chain's fee asset
//! at genesis; a third account C is a stranger that is never part of the game.

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
use miden_testing::{MockChain, MockTransactionBuilder};

pub const BASE_FEE: u32 = 100;
pub const INITIAL_FEE_BALANCE: u64 = 10_000_000;

pub const GAME_ID: [u64; 4] = [10, 20, 30, 40];
pub const A_COMMITMENT: [u64; 4] = [100, 200, 300, 400];
pub const B_COMMITMENT: [u64; 4] = [500, 600, 700, 800];

pub const SEED_A: [u8; 32] = [1; 32];
pub const SEED_B: [u8; 32] = [2; 32];
pub const SEED_C: [u8; 32] = [3; 32];

pub fn fee_faucet_id() -> AccountId {
    AccountId::try_from(ACCOUNT_ID_FEE_FAUCET).expect("fee faucet id is valid")
}

pub fn serial(n: u64) -> Word {
    word([n, 0, 0, 0])
}

/// A mock chain with the compiled battleship scripts and the three test accounts.
pub struct Game {
    pub chain: MockChain,
    pub scripts: BattleshipScripts,
    pub a: AccountId,
    pub b: AccountId,
    pub c: AccountId,
    next_serial: u64,
}

impl Game {
    pub fn new() -> Result<Self> {
        Self::with_base_fee(BASE_FEE)
    }

    pub fn with_base_fee(base_fee: u32) -> Result<Self> {
        let scripts = BattleshipScripts::compile()?;
        let mut builder = MockChain::builder().verification_base_fee(base_fee);
        let mut add = |seed| -> Result<AccountId> {
            let fee_asset = FungibleAsset::new(fee_faucet_id(), INITIAL_FEE_BALANCE)?;
            let account = game_account_builder(seed, scripts.component.clone())
                .with_assets([fee_asset.into()])
                .build_existing()
                .context("failed to build game account")?;
            builder.add_account(account.clone())?;
            Ok(account.id())
        };
        let a = add(SEED_A)?;
        let b = add(SEED_B)?;
        let c = add(SEED_C)?;
        let chain = builder.build()?;
        Ok(Self {
            chain,
            scripts,
            a,
            b,
            c,
            next_serial: 1,
        })
    }

    // ------------------------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------------------------

    pub fn account(&self, id: AccountId) -> Result<Account> {
        Ok(self.chain.committed_account(id)?.clone())
    }

    pub fn state(&self, id: AccountId) -> Result<GameState> {
        Ok(GameState::from_account(&self.account(id)?))
    }

    pub fn cell(&self, id: AccountId, row: u64, col: u64) -> Result<u64> {
        Ok(read_board_cell(&self.account(id)?, row, col))
    }

    pub fn fee_balance(&self, id: AccountId) -> Result<u64> {
        let account = self.account(id)?;
        Ok(account
            .vault()
            .get_balance(FungibleAsset::new(fee_faucet_id(), 0)?.id())
            .map(|amount| amount.as_u64())
            .unwrap_or(0))
    }

    pub fn fresh_serial(&mut self) -> Word {
        self.next_serial += 1;
        serial(self.next_serial)
    }

    // ------------------------------------------------------------------------------------------
    // Transactions
    // ------------------------------------------------------------------------------------------

    /// Executes a transaction on `id` and, on success, commits it in a new block.
    pub async fn execute(
        &mut self,
        id: AccountId,
        configure: impl for<'a> FnOnce(MockTransactionBuilder<'a>) -> MockTransactionBuilder<'a>,
    ) -> Result<ExecutedTransaction> {
        let tx = configure(self.chain.build_transaction(id)).build()?;
        let executed = tx.execute().await?;
        self.chain.add_pending_executed_transaction(&executed)?;
        self.chain.prove_next_block()?;
        Ok(executed)
    }

    /// Runs a transaction script on `id` with an optional script argument and advice map entries.
    pub async fn run_script(
        &mut self,
        id: AccountId,
        script: TransactionScript,
        script_arg: Option<Word>,
        advice_map: Vec<(Word, Vec<Felt>)>,
    ) -> Result<ExecutedTransaction> {
        self.execute(id, move |mut builder| {
            builder = builder.tx_script(script);
            if let Some(arg) = script_arg {
                builder = builder.tx_script_args(arg);
            }
            for (key, value) in advice_map {
                builder = builder.add_advice_map_entry(key, value);
            }
            builder
        })
        .await
    }

    /// Runs the setup transaction script on `id` with the classic board.
    pub async fn setup(
        &mut self,
        id: AccountId,
        opponent: AccountId,
        commitment: [u64; 4],
    ) -> Result<ExecutedTransaction> {
        self.setup_with_rows(id, opponent, commitment, pack_board(&classic_ship_cells()))
            .await
    }

    pub async fn setup_with_rows(
        &mut self,
        id: AccountId,
        opponent: AccountId,
        commitment: [u64; 4],
        rows: [u64; 10],
    ) -> Result<ExecutedTransaction> {
        let payload = build_setup_payload(word(GAME_ID), opponent, word(commitment), &rows);
        let arg = setup_payload_commitment(&payload);
        self.run_script(
            id,
            self.scripts.setup_tx.clone(),
            Some(arg),
            vec![(arg, payload)],
        )
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

    /// Consumes a committed note on `id`.
    pub async fn consume(&mut self, id: AccountId, note: &Note) -> Result<ExecutedTransaction> {
        let note_id = note.id();
        self.execute(id, move |builder| builder.authenticated_input_note(note_id))
            .await
    }

    /// Consumes a committed shot note on the defender `id`; the result note script is registered
    /// so the executor can materialize the public result note the account creates.
    pub async fn consume_shot(
        &mut self,
        id: AccountId,
        shot: &Note,
    ) -> Result<ExecutedTransaction> {
        let note_id = shot.id();
        let result_script = self.scripts.result_note.clone();
        self.execute(id, move |builder| {
            builder
                .authenticated_input_note(note_id)
                .add_note_script(result_script)
        })
        .await
    }

    /// Like `consume_shot`, but declares the exact expected result note (the client's
    /// `expected_output_recipients` path).
    pub async fn consume_shot_expecting(
        &mut self,
        id: AccountId,
        shot: &Note,
        expected: Note,
    ) -> Result<ExecutedTransaction> {
        let note_id = shot.id();
        self.execute(id, move |builder| {
            builder
                .authenticated_input_note(note_id)
                .expected_output_note(RawOutputNote::Full(expected))
        })
        .await
    }

    // ------------------------------------------------------------------------------------------
    // Game flow
    // ------------------------------------------------------------------------------------------

    pub fn challenge_note(&mut self) -> Result<Note> {
        let serial = self.fresh_serial();
        make_game_note(
            self.scripts.challenge_note.clone(),
            self.a,
            self.b,
            handshake_storage(word(GAME_ID), self.a, word(A_COMMITMENT)),
            serial,
        )
    }

    pub fn accept_note(&mut self) -> Result<Note> {
        let serial = self.fresh_serial();
        make_game_note(
            self.scripts.accept_note.clone(),
            self.b,
            self.a,
            handshake_storage(word(GAME_ID), self.b, word(B_COMMITMENT)),
            serial,
        )
    }

    pub fn shot_note(
        &mut self,
        shooter: AccountId,
        defender: AccountId,
        row: u64,
        col: u64,
        turn: u64,
    ) -> Result<Note> {
        let serial = self.fresh_serial();
        let result_serial = self.fresh_serial();
        make_game_note(
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
        )
    }

    pub fn reveal_note(
        &mut self,
        from: AccountId,
        to: AccountId,
        commitment: [u64; 4],
    ) -> Result<Note> {
        let serial = self.fresh_serial();
        make_game_note(
            self.scripts.reveal_note.clone(),
            from,
            to,
            word(commitment).iter().copied().collect(),
            serial,
        )
    }

    /// Both players set up, A challenges B, B accepts: both accounts ACTIVE.
    pub async fn handshake(&mut self) -> Result<()> {
        self.setup(self.a, self.b, A_COMMITMENT).await?;
        self.setup(self.b, self.a, B_COMMITMENT).await?;
        let challenge = self.challenge_note()?;
        self.publish(self.a, challenge.clone()).await?;
        self.consume(self.b, &challenge).await?;
        let accept = self.accept_note()?;
        self.publish(self.b, accept.clone()).await?;
        self.consume(self.a, &accept).await?;
        Ok(())
    }

    /// `shooter` fires at `defender`; returns the defender's tx and the result note it created.
    pub async fn fire(
        &mut self,
        shooter: AccountId,
        defender: AccountId,
        row: u64,
        col: u64,
        turn: u64,
    ) -> Result<(ExecutedTransaction, Note)> {
        let shot = self.shot_note(shooter, defender, row, col, turn)?;
        self.publish(shooter, shot.clone()).await?;
        let executed = self.consume_shot(defender, &shot).await?;
        let result = self.result_note_of(&executed)?;
        Ok((executed, result))
    }

    /// The result note among a transaction's output notes.
    pub fn result_note_of(&self, executed: &ExecutedTransaction) -> Result<Note> {
        let root = self.scripts.result_note.root();
        executed
            .output_notes()
            .iter()
            .find_map(|output| match output {
                RawOutputNote::Full(note) if note.recipient().script().root() == root => {
                    Some(note.clone())
                }
                _ => None,
            })
            .context("transaction created no result note")
    }
}

/// Asserts that `result` failed with the MASM assertion `message`.
pub fn assert_masm_error(result: Result<ExecutedTransaction>, message: &str) {
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
