---
name: local-node-validation
description: Validates the battleship contracts against the real Miden testnet with the validate_testnet binary. Covers why MockChain is not enough, the two-client setup, faucet funding and fees, the verification checklist and troubleshooting. Use after MockChain tests pass and before frontend work; there is no local-node step with miden-node 0.17.
---

# Testnet Validation (formerly local-node validation)

Validates that contracts working in MockChain also work against a real node. `miden-node` 0.17 has no `bundled` mode, so the gate runs against **testnet** instead of a local node: `integration/src/bin/validate_testnet.rs` plays a full game between two independent clients and asserts the on-chain state after every step. The frontend mirrors this binary step for step, so anything that fails here fails in the browser too.

## Why This Matters

MockChain simplifies execution in ways that hide real-world failures:

1. **No block production delay** -- MockChain commits with `prove_next_block()`. On testnet a transaction commits seconds later and a note becomes visible only after sync.
2. **No note discovery** -- in MockChain the test holds the `Note`. On testnet the recipient must find it through its account-target tag during `sync_state()`.
3. **No proving** -- MockChain only executes. Testnet transactions are proven by the remote prover (tens of seconds each; 300 s timeout in `helpers.rs`).
4. **No fees to earn** -- MockChain accounts are funded at genesis. On testnet a fresh account must claim USDCx from the faucet, and its first transaction (consuming the funding note) is what deploys it.
5. **No version/protocol check** -- testnet enforces the client/node version compatibility and the protocol config (fee asset).
6. **Two players, two stores** -- a single client tracking both accounts never sees a component-created note (the result note) from one account as an input note of the other.

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
1. Compiles the MASM (`BattleshipScripts::compile()`) and prints the result note script root
2. Creates two clients (`setup_testnet_client("validate-a")`, `"validate-b"`), each with its own SQLite store and keystore, and one fresh game account each
3. Funds both from the faucet (`fund_from_faucet`): `/pow`, SHA-256 proof of work, `/get_tokens`, wait for the P2ID note, consume it (deploys the account)
4. Setup on both accounts, challenge/accept handshake, 17 shots by A with B missing in between, `enter_reveal`, reveal notes, `mark_my_reveal`, cross verification
5. Asserts phase, expected turn, commitments, counters and board cells after every step; prints `DONE: both accounts COMPLETE` with the remaining fee balances

A run takes about 8–9 minutes (see `tasks/research/validate-testnet-run.log` for a reference run: 510 s, ~105 base units per transaction).

State lives in `testnet-store-validate-{a,b}.sqlite3` and `testnet-keystore-validate-{a,b}/` under `project-template/`. Every run creates new accounts, so an old store can be kept; delete the files if a store from an older SDK version fails to open.

## Step 2: Verification Checklist

- [ ] `sync_state()` succeeds (node reachable, no version mismatch)
- [ ] Both faucet claims land and the funding notes are consumed (balances printed, ~9,895 after the deploy transaction)
- [ ] Setup: phase `CHALLENGED`, game id, commitment and opponent stored
- [ ] Handshake: B `ACTIVE` with expected turn 1, A `ACTIVE` with expected turn 2, commitments swapped
- [ ] Each shot: the defender discovers the shot note, the shooter discovers the result note, the decoded result matches
- [ ] After the 17th hit: B in `REVEAL`, 17 hits / 17 shots, cell (0,0) `HIT`, A cell (9,0) `MISS`
- [ ] Reveal: both accounts `COMPLETE`
- [ ] No prover timeouts, no `429` loops from the faucet

## Step 3: Adapting the binary

When the contracts change, change `validate_testnet.rs` with them: the flow helpers (`setup`, `send`, `consume`, `fire`, `reveal_note`) are thin wrappers over `helpers.rs` (`run_tx_script`, `publish_note`, `consume_notes`, `consume_shot_note`, `wait_for_note`). Keep an `ensure!` on the storage after every step; a step that only "does not error" proves nothing.

For a manual check of the same flow, play the CLI from two terminals:
```bash
cargo run --bin battleship_cli --release -- --player alice --role challenger --game-id demo
cargo run --bin battleship_cli --release -- --player bob --role acceptor --game-id demo
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Unavailable` / connection error on sync | No network or testnet down | Check `https://status.testnet.miden.io`; retry |
| Version or accept-header error on the first RPC | `miden-client` version does not match the node | Keep `integration/Cargo.toml` on the client version the testnet runs |
| Faucet `5xx` or `/get_tokens` fails after a valid PoW | Faucet outage, not your change | Wait and retry; `request_faucet_tokens` retries 429 six times |
| `timed out ... waiting for a consumable note` | Funding note not yet committed, or wrong faucet amount | Check the faucet note on midenscan; amount must be <= 10,000 |
| `failed to prove transaction` / deadline | Remote prover overloaded | Retry; `PROVER_TIMEOUT` is 300 s |
| `timed out ... waiting for a note` between players | Note tag or sender mismatch, or the note was published from the wrong account | Verify `NoteTag::with_account_target(target)` and that the publishing account is the sender the recipient expects |
| MASM assertion in the executor | Contract rejected the step (phase, turn, sender) | Read the `ERR_...` message; reproduce in a failure test first |
| Store fails to open / deserialization error | Store written by an older SDK | Delete `testnet-store-validate-*.sqlite3` and `testnet-keystore-validate-*/` |
