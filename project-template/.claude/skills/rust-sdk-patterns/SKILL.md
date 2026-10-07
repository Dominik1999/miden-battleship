---
name: rust-sdk-patterns
description: Guide to writing the battleship contracts in Miden Assembly (MASM) and compiling them at runtime with miden-client 0.17's CodeBuilder. Covers account components (@account_procedure), note scripts (@note_script), transaction scripts (@transaction_script), storage access, note storage, output note creation, the advice map, and the Rust side (compile, link, account builder). Use when writing, editing, or reviewing contract code in contracts/masm/ or its Rust bindings in integration/src/battleship.rs.
---

# MASM Contract Patterns (miden 0.17)

The contracts are plain `.masm` files in `contracts/masm/`. Nothing is built ahead of time: `integration/src/battleship.rs` `include_str!`s them and `BattleshipScripts::compile()` assembles them with `CodeBuilder`. The working examples referenced below are the project's own sources.

## Three Script Kinds

### Account Component (`@account_procedure`)
A MASM module whose public procedures are installed on the account. See [battleship_account.masm](../../../contracts/masm/battleship_account.masm).

```masm
use {AccountId} from miden::protocol::types
use miden::core::sys
use miden::protocol::active_account
use miden::protocol::native_account

const GAME_ID_SLOT = word("miden_battleship_account::battleship_account::game_id")

#! Inputs:  [GAME_ID, pad(12)]
#! Outputs: [pad(16)]
#! Invocation: call
@account_procedure
pub proc store_game_id(game_id: word)
    push.GAME_ID_SLOT[0..2] exec.native_account::set_item dropw
    # => [pad(12)]
    exec.sys::truncate_stack
    # => [pad(16)]
end
```

Rules:
- Procedures are entered with `call` and see a **16-element stack window**; document `Inputs`/`Outputs` with `pad(n)` and end with `exec.sys::truncate_stack`.
- Read storage with `push.SLOT[0..2] exec.active_account::get_item`, write with `push.SLOT[0..2] exec.native_account::set_item dropw`.
- Storage maps used as arrays go through `miden::standards::data_structures::array` (`array::get` / `array::set` with key `[0, 0, 0, index]`), see `load_packed_row` and `set_board_rows`.
- Locals: `@locals(n)` + `locaddr.N mem_store/mem_load`; word-aligned locals for anything passed as a word (`PROCESS_SHOT_RESULT_STORAGE_LOC`).
- Imports: `miden::protocol::*` (kernel API wrappers), `miden::standards::*` (array, note_tag), `miden::core::{mem, sys}` (core library). See the `rust-sdk-source-guide` skill for where each lives.

**Rust side** (`battleship.rs`): `CodeBuilder::compile_component_code("battleship::account", ACCOUNT_MASM)` -> `AccountComponent::new(code, all_storage_slots(), AccountComponentMetadata::new(path))`. Storage slots are declared in Rust (`StorageSlot::with_value(name, Word::default())`, `StorageSlot::with_map(name, StorageMap::new())`) with the same names as the `word("...")` constants in the MASM.

### Note Script (`@note_script`)
Runs when the note is consumed; loads the note storage and `call`s one component procedure. See [shot_note.masm](../../../contracts/masm/shot_note.masm).

```masm
use {NoteArgs} from miden::protocol::types
use miden::protocol::active_note
use battleship::account as battleship

const STORAGE_PTR = 0
const NUM_STORAGE_ITEMS = 11
const ERR_WRONG_NUM_STORAGE_ITEMS = "shot note must carry exactly 11 storage items"

@note_script
pub proc main(args: NoteArgs)
    dropw
    push.NUM_STORAGE_ITEMS push.STORAGE_PTR exec.active_note::get_bounded_storage
    eq.NUM_STORAGE_ITEMS assert.err=ERR_WRONG_NUM_STORAGE_ITEMS
    # load the arguments from memory in reverse order, then
    call.battleship::process_shot
    dropw dropw dropw dropw
    # => [pad(16)]
end
```

**Rust side**: `CodeBuilder::with_dynamically_linked_package(&component_code)?.compile_note_script(source)` (`compile_note_script` in `battleship.rs`). Linking the component code makes `call.battleship::<proc>` resolve to the procedure roots installed on the account.

### Transaction Script (`@transaction_script`)
One-off logic on the native account. See [scripts/setup_tx.masm](../../../contracts/masm/scripts/setup_tx.masm) for a script that takes a word argument and a payload from the advice map, and [scripts/enter_reveal_tx.masm](../../../contracts/masm/scripts/enter_reveal_tx.masm) for the minimal shape.

