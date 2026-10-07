---
name: local-node-validation
description: Validates the battleship contracts against the real Miden testnet with the validate_testnet binary. Covers why MockChain is not enough, the two-client setup with private game accounts and wallets, faucet funding and fees, stakes, the verification checklist and troubleshooting. Use after MockChain tests pass and before frontend work; there is no local-node step with miden-node 0.17.
---

# Testnet Validation (formerly local-node validation)

Validates that contracts working in MockChain also work against a real node. `miden-node` 0.17 has no `bundled` mode, so the gate runs against **testnet** instead of a local node: `integration/src/bin/validate_testnet.rs` plays a full staked game between two independent clients and asserts the state after every step. The frontend mirrors the same helpers (`helpers.rs`) step for step, so anything that fails here fails in the browser too.

## Why This Matters

MockChain simplifies execution in ways that hide real-world failures:

1. **No block production delay** -- MockChain commits with `prove_next_block()`. On testnet a transaction commits seconds later and a note becomes visible only after sync.
2. **No note discovery** -- in MockChain the test holds the `Note`. On testnet the recipient must find it through its account-target tag during `sync_state()`; the component-created notes must match the client's prediction (`expected_*_note`) exactly.
3. **No proving** -- MockChain only executes. Testnet transactions are proven by the remote prover (tens of seconds each; 300 s timeout in `helpers.rs`).
4. **No fees to earn** -- MockChain accounts are funded at genesis. On testnet a fresh account must claim USDCx from the faucet, and its first transaction (consuming the funding note) is what deploys it.
5. **No version/protocol check** -- testnet enforces the client/node version compatibility and the protocol config (fee asset).
6. **Two players, two stores** -- a single client tracking both accounts never sees a component-created note from one account as an input note of the other. Private game accounts also only exist in their owner's store.
7. **Real block timestamps** -- deadlines are checked against the reference block's timestamp; the MockChain's `advance_time` has no testnet equivalent, so the forfeit path (12 h) is covered by the MockChain tests only.

## Prerequisites

- [ ] MockChain tests pass: `cargo test -p integration --release`
- [ ] `curl` on `PATH` (faucet requests) and internet access to `rpc.testnet.miden.io`, the testnet prover and `https://faucet-api.testnet.miden.io`
- [ ] The public faucet is up: `curl -sS "https://faucet-api.testnet.miden.io/pow?account_id=x&amount=1"` answers (a 400 is fine; 5xx means the faucet is down, not your change)

## Step 1: Run the validation binary

```bash
cd project-template
cargo run --bin validate_testnet --release
```

What it does (`validate_testnet.rs`):
1. Compiles the MASM (`BattleshipScripts::compile()`)
2. Creates two clients (`setup_testnet_client("validate-a")`, `"validate-b"`), each with its own SQLite store and keystore, a fresh private game account (`create_game_account`) and a public `NoAuth` wallet (`create_wallet_account`)
3. Funds all four accounts from the faucet (`fund_from_faucet`): `/pow`, SHA-256 proof of work, `/get_tokens`, wait for the P2ID note, consume it (deploys the account)
4. Setup on both game accounts (`setup_game`), both wallets publish a stake note (`stake`, `TESTNET_STAKE` = 2,000) and discover each other's
5. Handshake: A publishes the challenge, B consumes it; B publishes the acceptance, A consumes it and fires turn 1 in the same transaction (`submit_move`)
6. Checks that A cannot reclaim its own shot before the deadline (`reclaim` must fail with `ERR_FORFEIT_TOO_EARLY`, matched by `is_masm_error` -- the client prints the bare error code)
7. Gameplay: 17 hits by A, 16 misses by B, one transaction per move (`plan_resolution` + `plan_shot` -> `submit_move`), asserting every shot and result note's storage
8. A processes the final result; A's wallet consumes the defeat note and both stake notes (`claim`) and ends up richer by both stakes minus the fee
9. Prints `DONE in <n>s: full staked game validated on testnet`

