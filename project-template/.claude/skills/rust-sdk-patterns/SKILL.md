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
- Locals: `@locals(n)` + `locaddr.N mem_store/mem_load`; word-aligned locals for anything passed as a word (`NOTE_STORAGE_LOC`, `SEED_PREIMAGE_LOC`).
- Imports: `miden::protocol::*` (kernel API wrappers: `active_account`, `native_account`, `active_note`, `note`, `output_note`, `tx`, `account_id`), `miden::standards::*` (array, note_tag), `miden::core::{crypto::hashes::poseidon2, mem, sys}` (core library). See the `rust-sdk-source-guide` skill for where each lives.
- Block time: `exec.tx::get_block_timestamp` is the reference block's timestamp (deadlines, `assert_deadline`, `claim_forfeit`).
- The component source is a template: `{{ISC0..3}}` is the initial storage commitment, filled in by `account_masm()` before assembling; `assert_seed_derives_opponent` hashes `(SEED, code commitment, ISC)` with `poseidon2::permute` exactly like the kernel's `validate_seed`.

**Rust side** (`battleship.rs`): `CodeBuilder::compile_component_code("battleship::account", account_masm())` -> `AccountComponent::new(code, all_storage_slots(), AccountComponentMetadata::new(path))`. Storage slots are declared in Rust (`StorageSlot::with_value(name, Word::default())`, `StorageSlot::with_map(name, StorageMap::new())`) with the same names as the `word("...")` constants in the MASM; their order determines `init_storage_commitment()`.

### Note Script (`@note_script`)
Runs when the note is consumed; loads the note storage and `call`s one component procedure. See [shot_note.masm](../../../contracts/masm/shot_note.masm).

```masm
use {NoteArgs} from miden::protocol::types
use miden::protocol::active_note
use battleship::account as battleship

const STORAGE_PTR = 0
const NUM_STORAGE_ITEMS = 4           # [row, col, turn, deadline]
const ERR_WRONG_NUM_STORAGE_ITEMS = "shot note must carry exactly 4 storage items"

@note_script
pub proc main(args: NoteArgs)
    movdn.3 drop drop drop                # keep NOTE_ARGS[0]: the result deadline
    push.NUM_STORAGE_ITEMS push.STORAGE_PTR exec.active_note::get_bounded_storage
    eq.NUM_STORAGE_ITEMS assert.err=ERR_WRONG_NUM_STORAGE_ITEMS
    exec.active_note::get_sender exec.active_account::get_id exec.account_id::eq
    if.true
        # the sender consumes its own note after the deadline
        ... call.battleship::claim_forfeit
    else
        # load the arguments from memory in reverse order, then
        ... call.battleship::process_shot
    end
    dropw dropw dropw dropw
    # => [pad(16)]
end
```

Note arguments (`NoteArgs`, a word set per input note by the consumer: `extend_note_args` / `NoteAndArgs`) carry data the consumer chooses at consumption time, here the deadline of the result note. The handshake scripts `call` two procedures in a row (`assert_script_roots`, then the handshake procedure), each with its own 16-element window.

**Rust side**: `CodeBuilder::with_dynamically_linked_package(&component_code)?.compile_note_script(source)` (`compile_note_script` in `battleship.rs`). Linking the component code makes `call.battleship::<proc>` resolve to the procedure roots installed on the account. Scripts that do not call the component (`defeat_note`, `forfeit_note`, `stake_note`) are compiled with a plain builder; the stake note is a template whose `{{DEFEATn}}` / `{{FORFEITn}}` placeholders take the roots of the two other scripts (`stake_note_masm`), and the defeat/forfeit scripts differ only by a structural `NOTE_KIND` constant because assertion messages are not part of the MAST root.

### Transaction Script (`@transaction_script`)
One-off logic on the native account. See [scripts/setup_tx.masm](../../../contracts/masm/scripts/setup_tx.masm) for a script that takes a word argument and a payload from the advice map, and [scripts/fire_tx.masm](../../../contracts/masm/scripts/fire_tx.masm) for the minimal shape (the word argument `[row, col, deadline, 0]` is the whole call window).

```masm
@transaction_script
pub proc main(payload_key: word)
    adv.push_mapvaln                      # advice map entry under PAYLOAD_KEY -> advice stack
    adv_push u32assert eq.36 assert dropw # length check, drop the key
    push.0 push.9 exec.mem::pipe_words_to_memory dropw dropw dropw drop
    # ... build the call windows from memory, call set_board_rows, set_script_roots, finalize_board ...
end
```

**Rust side**: `compile_tx_script` in `battleship.rs`; run with `TransactionRequestBuilder::new().custom_script(script).script_arg(key).extend_advice_map([(key, payload)])` (client) or `MockTransactionBuilder::tx_script(..).tx_script_args(..).add_advice_map_entry(..)` (tests). A transaction script can run in the same transaction that consumes notes: a move is `input_notes(..)` + `expected_output_recipients(..)` + `custom_script(fire_tx).script_arg(fire_args(..))` (`Move` / `submit_move` in `helpers.rs`).

## Storage Patterns

| Need | MASM | Rust declaration |
|------|------|------------------|
| Flags / counters / ids | value slot, `get_item` / `set_item` | `StorageSlot::with_value(slot, Word::default())` |
| Indexed data (board rows) | map slot via `array::get/set`, key `[0,0,0,i]` | `StorageSlot::with_map(slot, StorageMap::new())` |

