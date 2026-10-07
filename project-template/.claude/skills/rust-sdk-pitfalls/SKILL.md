---
name: rust-sdk-pitfalls
description: Critical pitfalls and safety rules for the MASM contracts and their miden-client 0.17 bindings. Covers modular felt arithmetic, the 16-element call window, stack hygiene, storage slot naming, advice-map payloads, output notes created by account code, fees, note discovery and dynamic linking. Use when reviewing, debugging, or writing contract code or integration code.
---

# MASM and Client Pitfalls

## P1: Felt Arithmetic is Modular (SECURITY CRITICAL)

Field subtraction wraps around p = 2^64 - 2^32 + 1; `lt`/`gt` on raw felts are not integer comparisons. Use the u32 instruction family for counts, coordinates and bit fields.

```masm
# DANGEROUS
dup push.GRID_SIZE lt assert          # felt comparison

# SAFE — assert_in_bounds in battleship_account.masm
u32assert2.err=ERR_ROW_OUT_OF_BOUNDS
dup push.GRID_SIZE u32lt assert.err=ERR_ROW_OUT_OF_BOUNDS
```

**Rule**: `u32assert` an input before any `u32lt`/`u32lte`/`u32shr`/`u32and`; never subtract without a prior bound check.

## P2: The 16-Element Call Window

`call` exposes exactly 16 stack elements to the callee and expects 16 back. Arguments that do not fill the window must be padded (`pad(n)` in the doc comments), and the caller must `dropw` the returned padding.

```masm
# WRONG — 11 arguments, no padding: the callee reads garbage
call.battleship::process_shot

# CORRECT — shot_note.masm
padw push.0                           # pad(5)
... push the 11 arguments ...
call.battleship::process_shot
dropw dropw dropw dropw               # drop the 16 returned elements
```

A mistake here surfaces as a wrong-phase/wrong-turn assertion far from the real bug: check the window first.

## P3: Stack Hygiene

Every `@account_procedure` must end with `exec.sys::truncate_stack`; every script must leave `[pad(16)]`. Keep the `# => [...]` comments exact — they are the only type system MASM has, and the reviewer reads them.

## P4: Storage Slot Naming

Slot names are arbitrary strings, but three places must agree: the `word("...")` constants in the MASM, `all_storage_slots()` in `battleship.rs`, and `SLOT_*` in `frontend-template/src/config.ts`. A mismatch is a runtime "slot not found" or a silent zero read, not a compile error.

Current pattern: `miden_battleship_account::battleship_account::<slot>`.

## P5: Advice Map Payloads

A transaction script argument is one word. Larger inputs go through the advice map: insert `(key, payload)` and pass `key` as the script arg; the script loads it with `adv.push_mapvaln` and `mem::pipe_words_to_memory` (word-aligned destination, payload length a multiple of 4).

The setup script does **not** check that `key` is a hash of the payload: the account owner supplies both. Any word works (random in the browser, `Hasher::hash_elements(payload)` in Rust).

## P6: Output Notes Created by Account Code

When a procedure calls `output_note::create`, the executor must know the output note's script:
- MockChain: `MockTransactionBuilder::add_note_script(result_script)` or `expected_output_note(RawOutputNote::Full(note))`
- Client: `TransactionRequestBuilder::expected_output_recipients([recipient])`

Without it the transaction fails with a "not found in data store" style error. The consumer can only declare the recipient if it knows the serial number and script root — which is why the shot note carries both.

## P7: Fees

Every transaction pays `base_fee * (ilog2(cycles) + 1)` in the fee asset; `NoAuth` pays from the vault. Consequences:
- A fresh account must receive the fee asset *before* its first transaction (faucet P2ID note), and that first transaction consumes the note and deploys the account.
- MockChain tests use `MockChain::builder().verification_base_fee(100)` and fund accounts with `with_assets([FungibleAsset::new(fee_faucet_id(), amount)?])`; with base fee 0 a transaction that changes nothing fails with "neither changed the account state, nor consumed any notes".
- Testnet: ~105 base units per battleship transaction, 10,000 per faucet claim.

## P8: Note Discovery

A note reaches a client through its tag. Use `NoteTag::with_account_target(recipient)` and the recipient finds it with `sync_state()` + `get_input_notes(NoteFilter::Committed)` — no `add_note_tag` call is needed. But:
- One client tracking both players' accounts never sees a component-created note (the result note) of one account as an input note of the other. One store per player.
- A note published from the wrong account has the wrong `sender`, and `assert_sender_is_opponent` rejects it on consumption.

## P9: Dynamic Linking

Note and tx scripts must be compiled with the *same* component code that is installed on the account (`CodeBuilder::with_dynamically_linked_package(&component_code)`). Compiling the component twice from the same source gives the same roots, but always link the `component_code` from the `BattleshipScripts` you deploy with; the browser caches one "library" component for this reason (`ContractCompiler`).

## P10: Error Messages are Matched Verbatim

`assert_masm_error(result, "shot turn does not match the expected turn")` compares the message with `MasmError::matches_execution_error`. Changing an `ERR_...` string without updating the test (or the frontend's error handling) breaks the test suite, not the contract.

## Quick Reference

| Pitfall | One-Line Rule |
|---------|--------------|
| P1 Felt arithmetic | `u32assert` first, then `u32lt`/`u32lte`; never raw `lt` or unchecked `sub` |
| P2 Call window | pad to 16 on entry, `dropw` x4 after `call` |
| P3 Stack hygiene | `exec.sys::truncate_stack`; keep `# => [...]` exact |
| P4 Slot names | MASM, `battleship.rs`, `config.ts` must agree |
| P5 Advice map | key as script arg, payload word-aligned, no preimage check |
| P6 Output notes | declare the result note's script/recipient to the executor |
| P7 Fees | fund before the first tx; MockChain base fee 100 |
| P8 Discovery | account-target tags, one client per player |
| P9 Linking | link the deployed component code into every script |
| P10 Errors | tests match `ERR_...` messages verbatim |
