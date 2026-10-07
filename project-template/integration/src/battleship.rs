//! Shared battleship game logic for binaries and tests: MASM sources, compile helpers, storage
//! layout, note-storage builders and a structured view of a game account's state.

use anyhow::{Context, Result};
use miden_client::{
    account::{
        component::{AccountComponentMetadata, BasicWallet, NoAuth},
        Account, AccountBuilder, AccountComponent, AccountComponentCode, AccountId, AccountType,
        StorageMap, StorageMapKey, StorageSlot, StorageSlotName,
    },
    assembly::CodeBuilder,
    note::{
        Note, NoteAssets, NoteRecipient, NoteScript, NoteStorage, NoteTag, NoteType,
        PartialNoteMetadata,
    },
    transaction::TransactionScript,
    Felt, Word,
};
use miden_protocol::Hasher;

// ============================================================================
// Game constants (mirror contracts/masm/battleship_account.masm)
// ============================================================================

pub const PHASE_CREATED: u64 = 0;
pub const PHASE_CHALLENGED: u64 = 1;
pub const PHASE_ACTIVE: u64 = 2;
pub const PHASE_REVEAL: u64 = 3;
pub const PHASE_COMPLETE: u64 = 4;

pub const CELL_WATER: u64 = 0;
pub const CELL_HIT: u64 = 6;
pub const CELL_MISS: u64 = 7;
pub const CELL_BITS: u64 = 3;
pub const CELL_MASK: u64 = 7;

pub const GRID_SIZE: u64 = 10;
pub const TOTAL_SHIP_CELLS: u64 = 17;
pub const SHIP_SIZES: [u64; 5] = [5, 4, 3, 3, 2];

/// Expected incoming turn right after the handshake (the challenger fires turn 1).
pub const ACCEPTOR_FIRST_TURN: u64 = 1;
pub const CHALLENGER_FIRST_TURN: u64 = 2;

/// Result note storage: `[shooter_prefix, shooter_suffix, turn, encoded_result]`.
pub const RESULT_NUM_STORAGE_ITEMS: usize = 4;
/// Shot note storage: `[row, col, turn, RESULT_SERIAL_NUM(4), RESULT_SCRIPT_ROOT(4)]`.
pub const SHOT_NUM_STORAGE_ITEMS: usize = 11;
/// Handshake note storage: `[GAME_ID(4), sender_prefix, sender_suffix, COMMITMENT(4)]`.
pub const HANDSHAKE_NUM_STORAGE_ITEMS: usize = 10;
/// Setup payload: `[GAME_ID(4), opponent_prefix, opponent_suffix, COMMITMENT(4), rows(10)]`.
pub const SETUP_PAYLOAD_NUM_ITEMS: usize = 20;

/// Encoded shot result: `is_hit * 2 + game_over`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShotResult {
    pub is_hit: bool,
    pub game_over: bool,
}

impl ShotResult {
    pub fn encode(self) -> u64 {
        (self.is_hit as u64) * 2 + self.game_over as u64
    }

    pub fn decode(encoded: u64) -> Self {
        Self {
            is_hit: encoded >= 2,
            game_over: encoded % 2 == 1,
        }
    }
}

// ============================================================================
// MASM sources and compilation
// ============================================================================

/// Module path under which the component is compiled; note and tx scripts `call` into it.
pub const COMPONENT_PATH: &str = "battleship::account";

pub const ACCOUNT_MASM: &str = include_str!("../../contracts/masm/battleship_account.masm");
pub const CHALLENGE_NOTE_MASM: &str = include_str!("../../contracts/masm/challenge_note.masm");
pub const ACCEPT_NOTE_MASM: &str = include_str!("../../contracts/masm/accept_note.masm");
pub const SHOT_NOTE_MASM: &str = include_str!("../../contracts/masm/shot_note.masm");
pub const RESULT_NOTE_MASM: &str = include_str!("../../contracts/masm/result_note.masm");
pub const REVEAL_NOTE_MASM: &str = include_str!("../../contracts/masm/reveal_note.masm");
pub const SETUP_TX_MASM: &str = include_str!("../../contracts/masm/scripts/setup_tx.masm");
pub const ENTER_REVEAL_TX_MASM: &str =
    include_str!("../../contracts/masm/scripts/enter_reveal_tx.masm");
