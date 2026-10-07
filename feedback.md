# Post-project feedback: migrating miden-battleship to testnet 0.17 (MASM contracts, runtime compilation)

Written 2026-10-07 after the migration from the Rust-SDK/0.14 stack to MASM contracts compiled at
runtime by miden-client 0.17.2 (Rust) and the web SDK 0.17.1 (browser), with USDCx fees and
faucet-funded NoAuth game accounts.

## What worked well

- **MockChain 0.17 with a fee-charging chain.** `MockChain::builder().verification_base_fee(n)` plus
  `AccountBuilder::with_assets([fee_asset])` exercised the exact NoAuth fee path testnet uses, so the
  31 tests caught nothing less than the real chain would. `MasmError::new(msg).matches_execution_error`
  made every contract assertion testable by message.
- **`add_note_script` on the mock transaction builder** removed the need to predict a result note in
  most tests, while one test still validates the `expected_output_recipients` path the client uses.
- **Runtime MASM compilation** collapsed the old build pipeline (cargo-miden, .masp copies, hard-coded
  script roots in config.ts). The frontend imports the sources with `?raw` through a vite alias.
- **The two-client testnet validator** (`validate_testnet`) proved note discovery through account
  target tags before any browser work and now doubles as the "local node" gate.
- **`tasks/research/` + `tasks/todo.md` as durable state** made the session survivable after a machine
  restart.

## What was missing, confusing or incorrect

- **The CLAUDE.md workflow assumed `miden-node bundled`,** which no longer exists in 0.17; the gate had
  to become a testnet run. The `local-node-validation` skill described the old binary.
- **The web SDK exposes no Poseidon2 hash,** so the setup script's advice-payload preimage check could
  not be satisfied from the browser; the script now takes an arbitrary advice-map key.
- **wasm-bindgen handle consumption is silent and mislabelled:** reusing a `Felt` gives
  `array contains a value of the wrong type`, nothing points at the moved handle. Keeping values as
  `bigint` and minting handles per call is the only safe pattern.
- **A single client cannot "receive" a note its other tracked account created** (the screener commits
  it as an output note only). The first validator run burned 9 minutes on this before the source was
  read. Worth a line in the client docs.
- **`MidenProvider` never initializes behind a disconnected signer provider,** with no log line.
  The old UX ("connect your wallet") was really this behaviour.
- **React Fast Refresh resets screen state;** editing frontend files during a browser game aborted it.

## Suggested improvements to skills, hooks and docs

- Replace the Rust-SDK skills with a MASM skill covering: `@account_procedure` stack windows,
  `active_note::get_bounded_storage`, `output_note::create` + `expected_output_recipients`,
  `pipe_words_to_memory` for advice payloads, and the uppercase-constant rule.
- A `mockchain-017` testing skill with the `tests/common/mod.rs` harness as the canonical example
  (fees on, `assert_masm_error`, `add_note_script`).
- A `testnet-fees` note: faucet cap 10_000 base units per claim, ~105 per transaction on 0.17,
  first consume deploys the account, top-up policy.
- A hook that refuses frontend edits while a `yarn dev` E2E flag file exists.

## Patterns worth capturing

- Derive every handshake step from on-chain state (phase, opponent slot, output notes) so a hook can
  resume after an interruption; the starter's completion now does this.
- One client per party, always; a shared store hides the real discovery path.
- Classify incoming notes by script root, never by storage length (result and reveal notes both carry
  4 items).
