---
name: rust-sdk-source-guide
description: Guide for advanced MASM contract development using source repo exploration. Covers AI development practices (Plan Mode, verification-driven development, context engineering, sub-agents) and maps the Miden source repositories (miden-base kernel and standards, miden-client, miden-vm) for discovering kernel procedures, stack contracts and client APIs. Use when a change needs a kernel or standard-library procedure not yet used in this project, or anything beyond the patterns in the other skills.
---

# Advanced MASM Development: Source-Guided Context Engineering

## Development Approach

### 1. Plan Mode First

For any non-trivial contract change, start in Plan Mode before writing MASM.

- Read the existing procedure you are extending and its tests
- Design the storage change and the note flow; write the stack contract (`Inputs`/`Outputs`) of each new procedure before the body
- Identify which kernel/standard procedures you need and look up their exact stack signatures in `miden-base`

Rule of thumb: if the task touches a storage layout, a note layout or a procedure signature, plan first — three places (MASM, `battleship.rs`, `frontend-template/src/config.ts`) must change together.

### 2. Verification-Driven Development

**Assemble loop**: `cargo test -p integration --release --lib all_masm_compiles` runs in seconds and surfaces every assembly error (unknown procedure, bad import, wrong constant). If it fails:
1. Read the error; the assembler names the module and line
2. Find the procedure's definition in `miden-base` (import path + stack contract)
3. Fix and re-run

**Test loop**: `cargo test -p integration --release`. When a test fails:
1. Is it an assembly error, a MASM assertion (`ERR_...` message), or a harness error (fee, missing note script, note not found)?
2. For an assertion: check the call window padding and the stack comments before suspecting the logic
3. For a harness error: compare against `tests/common/mod.rs` (`publish`, `consume`, `consume_shot`)

**Gate**: `cargo run --bin validate_testnet --release` before any frontend work.

### 3. Context Engineering with Source Repos

The skills (`rust-sdk-patterns`, `rust-sdk-pitfalls`, `rust-sdk-testing-patterns`, `miden-concepts`, `local-node-validation`) cover this project's patterns. For anything else, Miden's source repositories are the knowledge base.

- Don't load entire repos into context. Use sub-agents to explore: "Find the stack contract of `miden::protocol::output_note::create` in miden-base 0.17".
- Read source files only when you need a specific answer (progressive disclosure).
- Prefer working MASM (kernel, standards, tests) over documentation; adapt, don't guess.

### 4. Iterative Multi-Stage Development

1. **Design** (Plan Mode) — storage, note layouts, procedure signatures
2. **Component** — the `@account_procedure`s and their `ERR_...` constants
3. **Scripts** — note scripts / tx scripts that build the call window
4. **Rust bindings** — `battleship.rs` builders, parsers, `BattleshipScripts`
5. **Tests** — harness helper + success test + failure test per assertion
6. **Testnet** — `validate_testnet.rs`, then the frontend mirror

---

## Miden Source Repository Map

Clone the repos at the versions this project uses (`integration/Cargo.toml`: protocol/standards/testing 0.17.1, client 0.17.2).

```bash
git clone --depth 1 --branch v0.17.1 https://github.com/0xMiden/miden-base.git ../miden-base
git clone --depth 1 --branch v0.17.2 https://github.com/0xMiden/miden-client.git ../miden-client
git clone --depth 1 https://github.com/0xMiden/miden-vm.git ../miden-vm
```

(If a tag does not exist under that name, check `git ls-remote --tags` and pick the matching release; `main` may already be a newer, incompatible protocol version.) The published crates are also readable without cloning under `~/.cargo/registry/src/*/` (`miden-protocol-0.17.1/asm/`, `miden-standards-0.17.1/asm/`, `miden-core-lib-0.35.0/asm/`).

### `miden-base/` — Protocol, Kernel and Standards

Crate layouts (same in the registry copies `miden-protocol-0.17.1/`, `miden-standards-0.17.1/`):