pub const MARK_MY_REVEAL_TX_MASM: &str =
    include_str!("../../contracts/masm/scripts/mark_my_reveal_tx.masm");

/// Compiles the battleship account component code.
pub fn compile_component_code(builder: CodeBuilder) -> Result<AccountComponentCode> {
    builder
        .compile_component_code(COMPONENT_PATH, ACCOUNT_MASM)
        .map_err(|e| anyhow::anyhow!("failed to compile battleship component: {e}"))
}

/// Compiles the battleship account component with freshly initialized storage.
pub fn compile_component(builder: CodeBuilder) -> Result<AccountComponent> {
    let code = compile_component_code(builder)?;
    AccountComponent::new(
        code,
        all_storage_slots(),
        AccountComponentMetadata::new(COMPONENT_PATH),
    )
    .context("failed to build battleship account component")
}

/// Compiles a note script that `call`s into the battleship component.
pub fn compile_note_script(
    builder: CodeBuilder,
    component_code: &AccountComponentCode,
    source: &str,
) -> Result<NoteScript> {
    builder
        .with_dynamically_linked_package(component_code)
        .map_err(|e| anyhow::anyhow!("failed to link battleship component: {e}"))?
        .compile_note_script(source)
        .map_err(|e| anyhow::anyhow!("failed to compile note script: {e}"))
}

/// Compiles a transaction script that `call`s into the battleship component.
pub fn compile_tx_script(
    builder: CodeBuilder,
    component_code: &AccountComponentCode,
    source: &str,
) -> Result<TransactionScript> {
    builder
        .with_dynamically_linked_package(component_code)
        .map_err(|e| anyhow::anyhow!("failed to link battleship component: {e}"))?
        .compile_tx_script(source)
        .map_err(|e| anyhow::anyhow!("failed to compile tx script: {e}"))
}

/// All compiled battleship artifacts.
#[derive(Clone)]
pub struct BattleshipScripts {
    pub component: AccountComponent,
    pub component_code: AccountComponentCode,
    pub setup_tx: TransactionScript,
    pub enter_reveal_tx: TransactionScript,
    pub mark_my_reveal_tx: TransactionScript,
    pub challenge_note: NoteScript,
    pub accept_note: NoteScript,
    pub shot_note: NoteScript,
    pub result_note: NoteScript,
    pub reveal_note: NoteScript,
}

impl BattleshipScripts {
    /// Compiles every MASM source with a fresh default [`CodeBuilder`].
    pub fn compile() -> Result<Self> {
        Self::compile_with(CodeBuilder::default)
    }

    /// Compiles every MASM source, obtaining a fresh [`CodeBuilder`] from `new_builder` for each
    /// artifact (e.g. `|| client.code_builder()`).
    pub fn compile_with(mut new_builder: impl FnMut() -> CodeBuilder) -> Result<Self> {
        let component = compile_component(new_builder())?;
        let component_code = component.component_code().clone();
        let mut note = |src| compile_note_script(new_builder(), &component_code, src);
        let challenge_note = note(CHALLENGE_NOTE_MASM)?;
        let accept_note = note(ACCEPT_NOTE_MASM)?;
        let shot_note = note(SHOT_NOTE_MASM)?;
        let result_note = note(RESULT_NOTE_MASM)?;
        let reveal_note = note(REVEAL_NOTE_MASM)?;
        let mut tx = |src| compile_tx_script(new_builder(), &component_code, src);
        let setup_tx = tx(SETUP_TX_MASM)?;
        let enter_reveal_tx = tx(ENTER_REVEAL_TX_MASM)?;
        let mark_my_reveal_tx = tx(MARK_MY_REVEAL_TX_MASM)?;
        Ok(Self {
            component,
            component_code,
            setup_tx,
            enter_reveal_tx,
            mark_my_reveal_tx,
            challenge_note,
            accept_note,
            shot_note,
            result_note,
            reveal_note,
        })
    }

    /// The result note script root, as carried in shot-note storage.
    pub fn result_script_root(&self) -> Word {
        Word::from(self.result_note.root())
    }
}

// ============================================================================
// Storage slot names
// ============================================================================

