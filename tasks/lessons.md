# Lessons Learned

## Miden SDK: Note scripts with branching and return values

**Problem**: When a `#[note_script]` has if/else branches where one branch calls a component method returning a `Felt` and other branches call void methods, the Miden WASM-to-MASM compiler generates invalid code. The transaction fails with `assertion failed at clock cycle N with error code: 0`.

**Root cause**: Mismatched stack effects across if/else branches in compiled MASM.

**Fix**: Use separate dedicated note scripts for methods that return values (e.g., `process_shot` → `shot-test-note`). Do NOT mix returning and void method calls in the same if/else dispatcher note.

**Applies to**: Any note script that dispatches to multiple component methods with different return types.

## Miden SDK: CLI cargo-miden v0.4.0 broken with nightly-2025-12-10

The CLI `cargo miden build` panics with `panic_immediate_abort is now a real panic strategy!`. Use the cargo-miden library v0.7 (`build_project_in_dir()`) instead. The build hook fires on every contract edit and fails — this is ignorable.

## MockChain: Notes must be added before build()

`MockChainBuilder.add_output_note()` must be called BEFORE `builder.build()`. There is no `mock_chain.add_output_note()` method on the built MockChain.

## Miden SDK: Felt::new() vs Felt::from_u64_unchecked()

In contract code (`#![no_std]`), `Felt::new(x)` returns `Result<Felt, FeltError>` — use `Felt::from_u64_unchecked(x)` for runtime values and `felt!(N)` for compile-time constants. In test code (std), `Felt::new(x)` returns `Felt` directly.

## MockChain: output_note::create requires extend_expected_output_notes

**Problem**: When a note script calls `output_note::create()` to create an output note, the transaction kernel needs the full NoteScript details in the advice provider. Without it, execution fails with "public note ... is missing details in the advice provider".

**Fix**: Pre-construct the expected output note (with correct serial_num, NoteScript, NoteInputs, NoteMetadata) and pass it via `build_tx_context(...).extend_expected_output_notes(vec![OutputNote::Full(expected_note)])`. The sender in NoteMetadata is the executing account (defender), not the original note sender.

**Implication**: The test must know the expected result in advance to construct the note. For process_shot, this means knowing whether the shot hits or misses (predictable from the board layout).

## MockChain: Unique seeds for multi-account tests

`create_testing_account_from_package` uses hardcoded seed `[3u8; 32]`. Two accounts with the same component and storage get the same AccountId. For multi-account tests, use `AccountBuilder::new(unique_seed)` directly (e.g., `[1u8; 32]` and `[2u8; 32]`).

## MockChain: create_testing_note_from_package uses zero serial numbers

`create_testing_note_from_package()` uses `[0u64; 4]` as the serial number (despite the comment saying "random"). Two notes with the same script and same inputs will have the same nullifier, causing "note with nullifier ... is already spent" errors. Differentiate notes by adding unique inputs (extra unused Felts) or using different scripts.

## Real Node: expected_output_recipients replaces extend_expected_output_notes

On MockChain, note-creates-note uses `extend_expected_output_notes(vec![OutputNote::Full(note)])` on the TxContextBuilder. On a real node with `TransactionRequestBuilder`, use `expected_output_recipients(vec![NoteRecipient])` instead. This only validates that the VM's output matches expectations — the actual note creation happens inside the VM natively via `output_note::create()`.

## Real Node: Binary working directory vs test working directory

Tests run from `integration/` so contract paths use `../contracts/<name>`. Binaries run from workspace root (`project-template/`) so they need `contracts/<name>`. Use `build_all_packages_from(Path::new("contracts"))` in binaries vs `build_all_packages()` (which defaults to `../contracts`) in tests. Similarly, keystore/store paths should not use `../` prefix when running from workspace root.

## Real Node: Accounts need AuthFalcon512Rpo (not NoAuth)

MockChain tests use `NoAuth` for game accounts. On a real node, accounts that submit transactions need `AuthFalcon512Rpo` auth. Use `create_authenticated_game_account()` which combines the custom component + Falcon512 auth + keystore registration.

## MockChain: All Value storage slots must be initialized

When creating test accounts with `AccountCreationConfig`, ALL Value storage slots declared in the component must be listed in `storage_slots`, even if they're just defaults. Missing slots cause `StorageSlotNameNotFound` errors.