- **`miden-protocol/asm/protocol/src/`** — the `miden::protocol::*` modules the contracts import: `active_account.masm` (`get_item`), `native_account.masm` (`set_item`), `active_note.masm` (`get_bounded_storage`, `get_sender`), `output_note.masm` (`create`), `note.masm` (`compute_and_store_recipient`, `NOTE_TYPE_PUBLIC`), `types.masm` (`AccountId`, `NoteArgs`, `NoteSerialNumber`, `NoteScriptRoot`). Each procedure's doc block gives its stack contract.
- **`miden-protocol/asm/kernels/transaction/lib/api.masm`** — the kernel procedures behind those wrappers; read when you need to know what a call really checks or writes.
- **`miden-standards/asm/standards/`** — `data_structures/` (`array::get`/`array::set`), `note/note_tag.masm` (`create_account_target`), `wallets/`, `fees/`, `notes/` (P2ID, P2IDE, SWAP), `tx_scripts/`; **`asm/components/`** — `BasicWallet`, `NoAuth` and the other account components. Read these for idiomatic MASM against the same kernel (locals, `@locals`, error constants, doc blocks).
- **`miden-testing/`** — `MockChain`, `MockTransactionBuilder`; its `tests/` show fee payment with `NoAuth`, custom scripts and error matching.
- **`miden-tx/`** — executor and host; read only when an error comes from the executor rather than from MASM.

### `miden-vm/` — Assembler, Core Library and Instruction Set

- **`miden-core-lib/asm/`** (registry: `miden-core-lib-0.35.0/asm/`) — `mem.masm` (`miden::core::mem::pipe_words_to_memory`) and `sys/mod.masm` (`miden::core::sys::truncate_stack`).
- `docs/` — instruction reference (`u32*`, `adv.push_mapvaln`, `cdrop`, `movup`/`movdn`, `locaddr`), procedure attributes and typed signatures.

### `miden-client/` — Client Library

- `crates/rust-client/src/` — `Client`, `ClientBuilder` (`for_testnet`, `sqlite_store`, `prover`), `TransactionRequestBuilder` (`own_output_notes`, `build_consume_notes`, `input_notes`, `expected_output_recipients`, `custom_script`, `script_arg`, `extend_advice_map`), `code_builder()`, sync and note filters.
- `crates/web-client/` — the WASM bindings the frontend uses (`CodeBuilder`, `AccountBuilder`, `TransactionRequestBuilder`, `feeAwareTransactionRequestBuilder`); check here when a browser method differs from the Rust one.
- `bin/miden-cli/` — CLI reference usage of the same APIs.

---

## What to Explore for Each Task

| Building This | Explore | What to Look For |
|---|---|---|
| New account procedure | `asm/protocol/src/{active_account,native_account}.masm`, `miden-standards/asm/components/` | procedure signatures, storage access idioms |
| New note kind | `miden-standards/asm/standards/notes/` (P2ID), this project's `shot_note.masm` | storage loading, sender checks, call window |
| Output note from a procedure | `asm/protocol/src/{output_note,note}.masm`, `process_shot` | recipient computation, tag creation, `create` |
| Transaction script with payload | `miden-core-lib/asm/mem.masm`, `setup_tx.masm` | advice map, `pipe_words_to_memory` |
| Harness changes | `miden-testing/tests/`, `tests/common/mod.rs` | `MockTransactionBuilder` options, fee setup |
| Client flow | `miden-client` `rust-client`, `helpers.rs` | request builders, sync, note filters, prover |
| Browser mirror | `miden-client` `web-client`, `frontend-template/src/lib/` | WASM method names, by-value handle semantics |

---

## Common Advanced Patterns

### Multi-Component Accounts
The game account composes a custom component with `BasicWallet` and `NoAuth` (`game_account_builder`). Standard components are MASM too; their procedures (`receive_asset`, `move_asset_to_note`) are what `own_output_notes` / fee payment use.

### Output Note Creation from Account Code
`process_shot` computes the recipient from a serial number and script root passed in by the shooter, tags the note to the stored opponent and calls `output_note::create`. The consuming client declares the recipient so the executor can materialize the note.

### Note Storage Protocol
Each note script fixes its storage length and layout; builders and parsers in `battleship.rs` (`*_storage`, `ShotNoteStorage`, `ResultNoteStorage`) and the frontend (`src/lib/notes.ts`, `src/lib/game.ts`) are the two mirrors.

### Sender Authentication
`active_note::get_sender` compared against stored state (`assert_sender_is_opponent`) replaces signatures for note-driven interactions between two known accounts.