fn slot(name: &str) -> StorageSlotName {
    StorageSlotName::new(name).expect("slot name is valid")
}
pub fn board_slot() -> StorageSlotName {
    slot("miden_battleship_account::battleship_account::my_board")
}
pub fn game_config_slot() -> StorageSlotName {
    slot("miden_battleship_account::battleship_account::game_config")
}
pub fn opponent_slot() -> StorageSlotName {
    slot("miden_battleship_account::battleship_account::opponent")
}
pub fn board_commitment_slot() -> StorageSlotName {
    slot("miden_battleship_account::battleship_account::board_commitment")
}
pub fn opponent_commitment_slot() -> StorageSlotName {
    slot("miden_battleship_account::battleship_account::opponent_commitment")
}
pub fn game_id_slot() -> StorageSlotName {
    slot("miden_battleship_account::battleship_account::game_id")
}
pub fn reveal_status_slot() -> StorageSlotName {
    slot("miden_battleship_account::battleship_account::reveal_status")
}

/// Initial storage of a fresh game account: all value slots zero, the board map empty.
pub fn all_storage_slots() -> Vec<StorageSlot> {
    vec![
        StorageSlot::with_value(game_config_slot(), Word::default()),
        StorageSlot::with_value(opponent_slot(), Word::default()),
        StorageSlot::with_value(board_commitment_slot(), Word::default()),
        StorageSlot::with_value(opponent_commitment_slot(), Word::default()),
        StorageSlot::with_value(game_id_slot(), Word::default()),
        StorageSlot::with_value(reveal_status_slot(), Word::default()),
        StorageSlot::with_map(board_slot(), StorageMap::new()),
    ]
}

/// Builds a game account: battleship component + `BasicWallet` (to receive the fee asset) +
/// `NoAuth`. Use `build()` for a new account and `build_existing()` in MockChain tests.
pub fn game_account_builder(seed: [u8; 32], component: AccountComponent) -> AccountBuilder {
    AccountBuilder::new(seed)
        .account_type(AccountType::Public)
        .with_component(component)
        .with_component(BasicWallet)
        .with_component(NoAuth)
}

// ============================================================================
// Felt helpers
// ============================================================================

/// Converts a small integer into a felt (panics above the field modulus; game values are tiny).
pub fn felt(value: u64) -> Felt {
    Felt::new(value).expect("value fits in the field")
}

pub fn word(values: [u64; 4]) -> Word {
    Word::from([
        felt(values[0]),
        felt(values[1]),
        felt(values[2]),
        felt(values[3]),
    ])
}

pub fn id_prefix(id: AccountId) -> Felt {
    id.prefix().as_felt()
}

pub fn id_suffix(id: AccountId) -> Felt {
    id.suffix()
}

// ============================================================================
// Ship placement and board packing
// ============================================================================

/// Classic ship placement: Carrier(5), Battleship(4), Cruiser(3), Submarine(3), Destroyer(2),
/// each on its own row starting at column 0. Returns (row, col, ship_id) tuples.
pub fn classic_ship_cells() -> Vec<(u64, u64, u64)> {
    let mut cells = Vec::new();
    for (i, size) in SHIP_SIZES.iter().enumerate() {
        for c in 0..*size {
            cells.push((i as u64, c, i as u64 + 1));
        }
    }
    cells
}

/// Packs ship cells into 10 row felts (cell `c` of a row occupies bits `3c..3c+2`).
pub fn pack_board(ship_cells: &[(u64, u64, u64)]) -> [u64; 10] {
    let mut rows = [0u64; 10];
    for (r, c, ship_id) in ship_cells {
        rows[*r as usize] |= ship_id << (c * CELL_BITS);
    }
    rows
}

pub fn cell_from_packed(packed: u64, col: u64) -> u64 {
    (packed >> (col * CELL_BITS)) & CELL_MASK
}

// ============================================================================
// Setup transaction payload
// ============================================================================

/// Builds the 20-felt setup payload consumed by `scripts/setup_tx.masm`.
pub fn build_setup_payload(
    game_id: Word,
    opponent: AccountId,
    commitment: Word,
    rows: &[u64; 10],
) -> Vec<Felt> {
    let mut payload = Vec::with_capacity(SETUP_PAYLOAD_NUM_ITEMS);
    payload.extend(game_id.iter().copied());
    payload.push(id_prefix(opponent));
    payload.push(id_suffix(opponent));
    payload.extend(commitment.iter().copied());
    payload.extend(rows.iter().map(|r| felt(*r)));
    debug_assert_eq!(payload.len(), SETUP_PAYLOAD_NUM_ITEMS);
    payload
}