A run takes about 6 minutes.

State lives in `testnet-store-validate-{a,b}.sqlite3` and `testnet-keystore-validate-{a,b}/` under `project-template/`. Every run creates new accounts, so an old store can be kept; delete the files if a store from an older SDK version fails to open.

## Step 2: Verification Checklist

- [ ] `sync_state()` succeeds (node reachable, no version mismatch)
- [ ] All four faucet claims land and the funding notes are consumed (balances printed, ~9,895 after the deploy transaction)
- [ ] Setup: phase `CHALLENGED`, game id, opponent, owner wallet stored, roots pinned
- [ ] Stakes: both stake notes discovered by the other wallet
- [ ] Handshake: B `ACTIVE` as acceptor with A's wallet stored, A `ACTIVE` as challenger with `shots_fired == 1`, `last_shot.turn == 1`
- [ ] Early reclaim rejected with the deadline error code
- [ ] Each move: the defender discovers the shot note with the expected turn, the shooter discovers the result note, the decoded result matches
- [ ] After the 17th hit: B `COMPLETE` / `LOST`, 17 hits, the defeat note created alongside the result note
- [ ] A `COMPLETE` / `WON` after the final result; A's wallet balance grows by both stakes minus the fee
- [ ] No prover timeouts, no `429` loops from the faucet

## Step 3: Adapting the binary

When the contracts change, change `validate_testnet.rs` with them: its `Validator` methods (`setup`, `send_handshake`, `discover`, `play`) are thin wrappers over `helpers.rs` (`run_tx_script`, `publish_note`, `submit_move`, `plan_shot`, `plan_resolution`, `reclaim`, `stake`, `claim`, `wait_for_note`). Keep an `ensure!` on the storage after every step; a step that only "does not error" proves nothing. Anything the browser does must be expressible with the same helpers.

For a manual check of the same flow, play the CLI from two terminals (or against the web frontend):
```bash
cargo run --bin battleship_cli --release -- --player alice --role challenger --game-id demo --stake 2000
cargo run --bin battleship_cli --release -- --player bob --role acceptor --game-id demo --stake 2000
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Unavailable` / connection error on sync | No network or testnet down | Check `https://status.testnet.miden.io`; retry |
| Version or accept-header error on the first RPC | `miden-client` version does not match the node | Keep `integration/Cargo.toml` on the client version the testnet runs |
| Faucet `5xx` or `/get_tokens` fails after a valid PoW | Faucet outage, not your change | Wait and retry; `request_faucet_tokens` retries 429 |
| `timed out ... waiting for a consumable note` | Funding note not yet committed, or wrong faucet amount | Check the faucet note on midenscan; amount must be <= 10,000 |
| `failed to prove transaction` / deadline | Remote prover overloaded | Retry; `PROVER_TIMEOUT` is 300 s |
| `timed out ... waiting for a note` between players | Note tag or sender mismatch, a predicted note (`expected_*_note`) that differs from what the component created, or the note was published from the wrong account | Compare serial (`own_serial`), storage and script root with the MASM; verify `NoteTag::with_account_target(target)` |
| Bare `assertion failed with error code: N` | The client has no source manager; `N = blake3(message)[0..8]` LE | `masm_error_code("<ERR_... message>")` / `is_masm_error`; reproduce in a failure test |
| `handshake seed does not derive the opponent id` | The two sides built the account differently (storage slot order, schema component) | Compare `init_storage_commitment()` (`print_init_storage_commitment`) with the frontend's `[Contracts] Initial storage commitment` log |
| MASM assertion in the executor | Contract rejected the step (phase, turn, sender, deadline) | Read the `ERR_...` message; reproduce in a failure test first |
| Store fails to open / deserialization error | Store written by an older SDK | Delete `testnet-store-validate-*.sqlite3` and `testnet-keystore-validate-*/` |
