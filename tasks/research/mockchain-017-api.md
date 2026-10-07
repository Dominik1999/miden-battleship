# miden-testing 0.17.1 MockChain API (condensed, 2026-10-07)

- Entry: `MockChain::builder()` -> `MockChainBuilder`; `.verification_base_fee(n)` (default 0 = no fees), `.fee_faucet_id(id)` (default `miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET`).
- Accounts: `builder.add_account(account)?` (verbatim, e.g. NoAuth account from `AccountBuilder...build_existing()?`); `add_existing_wallet(Auth::IncrNonce)?`; `add_p2id_note_with_fee(target, amount)?`; `add_output_note(RawOutputNote::Full(note))`; `let mut chain = builder.build()?`.
- No `Auth` variant for standards `NoAuth`; `Auth::Noop` is the protocol noop component (never pays fees).
- Tx: `chain.build_transaction(account_id_or_account)` -> `MockTransactionBuilder`: `.authenticated_input_note(id)`, `.unauthenticated_input_note(note)`, `.tx_script(s)`, `.tx_script_args(word)`, `.add_advice_map_entry(word, vec)`, `.expected_output_note(RawOutputNote)`, `.add_note_script(NoteScript)` (for output notes created by account code; without it a public note errors "not found in data store"), `.send_notes_script(&SendNotesTransactionScript)`, `.build()?` -> `MockTransaction`; `.execute().await -> Result<ExecutedTransaction, TransactionExecutorError>`.
- Apply: `chain.add_pending_executed_transaction(&executed)?; chain.prove_next_block()?; chain.committed_account(id)?`.
- `ExecutedTransaction`: `output_notes()` (RawOutputNote::Full/Partial, `.recipient()`, `.metadata()`), `account_patch()`, `measurements().total_cycles()`, `compute_fee()` (testing).
- Errors: `TransactionExecutorError::TransactionProgramExecutionFailed(ExecutionError)`; match MASM messages with `miden_protocol::errors::MasmError::new("msg").matches_execution_error(&e)`; `assert_transaction_executor_error!` macro needs `miden_tx` in scope.
- Fees: fee = base_fee * (ilog2(cycles)+1); paid by the auth component (NoAuth calls fee::pay_fee; zero fee creates no note). Fund via `AccountBuilder::with_assets([FungibleAsset::new(fee_faucet, amt)?.into()])` (testing, build_existing) or `add_p2id_note_with_fee`.
- Zero-fee gotcha: a tx that changes nothing and consumes nothing fails `executed transaction neither changed the account state, nor consumed any notes`.
- Storage: `account.storage().get_item(&slot)?`, `.get_map_item(&slot, StorageMapKey)?`.
- Examples: miden-testing tests/auth/fee_payment/no_auth.rs, tests/scripts/code_inspection.rs, tests/asserts.rs.