/// The advice-map key under which a setup payload is provided, passed as the transaction script
/// argument. The script does not verify it (the account owner supplies both), so any word works;
/// the payload's sequential Poseidon2 hash keeps it deterministic.
pub fn setup_payload_commitment(payload: &[Felt]) -> Word {
    Hasher::hash_elements(payload)
}

// ============================================================================
// Note storage layouts
// ============================================================================

/// Challenge / accept note storage: `[GAME_ID(4), sender_prefix, sender_suffix, COMMITMENT(4)]`.
pub fn handshake_storage(game_id: Word, sender: AccountId, commitment: Word) -> Vec<Felt> {
    let mut items = Vec::with_capacity(HANDSHAKE_NUM_STORAGE_ITEMS);
    items.extend(game_id.iter().copied());
    items.push(id_prefix(sender));
    items.push(id_suffix(sender));
    items.extend(commitment.iter().copied());
    items
}

/// Shot note storage: `[row, col, turn, RESULT_SERIAL_NUM(4), RESULT_SCRIPT_ROOT(4)]`.
pub fn shot_storage(
    row: u64,
    col: u64,
    turn: u64,
    result_serial_num: Word,
    result_script_root: Word,
) -> Vec<Felt> {
    let mut items = Vec::with_capacity(SHOT_NUM_STORAGE_ITEMS);
    items.push(felt(row));
    items.push(felt(col));
    items.push(felt(turn));
    items.extend(result_serial_num.iter().copied());
    items.extend(result_script_root.iter().copied());
    items
}

/// Result note storage: `[shooter_prefix, shooter_suffix, turn, encoded_result]`.
pub fn result_storage(shooter: AccountId, turn: u64, result: ShotResult) -> Vec<Felt> {
    vec![
        id_prefix(shooter),
        id_suffix(shooter),
        felt(turn),
        felt(result.encode()),
    ]
}

/// Parsed shot-note storage.
#[derive(Debug, Clone, Copy)]
pub struct ShotNoteStorage {
    pub row: u64,
    pub col: u64,
    pub turn: u64,
    pub result_serial_num: Word,
    pub result_script_root: Word,
}

impl ShotNoteStorage {
    pub fn from_note(note: &Note) -> Result<Self> {
        let items = note.recipient().storage().items();
        anyhow::ensure!(
            items.len() == SHOT_NUM_STORAGE_ITEMS,
            "shot note has {} storage items, expected {}",
            items.len(),
            SHOT_NUM_STORAGE_ITEMS
        );
        Ok(Self {
            row: items[0].as_canonical_u64(),
            col: items[1].as_canonical_u64(),
            turn: items[2].as_canonical_u64(),
            result_serial_num: Word::from([items[3], items[4], items[5], items[6]]),
            result_script_root: Word::from([items[7], items[8], items[9], items[10]]),
        })
    }
}

/// Parsed result-note storage.
#[derive(Debug, Clone, Copy)]
pub struct ResultNoteStorage {
    pub shooter_prefix: Felt,
    pub shooter_suffix: Felt,
    pub turn: u64,
    pub result: ShotResult,
}

impl ResultNoteStorage {
    pub fn from_items(items: &[Felt]) -> Result<Self> {
        anyhow::ensure!(
            items.len() == RESULT_NUM_STORAGE_ITEMS,
            "result note has {} storage items, expected {}",
            items.len(),
            RESULT_NUM_STORAGE_ITEMS
        );
        Ok(Self {
            shooter_prefix: items[0],
            shooter_suffix: items[1],
            turn: items[2].as_canonical_u64(),
            result: ShotResult::decode(items[3].as_canonical_u64()),
        })
    }

    pub fn from_note(note: &Note) -> Result<Self> {
        Self::from_items(note.recipient().storage().items())
    }
}

// ============================================================================
// Note construction
// ============================================================================

/// Builds a public, asset-less note with the given script, storage, serial number and tag.
pub fn make_note(
    script: NoteScript,
    sender: AccountId,
    storage: Vec<Felt>,
    serial_num: Word,
    tag: NoteTag,
) -> Result<Note> {
    let storage = NoteStorage::new(storage).context("invalid note storage")?;
    let recipient = NoteRecipient::new(serial_num, script, storage);
    let metadata = PartialNoteMetadata::new(sender, NoteType::Public).with_tag(tag);
    Ok(Note::new(NoteAssets::default(), metadata, recipient))
}

