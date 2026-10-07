//! Shared battleship game logic for binaries and tests: MASM sources, compile helpers, storage
//! layout, note-storage builders and a structured view of a game account's state.

use anyhow::{Context, Result};
use miden_client::{
    account::{
        component::{AccountComponentMetadata, BasicWallet, NoAuth},
        Account, AccountBuilder, AccountComponent, AccountComponentCode, AccountId, AccountStorage,
        AccountType, StorageMap, StorageMapKey, StorageSlot, StorageSlotName,
    },
    assembly::CodeBuilder,
    asset::Asset,
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
pub const PHASE_COMPLETE: u64 = 3;

pub const ROLE_CHALLENGER: u64 = 1;
pub const ROLE_ACCEPTOR: u64 = 2;

pub const OUTCOME_OPEN: u64 = 0;
pub const OUTCOME_WON: u64 = 1;
pub const OUTCOME_LOST: u64 = 2;
pub const OUTCOME_WON_BY_FORFEIT: u64 = 3;

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

/// Seconds a note must stay consumable before its sender may reclaim it (12 hours).
pub const DEADLINE_DELTA: u64 = 43_200;

/// Note kinds: `script_roots` map keys and serial-number kinds.
pub const ROOT_SHOT: u64 = 0;
pub const ROOT_RESULT: u64 = 1;
pub const ROOT_DEFEAT: u64 = 2;
pub const ROOT_FORFEIT: u64 = 3;
pub const SERIAL_KIND_SHOT: u64 = 1;
pub const SERIAL_KIND_RESULT: u64 = 2;
pub const SERIAL_KIND_DEFEAT: u64 = 3;
pub const SERIAL_KIND_FORFEIT: u64 = 4;

/// Storage sizes.
pub const SHOT_NUM_STORAGE_ITEMS: usize = 4;
pub const RESULT_NUM_STORAGE_ITEMS: usize = 5;
pub const WALLET_NOTE_NUM_STORAGE_ITEMS: usize = 2;
pub const HANDSHAKE_NUM_STORAGE_ITEMS: usize = 28;
pub const SETUP_PAYLOAD_NUM_ITEMS: usize = 36;

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

/// The component source with `{{ISCn}}` placeholders for the initial storage commitment.
pub const ACCOUNT_MASM_TEMPLATE: &str =
    include_str!("../../contracts/masm/battleship_account.masm");
pub const CHALLENGE_NOTE_MASM: &str = include_str!("../../contracts/masm/challenge_note.masm");
pub const ACCEPT_NOTE_MASM: &str = include_str!("../../contracts/masm/accept_note.masm");
pub const SHOT_NOTE_MASM: &str = include_str!("../../contracts/masm/shot_note.masm");
pub const RESULT_NOTE_MASM: &str = include_str!("../../contracts/masm/result_note.masm");
pub const DEFEAT_NOTE_MASM: &str = include_str!("../../contracts/masm/defeat_note.masm");
pub const FORFEIT_NOTE_MASM: &str = include_str!("../../contracts/masm/forfeit_note.masm");
pub const STAKE_NOTE_MASM_TEMPLATE: &str = include_str!("../../contracts/masm/stake_note.masm");
pub const SETUP_TX_MASM: &str = include_str!("../../contracts/masm/scripts/setup_tx.masm");
pub const FIRE_TX_MASM: &str = include_str!("../../contracts/masm/scripts/fire_tx.masm");

/// Commitment of a fresh game account's storage (all value slots zero, maps empty). Part of the
/// account-id derivation the handshake uses to anchor the opponent's code.
pub fn init_storage_commitment() -> Word {
    AccountStorage::new(all_storage_slots())
        .expect("initial storage is valid")
        .to_commitment()
}

/// The component source with the initial storage commitment filled in.
pub fn account_masm() -> String {
    let isc = init_storage_commitment();
    let mut source = ACCOUNT_MASM_TEMPLATE.to_string();
    for (i, felt) in isc.iter().enumerate() {
        source = source.replace(
            &format!("{{{{ISC{i}}}}}"),
            &felt.as_canonical_u64().to_string(),
        );
    }
    source
}

/// Compiles the battleship account component code.
pub fn compile_component_code(builder: CodeBuilder) -> Result<AccountComponentCode> {
    builder
        .compile_component_code(COMPONENT_PATH, account_masm())
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

/// The stake note source with the defeat and forfeit script roots filled in.
pub fn stake_note_masm(defeat: Word, forfeit: Word) -> String {
    let mut source = STAKE_NOTE_MASM_TEMPLATE.to_string();
    for (i, felt) in defeat.iter().enumerate() {
        source = source.replace(
            &format!("{{{{DEFEAT{i}}}}}"),
            &felt.as_canonical_u64().to_string(),
        );
    }
    for (i, felt) in forfeit.iter().enumerate() {
        source = source.replace(
            &format!("{{{{FORFEIT{i}}}}}"),
            &felt.as_canonical_u64().to_string(),
        );
    }
    source
}

/// Compiles the stake note script (it does not call into the component).
pub fn compile_stake_script(
    builder: CodeBuilder,
    defeat: Word,
    forfeit: Word,
) -> Result<NoteScript> {
    builder
        .compile_note_script(stake_note_masm(defeat, forfeit))
        .map_err(|e| anyhow::anyhow!("failed to compile stake note script: {e}"))
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

/// Script roots of the notes a game account creates, in `script_roots` map order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptRoots {
    pub shot: Word,
    pub result: Word,
    pub defeat: Word,
    pub forfeit: Word,
}

impl ScriptRoots {
    /// The 16 felts `[SHOT, RESULT, DEFEAT, FORFEIT]` as carried in payloads and notes.
    pub fn felts(&self) -> Vec<Felt> {
        [self.shot, self.result, self.defeat, self.forfeit]
            .iter()
            .flat_map(|w| w.iter().copied())
            .collect()
    }
}

/// All compiled battleship artifacts.
#[derive(Clone)]
pub struct BattleshipScripts {
    pub component: AccountComponent,
    pub component_code: AccountComponentCode,
    pub setup_tx: TransactionScript,
    pub fire_tx: TransactionScript,
    pub challenge_note: NoteScript,
    pub accept_note: NoteScript,
    pub shot_note: NoteScript,
    pub result_note: NoteScript,
    pub defeat_note: NoteScript,
    pub forfeit_note: NoteScript,
    pub stake_note: NoteScript,
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
        let defeat_note = note(DEFEAT_NOTE_MASM)?;
        let forfeit_note = note(FORFEIT_NOTE_MASM)?;
        let stake_note = compile_stake_script(
            new_builder(),
            Word::from(defeat_note.root()),
            Word::from(forfeit_note.root()),
        )?;
        let mut tx = |src| compile_tx_script(new_builder(), &component_code, src);
        let setup_tx = tx(SETUP_TX_MASM)?;
        let fire_tx = tx(FIRE_TX_MASM)?;
        Ok(Self {
            component,
            component_code,
            setup_tx,
            fire_tx,
            challenge_note,
            accept_note,
            shot_note,
            result_note,
            defeat_note,
            forfeit_note,
            stake_note,
        })
    }

    pub fn roots(&self) -> ScriptRoots {
        ScriptRoots {
            shot: Word::from(self.shot_note.root()),
            result: Word::from(self.result_note.root()),
            defeat: Word::from(self.defeat_note.root()),
            forfeit: Word::from(self.forfeit_note.root()),
        }
    }
}

// ============================================================================
// Storage slot names
// ============================================================================

fn slot(name: &str) -> StorageSlotName {
    StorageSlotName::new(format!(
        "miden_battleship_account::battleship_account::{name}"
    ))
    .expect("slot name is valid")
}
pub fn game_config_slot() -> StorageSlotName {
    slot("game_config")
}
pub fn opponent_slot() -> StorageSlotName {
    slot("opponent")
}
pub fn game_id_slot() -> StorageSlotName {
    slot("game_id")
}
pub fn owner_wallet_slot() -> StorageSlotName {
    slot("owner_wallet")
}
pub fn opponent_wallet_slot() -> StorageSlotName {
    slot("opponent_wallet")
}
pub fn turn_state_slot() -> StorageSlotName {
    slot("turn_state")
}
pub fn last_shot_slot() -> StorageSlotName {
    slot("last_shot")
}
pub fn outcome_slot() -> StorageSlotName {
    slot("outcome")
}
pub fn board_slot() -> StorageSlotName {
    slot("my_board")
}
pub fn my_shots_slot() -> StorageSlotName {
    slot("my_shots")
}
pub fn script_roots_slot() -> StorageSlotName {
    slot("script_roots")
}

/// Initial storage of a fresh game account: all value slots zero, the maps empty.
pub fn all_storage_slots() -> Vec<StorageSlot> {
    vec![
        StorageSlot::with_value(game_config_slot(), Word::default()),
        StorageSlot::with_value(opponent_slot(), Word::default()),
        StorageSlot::with_value(game_id_slot(), Word::default()),
        StorageSlot::with_value(owner_wallet_slot(), Word::default()),
        StorageSlot::with_value(opponent_wallet_slot(), Word::default()),
        StorageSlot::with_value(turn_state_slot(), Word::default()),
        StorageSlot::with_value(last_shot_slot(), Word::default()),
        StorageSlot::with_value(outcome_slot(), Word::default()),
        StorageSlot::with_map(board_slot(), StorageMap::new()),
        StorageSlot::with_map(my_shots_slot(), StorageMap::new()),
        StorageSlot::with_map(script_roots_slot(), StorageMap::new()),
    ]
}

/// Builds a PRIVATE game account: battleship component + `BasicWallet` (to receive the fee
/// asset) + `NoAuth`. Use `build()`; the account's seed (`account.seed()`) is carried in the
/// handshake notes so the opponent can verify the code anchoring.
pub fn game_account_builder(seed: [u8; 32], component: AccountComponent) -> AccountBuilder {
    AccountBuilder::new(seed)
        .account_type(AccountType::Private)
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

/// Serial number a game account gives the notes it creates: `[prefix, suffix, turn, kind]`.
pub fn own_serial(account: AccountId, turn: u64, kind: u64) -> Word {
    Word::from([
        id_prefix(account),
        id_suffix(account),
        felt(turn),
        felt(kind),
    ])
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
// Transaction payloads and arguments
// ============================================================================

/// Builds the 36-felt setup payload consumed by `scripts/setup_tx.masm`.
pub fn build_setup_payload(
    game_id: Word,
    opponent: AccountId,
    owner_wallet: AccountId,
    rows: &[u64; 10],
    roots: &ScriptRoots,
) -> Vec<Felt> {
    let mut payload = Vec::with_capacity(SETUP_PAYLOAD_NUM_ITEMS);
    payload.extend(game_id.iter().copied());
    payload.push(id_prefix(opponent));
    payload.push(id_suffix(opponent));
    payload.push(id_prefix(owner_wallet));
    payload.push(id_suffix(owner_wallet));
    payload.extend(rows.iter().map(|r| felt(*r)));
    payload.extend(roots.felts());
    payload.extend([felt(0), felt(0)]);
    debug_assert_eq!(payload.len(), SETUP_PAYLOAD_NUM_ITEMS);
    payload
}

/// The advice-map key under which a setup payload is provided, passed as the transaction script
/// argument. The script does not verify it (the account owner supplies both), so any word works;
/// the payload's sequential Poseidon2 hash keeps it deterministic.
pub fn setup_payload_commitment(payload: &[Felt]) -> Word {
    Hasher::hash_elements(payload)
}

/// Transaction script argument of `scripts/fire_tx.masm`.
pub fn fire_args(row: u64, col: u64, deadline: u64) -> Word {
    word([row, col, deadline, 0])
}

/// Note argument the defender passes when consuming a shot note: the deadline it gives the
/// shooter to answer the result note.
pub fn shot_note_args(result_deadline: u64) -> Word {
    word([result_deadline; 4])
}

// ============================================================================
// Note storage layouts
// ============================================================================

/// Challenge / accept note storage:
/// `[GAME_ID(4), sender_prefix, sender_suffix, SEED(4), wallet_prefix, wallet_suffix, ROOTS(16)]`.
pub fn handshake_storage(
    game_id: Word,
    sender: AccountId,
    seed: Word,
    wallet: AccountId,
    roots: &ScriptRoots,
) -> Vec<Felt> {
    let mut items = Vec::with_capacity(HANDSHAKE_NUM_STORAGE_ITEMS);
    items.extend(game_id.iter().copied());
    items.push(id_prefix(sender));
    items.push(id_suffix(sender));
    items.extend(seed.iter().copied());
    items.push(id_prefix(wallet));
    items.push(id_suffix(wallet));
    items.extend(roots.felts());
    debug_assert_eq!(items.len(), HANDSHAKE_NUM_STORAGE_ITEMS);
    items
}

/// Shot note storage: `[row, col, turn, deadline]`.
pub fn shot_storage(row: u64, col: u64, turn: u64, deadline: u64) -> Vec<Felt> {
    vec![felt(row), felt(col), felt(turn), felt(deadline)]
}

/// Result note storage: `[shooter_prefix, shooter_suffix, turn, encoded_result, deadline]`.
pub fn result_storage(
    shooter: AccountId,
    turn: u64,
    result: ShotResult,
    deadline: u64,
) -> Vec<Felt> {
    vec![
        id_prefix(shooter),
        id_suffix(shooter),
        felt(turn),
        felt(result.encode()),
        felt(deadline),
    ]
}

/// Stake note storage: both wallets, both game accounts and the expiry timestamp.
pub const STAKE_NUM_STORAGE_ITEMS: usize = 9;
pub fn stake_storage(
    my_wallet: AccountId,
    my_game: AccountId,
    opp_wallet: AccountId,
    opp_game: AccountId,
    expiry: u64,
) -> Vec<Felt> {
    vec![
        id_prefix(my_wallet),
        id_suffix(my_wallet),
        id_prefix(my_game),
        id_suffix(my_game),
        id_prefix(opp_wallet),
        id_suffix(opp_wallet),
        id_prefix(opp_game),
        id_suffix(opp_game),
        felt(expiry),
    ]
}

/// Builds a stake note created by `my_wallet`, holding `asset`, tagged for the opponent's wallet.
pub fn make_stake_note(
    scripts: &BattleshipScripts,
    my_wallet: AccountId,
    my_game: AccountId,
    opp_wallet: AccountId,
    opp_game: AccountId,
    expiry: u64,
    asset: Asset,
    serial_num: Word,
) -> Result<Note> {
    let storage = NoteStorage::new(stake_storage(
        my_wallet, my_game, opp_wallet, opp_game, expiry,
    ))
    .context("invalid stake storage")?;
    let recipient = NoteRecipient::new(serial_num, scripts.stake_note.clone(), storage);
    let metadata = PartialNoteMetadata::new(my_wallet, NoteType::Public)
        .with_tag(NoteTag::with_account_target(opp_wallet));
    let assets = NoteAssets::new(vec![asset]).context("invalid stake assets")?;
    Ok(Note::new(assets, metadata, recipient))
}

/// Defeat / forfeit note storage: `[wallet_prefix, wallet_suffix]`.
pub fn wallet_note_storage(wallet: AccountId) -> Vec<Felt> {
    vec![id_prefix(wallet), id_suffix(wallet)]
}

/// Parsed handshake-note storage.
#[derive(Debug, Clone)]
pub struct HandshakeStorage {
    pub game_id: Word,
    pub sender: AccountId,
    pub seed: Word,
    pub wallet: AccountId,
    pub roots: ScriptRoots,
}

fn word_at(items: &[Felt], at: usize) -> Word {
    Word::from([items[at], items[at + 1], items[at + 2], items[at + 3]])
}

fn id_at(items: &[Felt], at: usize) -> Result<AccountId> {
    AccountId::try_from_elements(items[at + 1], items[at])
        .map_err(|e| anyhow::anyhow!("invalid account id: {e}"))
}

impl HandshakeStorage {
    pub fn from_note(note: &Note) -> Result<Self> {
        let items = note.recipient().storage().items();
        anyhow::ensure!(
            items.len() == HANDSHAKE_NUM_STORAGE_ITEMS,
            "handshake note has {} storage items, expected {}",
            items.len(),
            HANDSHAKE_NUM_STORAGE_ITEMS
        );
        Ok(Self {
            game_id: word_at(items, 0),
            sender: id_at(items, 4)?,
            seed: word_at(items, 6),
            wallet: id_at(items, 10)?,
            roots: ScriptRoots {
                shot: word_at(items, 12),
                result: word_at(items, 16),
                defeat: word_at(items, 20),
                forfeit: word_at(items, 24),
            },
        })
    }
}

/// Parsed shot-note storage.
#[derive(Debug, Clone, Copy)]
pub struct ShotNoteStorage {
    pub row: u64,
    pub col: u64,
    pub turn: u64,
    pub deadline: u64,
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
            deadline: items[3].as_canonical_u64(),
        })
    }
}