Slot names are `word("miden_battleship_account::battleship_account::<slot>")` and must match `battleship.rs` and `frontend-template/src/config.ts` byte for byte.

Pack small values: the board stores 10 cells x 3 bits in one felt per row (`u32shl`, `u32shr`, `u32and`, `u32or`, `u32not`), see `process_shot` and `count_row_cells`.

## Creating an Output Note from a Procedure

The component creates every shot, result, defeat and forfeit note itself (`emit_note` / `emit_wallet_note`):
```masm
# [storage_ptr, num_storage_items, SERIAL_NUM, SCRIPT_ROOT, target_prefix, ...]
exec.note::compute_and_store_recipient
# => [RECIPIENT, target_prefix, ...]
movup.4 exec.note_tag::create_account_target      # from the prefix of the target account
push.NOTE_TYPE_PUBLIC swap
# => [tag, note_type, RECIPIENT, ...]
exec.output_note::create drop
```
The serial number is deterministic (`own_serial`: `[my_prefix, my_suffix, turn, kind]`) and the script root comes from the `script_roots` map pinned at setup, so both clients can predict the note (`expected_shot_note`, `expected_result_note`, `expected_defeat_note`, `expected_forfeit_note`) and declare it up front (`expected_output_recipients` / `expected_output_note`). A note can only be created by a transaction that knows its full recipient, which is why the setup payload and the handshake carry the roots.

## Note Storage Layouts (`battleship.rs`)

| Builder | Layout |
|---------|--------|
| `handshake_storage` (challenge, accept) | `[GAME_ID(4), sender_prefix, sender_suffix, SEED(4), wallet_prefix, wallet_suffix, SHOT_ROOT(4), RESULT_ROOT(4), DEFEAT_ROOT(4), FORFEIT_ROOT(4)]` (28) |
| `shot_storage` | `[row, col, turn, deadline]` |
| `result_storage` | `[shooter_prefix, shooter_suffix, turn, is_hit * 2 + game_over, deadline]` |
| `wallet_note_storage` (defeat, forfeit) | `[wallet_prefix, wallet_suffix]` |
| `stake_storage` | `[my_wallet(2), my_game(2), opp_wallet(2), opp_game(2), expiry]` (9) |
| `build_setup_payload` (advice map) | `[GAME_ID(4), opponent(2), owner_wallet(2), rows(10), SHOT/RESULT/DEFEAT/FORFEIT roots(16), pad(2)]` (36) |
| `fire_args` (tx script arg) / `shot_note_args` (note arg) | `[row, col, deadline, 0]` / `[result_deadline; 4]` |

Handshake notes are assembled by the client with `make_game_note(script, sender, target, storage, serial)`: `NoteAssets::default()`, `PartialNoteMetadata::new(sender, NoteType::Public).with_tag(NoteTag::with_account_target(target))`, `NoteRecipient::new(serial, script, NoteStorage::new(storage))`. The stake note (`make_stake_note`) is the only game note with assets. Parsers: `HandshakeStorage`, `ShotNoteStorage`, `ResultNoteStorage` (`from_note`).

## Game Account

```rust
AccountBuilder::new(seed)
    .account_type(AccountType::Private)
    .with_component(component)   // battleship
    .with_component(BasicWallet) // receive the fee asset, send notes
    .with_component(NoAuth)      // no keys; pays the fee from the vault
```
Always `build()` (`game_account_builder`): the account is deployed by its first transaction, in MockChain tests (genesis P2ID funding note) as on testnet (`client.add_account(&account, false)` + faucet note). Keep `account.seed()`: the handshake notes carry it, and the opponent recomputes the id from (seed, code commitment, `init_storage_commitment()`). The web SDK must build with `buildWithoutSchemaCommitment()` to get the same commitment (`init_storage_commitment_matches_a_built_account`, `print_init_storage_commitment`).

Wallets (`create_wallet_account`) are ordinary public `BasicWallet` + `NoAuth` accounts: they receive defeat/forfeit notes and hold the stakes.

## Common Type Conversions (Rust)

```rust
Felt::new(42)?                      // fallible in 0.17; `felt(u64)` in battleship.rs panics on overflow
Word::from([f0, f1, f2, f3])        // `word([u64; 4])` helper
felt.as_canonical_u64()             // felt -> u64
id.prefix().as_felt(), id.suffix()  // AccountId -> (prefix, suffix) felts
Word::from(note_script.root())      // script root as a word (pinned at setup, carried in the handshake)
Hasher::hash_elements(&felts)       // miden_protocol::Hasher, sequential Poseidon2 hash
account.seed()                      // Option<Word>: the seed of a new account, for the handshake
AccountStorage::new(slots)?.to_commitment()   // init_storage_commitment()
masm_error_code("<ERR_ message>")   // blake3(message)[0..8] LE: what a client without sources prints
```

## Validation Checklist

- [ ] Every procedure has a `#!` doc block with `Inputs`, `Outputs`, `Panics if`, `Invocation`
- [ ] Every `assert*` carries an `.err=ERR_...` constant with a human-readable message
- [ ] Stack comments (`# => [...]`) are correct on every line that changes the stack
- [ ] `exec.sys::truncate_stack` at the end of every `@account_procedure`; scripts end on `[pad(16)]`
- [ ] Note scripts check `NUM_STORAGE_ITEMS`
- [ ] New slots are declared in `all_storage_slots()` and `battleshipStorageSlots()` (frontend)
- [ ] `cargo test -p integration --release` passes, with a new test per new check