/// Builds a game note (challenge, accept, shot, reveal) from `sender` targeting `target`'s
/// account via the note tag.
pub fn make_game_note(
    script: NoteScript,
    sender: AccountId,
    target: AccountId,
    storage: Vec<Felt>,
    serial_num: Word,
) -> Result<Note> {
    make_note(
        script,
        sender,
        storage,
        serial_num,
        NoteTag::with_account_target(target),
    )
}

/// The result note `process_shot` creates on `defender` for the shot by `shooter`.
pub fn expected_result_note(
    result_script: NoteScript,
    defender: AccountId,
    shooter: AccountId,
    turn: u64,
    result: ShotResult,
    serial_num: Word,
) -> Result<Note> {
    make_game_note(
        result_script,
        defender,
        shooter,
        result_storage(shooter, turn, result),
        serial_num,
    )
}

// ============================================================================
// Game state reading
// ============================================================================

/// Reads a board cell from the account's board map.
pub fn read_board_cell(account: &Account, row: u64, col: u64) -> u64 {
    let key = StorageMapKey::new(word([0, 0, 0, row]));
    let value = account
        .storage()
        .get_map_item(&board_slot(), key)
        .expect("board slot exists");
    cell_from_packed(value[0].as_canonical_u64(), col)
}

/// Structured view of a game account's storage state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameState {
    pub phase: u64,
    pub expected_turn: u64,
    pub opponent_prefix: Felt,
    pub opponent_suffix: Felt,
    pub ships_hit_count: u64,
    pub total_shots_received: u64,
    pub game_id: Word,
    pub board_commitment: Word,
    pub opponent_commitment: Word,
    pub my_revealed: u64,
    pub opponent_verified: u64,
}

impl GameState {
    pub fn from_account(account: &Account) -> Self {
        let storage = account.storage();
        let config = storage
            .get_item(&game_config_slot())
            .expect("game_config slot");
        let opp = storage.get_item(&opponent_slot()).expect("opponent slot");
        let reveal = storage
            .get_item(&reveal_status_slot())
            .expect("reveal_status slot");
        Self {
            phase: config[2].as_canonical_u64(),
            expected_turn: config[3].as_canonical_u64(),
            opponent_prefix: opp[0],
            opponent_suffix: opp[1],
            ships_hit_count: opp[2].as_canonical_u64(),
            total_shots_received: opp[3].as_canonical_u64(),
            game_id: storage.get_item(&game_id_slot()).expect("game_id slot"),
            board_commitment: storage
                .get_item(&board_commitment_slot())
                .expect("board_commitment slot"),
            opponent_commitment: storage
                .get_item(&opponent_commitment_slot())
                .expect("opponent_commitment slot"),
            my_revealed: reveal[0].as_canonical_u64(),
            opponent_verified: reveal[1].as_canonical_u64(),
        }
    }

    pub fn phase_name(&self) -> &'static str {
        match self.phase {
            PHASE_CREATED => "CREATED",
            PHASE_CHALLENGED => "CHALLENGED",
            PHASE_ACTIVE => "ACTIVE",
            PHASE_REVEAL => "REVEAL",
            PHASE_COMPLETE => "COMPLETE",
            _ => "UNKNOWN",
        }
    }

    pub fn opponent_is(&self, id: AccountId) -> bool {
        self.opponent_prefix == id_prefix(id) && self.opponent_suffix == id_suffix(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_masm_compiles() -> Result<()> {
        let scripts = BattleshipScripts::compile()?;
        assert_ne!(scripts.result_script_root(), Word::default());
        Ok(())
    }

    #[test]
    fn classic_board_packs_17_cells() {
        let rows = pack_board(&classic_ship_cells());
        let total: u64 = rows
            .iter()
            .map(|r| {
                (0..GRID_SIZE)
                    .filter(|c| cell_from_packed(*r, *c) != CELL_WATER)
                    .count() as u64
            })
            .sum();
        assert_eq!(total, TOTAL_SHIP_CELLS);
        assert_eq!(cell_from_packed(rows[0], 4), 1);
        assert_eq!(cell_from_packed(rows[4], 1), 5);
        assert_eq!(cell_from_packed(rows[4], 2), CELL_WATER);
    }

    #[test]
    fn shot_result_round_trips() {
        for encoded in 0..4 {
            assert_eq!(ShotResult::decode(encoded).encode(), encoded);
        }
    }
}