/// Parsed result-note storage.
#[derive(Debug, Clone, Copy)]
pub struct ResultNoteStorage {
    pub shooter: AccountId,
    pub turn: u64,
    pub result: ShotResult,
    pub deadline: u64,
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
            shooter: id_at(items, 0)?,
            turn: items[2].as_canonical_u64(),
            result: ShotResult::decode(items[3].as_canonical_u64()),
            deadline: items[4].as_canonical_u64(),
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

/// Builds a game note from `sender` targeting `target`'s account via the note tag.
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

/// The shot note `fire_shot` creates on `shooter` for `defender`.
pub fn expected_shot_note(
    scripts: &BattleshipScripts,
    shooter: AccountId,
    defender: AccountId,
    row: u64,
    col: u64,
    turn: u64,
    deadline: u64,
) -> Result<Note> {
    make_game_note(
        scripts.shot_note.clone(),
        shooter,
        defender,
        shot_storage(row, col, turn, deadline),
        own_serial(shooter, turn, SERIAL_KIND_SHOT),
    )
}

/// The result note `process_shot` creates on `defender` for `shooter`.
pub fn expected_result_note(
    scripts: &BattleshipScripts,
    defender: AccountId,
    shooter: AccountId,
    turn: u64,
    result: ShotResult,
    deadline: u64,
) -> Result<Note> {
    make_game_note(
        scripts.result_note.clone(),
        defender,
        shooter,
        result_storage(shooter, turn, result, deadline),
        own_serial(defender, turn, SERIAL_KIND_RESULT),
    )
}

/// The defeat note `process_shot` creates on `loser` for `winner_wallet` on the 17th hit.
pub fn expected_defeat_note(
    scripts: &BattleshipScripts,
    loser: AccountId,
    winner_wallet: AccountId,
) -> Result<Note> {
    make_game_note(
        scripts.defeat_note.clone(),
        loser,
        winner_wallet,
        wallet_note_storage(winner_wallet),
        own_serial(loser, 0, SERIAL_KIND_DEFEAT),
    )
}

/// The forfeit note `claim_forfeit` creates on `claimant` for its `owner_wallet`.
pub fn expected_forfeit_note(
    scripts: &BattleshipScripts,
    claimant: AccountId,
    owner_wallet: AccountId,
) -> Result<Note> {
    make_game_note(
        scripts.forfeit_note.clone(),
        claimant,
        owner_wallet,
        wallet_note_storage(owner_wallet),
        own_serial(claimant, 0, SERIAL_KIND_FORFEIT),
    )
}

// ============================================================================
// Game state reading
// ============================================================================

fn map_key(index: u64) -> StorageMapKey {
    StorageMapKey::new(word([0, 0, 0, index]))
}

/// Reads a board cell from the account's board map.
pub fn read_board_cell(account: &Account, row: u64, col: u64) -> u64 {
    let value = account
        .storage()
        .get_map_item(&board_slot(), map_key(row))
        .expect("board slot exists");
    cell_from_packed(value[0].as_canonical_u64(), col)
}

/// Reads whether this account fired at (row, col) and whether that shot hit.
pub fn read_my_shot(account: &Account, row: u64, col: u64) -> (bool, bool) {
    let value = account
        .storage()
        .get_map_item(&my_shots_slot(), map_key(row))
        .expect("my_shots slot exists");
    let fired = (value[0].as_canonical_u64() >> col) & 1 == 1;
    let hit = (value[1].as_canonical_u64() >> col) & 1 == 1;
    (fired, hit)
}

/// Reads a stored script root.
pub fn read_script_root(account: &Account, kind: u64) -> Word {
    account
        .storage()
        .get_map_item(&script_roots_slot(), map_key(kind))
        .expect("script_roots slot exists")
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
    pub owner_wallet: Option<AccountId>,
    pub opponent_wallet: Option<AccountId>,
    pub shots_fired: u64,
    pub results_processed: u64,
    pub role: u64,
    pub last_shot: (u64, u64, u64),
    pub outcome: u64,
}

fn id_from_slot(value: Word) -> Option<AccountId> {
    if value[0] == Felt::ZERO {
        return None;
    }
    AccountId::try_from_elements(value[1], value[0]).ok()
}

impl GameState {
    pub fn from_account(account: &Account) -> Self {
        let storage = account.storage();
        let item = |s: StorageSlotName| storage.get_item(&s).expect("slot exists");
        let config = item(game_config_slot());
        let opp = item(opponent_slot());
        let turn_state = item(turn_state_slot());
        let last_shot = item(last_shot_slot());
        Self {
            phase: config[2].as_canonical_u64(),
            expected_turn: config[3].as_canonical_u64(),
            opponent_prefix: opp[0],
            opponent_suffix: opp[1],
            ships_hit_count: opp[2].as_canonical_u64(),
            total_shots_received: opp[3].as_canonical_u64(),
            game_id: item(game_id_slot()),
            owner_wallet: id_from_slot(item(owner_wallet_slot())),
            opponent_wallet: id_from_slot(item(opponent_wallet_slot())),
            shots_fired: turn_state[0].as_canonical_u64(),
            results_processed: turn_state[1].as_canonical_u64(),
            role: turn_state[2].as_canonical_u64(),
            last_shot: (
                last_shot[0].as_canonical_u64(),
                last_shot[1].as_canonical_u64(),
                last_shot[2].as_canonical_u64(),
            ),
            outcome: item(outcome_slot())[0].as_canonical_u64(),
        }
    }

    pub fn phase_name(&self) -> &'static str {
        match self.phase {
            PHASE_CREATED => "CREATED",
            PHASE_CHALLENGED => "CHALLENGED",
            PHASE_ACTIVE => "ACTIVE",
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
        let roots = scripts.roots();
        assert_ne!(roots.shot, roots.result);
        assert_ne!(roots.defeat, roots.forfeit);
        assert_ne!(init_storage_commitment(), Word::default());
        Ok(())
    }

    #[test]
    fn init_storage_commitment_matches_a_built_account() -> Result<()> {
        let scripts = BattleshipScripts::compile()?;
        let account = game_account_builder([7; 32], scripts.component.clone()).build()?;
        assert_eq!(account.storage().to_commitment(), init_storage_commitment());
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