```masm
@transaction_script
pub proc main(payload_key: word)
    adv.push_mapvaln                      # advice map entry under PAYLOAD_KEY -> advice stack
    adv_push u32assert eq.20 assert dropw # length check, drop the key
    push.0 push.5 exec.mem::pipe_words_to_memory dropw dropw dropw drop
    # ... build the call window from memory, call the component ...
end
```

**Rust side**: `compile_tx_script` in `battleship.rs`; run with `TransactionRequestBuilder::new().custom_script(script).script_arg(key).extend_advice_map([(key, payload)])` (client) or `MockTransactionBuilder::tx_script(..).tx_script_args(..).add_advice_map_entry(..)` (tests).

## Storage Patterns

| Need | MASM | Rust declaration |
|------|------|------------------|
| Flags / counters / ids | value slot, `get_item` / `set_item` | `StorageSlot::with_value(slot, Word::default())` |
| Indexed data (board rows) | map slot via `array::get/set`, key `[0,0,0,i]` | `StorageSlot::with_map(slot, StorageMap::new())` |

Slot names are `word("miden_battleship_account::battleship_account::<slot>")` and must match `battleship.rs` and `frontend-template/src/config.ts` byte for byte.

Pack small values: the board stores 10 cells x 3 bits in one felt per row (`u32shl`, `u32shr`, `u32and`, `u32or`, `u32not`), see `process_shot` and `count_row_cells`.

## Creating an Output Note from a Procedure

`process_shot` creates the public result note:
```masm
# [storage_ptr, num_storage_items, SERIAL_NUM, SCRIPT_ROOT, ...]
exec.note::compute_and_store_recipient
# => [RECIPIENT, ...]
exec.note_tag::create_account_target      # from [prefix, suffix] of the target account
push.NOTE_TYPE_PUBLIC swap
# => [tag, note_type, RECIPIENT, ...]
exec.output_note::create drop
```
The caller supplies the serial number and the script root in the input note's storage (`shot_storage`), so the consuming client can declare the exact output recipient (`expected_output_recipients` / `expected_output_note`).

## Note Storage Layouts (`battleship.rs`)

| Builder | Layout |
|---------|--------|
| `handshake_storage` | `[GAME_ID(4), sender_prefix, sender_suffix, COMMITMENT(4)]` |
| `shot_storage` | `[row, col, turn, RESULT_SERIAL_NUM(4), RESULT_SCRIPT_ROOT(4)]` |
| `result_storage` | `[shooter_prefix, shooter_suffix, turn, is_hit * 2 + game_over]` |
| reveal | `[COMMITMENT(4)]` |
| `build_setup_payload` (advice map) | `[GAME_ID(4), opponent_prefix, opponent_suffix, COMMITMENT(4), rows(10)]` |

Notes are assembled with `make_game_note(script, sender, target, storage, serial)`: `NoteAssets::default()`, `PartialNoteMetadata::new(sender, NoteType::Public).with_tag(NoteTag::with_account_target(target))`, `NoteRecipient::new(serial, script, NoteStorage::new(storage))`.

## Game Account

```rust
AccountBuilder::new(seed)
    .account_type(AccountType::Public)
    .with_component(component)   // battleship
    .with_component(BasicWallet) // receive the fee asset, send notes
    .with_component(NoAuth)      // no keys; pays the fee from the vault
```
`build_existing()` in MockChain tests, `build()` + `client.add_account(&account, false)` on testnet (deployed by its first transaction).

## Common Type Conversions (Rust)

```rust
Felt::new(42)?                      // fallible in 0.17; `felt(u64)` in battleship.rs panics on overflow
Word::from([f0, f1, f2, f3])        // `word([u64; 4])` helper
felt.as_canonical_u64()             // felt -> u64
id.prefix().as_felt(), id.suffix()  // AccountId -> (prefix, suffix) felts
Word::from(note_script.root())      // script root as a word (for shot storage)
Hasher::hash_elements(&felts)       // miden_protocol::Hasher, sequential Poseidon2 hash
```

## Validation Checklist

- [ ] Every procedure has a `#!` doc block with `Inputs`, `Outputs`, `Panics if`, `Invocation`
- [ ] Every `assert*` carries an `.err=ERR_...` constant with a human-readable message
- [ ] Stack comments (`# => [...]`) are correct on every line that changes the stack
- [ ] `exec.sys::truncate_stack` at the end of every `@account_procedure`; scripts end on `[pad(16)]`
- [ ] Note scripts check `NUM_STORAGE_ITEMS`
- [ ] New slots are declared in `all_storage_slots()` and `battleshipStorageSlots()` (frontend)
- [ ] `cargo test -p integration --release` passes, with a new test per new check
