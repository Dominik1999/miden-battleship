//! Shared battleship game logic for binaries and tests.

use crate::helpers::build_project_in_dir;
use miden_client::{
    account::{StorageMap, StorageSlot, StorageSlotName},
    note::NoteScript,
    Felt, Word,
};
use std::{path::Path, sync::Arc};

// ============================================================================
// Game phase constants
// ============================================================================

pub const PHASE_CREATED: u64 = 0;
pub const PHASE_CHALLENGED: u64 = 1;
pub const PHASE_ACTIVE: u64 = 2;
pub const PHASE_REVEAL: u64 = 3;
pub const PHASE_COMPLETE: u64 = 4;

// ============================================================================
// Storage slot names
// ============================================================================

pub fn board_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::my_board").unwrap()
}
pub fn game_config_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::game_config").unwrap()
}
pub fn opponent_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::opponent").unwrap()
}
pub fn board_commitment_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::board_commitment").unwrap()
}
pub fn opponent_commitment_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::opponent_commitment").unwrap()
}
pub fn game_id_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::game_id").unwrap()
}
pub fn reveal_status_slot() -> StorageSlotName {
    StorageSlotName::new("miden_battleship_account::battleship_account::reveal_status").unwrap()
}

// ============================================================================
// Storage initialization
// ============================================================================

pub fn all_storage_slots() -> Vec<StorageSlot> {
    vec![
        StorageSlot::with_value(game_config_slot(), Word::default()),
        StorageSlot::with_value(opponent_slot(), Word::default()),
        StorageSlot::with_value(board_commitment_slot(), Word::default()),
        StorageSlot::with_value(opponent_commitment_slot(), Word::default()),
        StorageSlot::with_value(game_id_slot(), Word::default()),
        StorageSlot::with_value(reveal_status_slot(), Word::default()),
        StorageSlot::with_map(board_slot(), StorageMap::with_entries([]).unwrap()),
    ]
}

// ============================================================================
// Ship placement
// ============================================================================

/// Classic ship placement: Carrier(5), Battleship(4), Cruiser(3), Submarine(3), Destroyer(2)
/// Returns (row, col, ship_id) tuples.
pub fn classic_ship_cells() -> Vec<(u64, u64, u64)> {
    let mut cells = Vec::new();
    for c in 0..5 { cells.push((0, c, 1)); } // Carrier
    for c in 0..4 { cells.push((1, c, 2)); } // Battleship
    for c in 0..3 { cells.push((2, c, 3)); } // Cruiser
    for c in 0..3 { cells.push((3, c, 4)); } // Submarine
    for c in 0..2 { cells.push((4, c, 5)); } // Destroyer
    cells
}

/// Build the input vector for the setup-note.
/// Layout: [game_id(4), opp_prefix, opp_suffix, commitment(4), (row, col, ship_id) × N]
pub fn build_setup_inputs(
    game_id: Word,
    opp_prefix: u64,
    opp_suffix: u64,
    commitment: Word,
    ship_cells: &[(u64, u64, u64)],
) -> Vec<Felt> {
    let mut inputs = Vec::new();
    for f in game_id.iter() { inputs.push(*f); }
    inputs.push(Felt::new(opp_prefix));
    inputs.push(Felt::new(opp_suffix));
    for f in commitment.iter() { inputs.push(*f); }
    for (r, c, s) in ship_cells {
        inputs.push(Felt::new(*r));
        inputs.push(Felt::new(*c));
        inputs.push(Felt::new(*s));
    }
    inputs
}

// ============================================================================
// Package building
// ============================================================================

pub struct AllPackages {
    pub contract: Arc<miden_mast_package::Package>,
    pub setup_note: Arc<miden_mast_package::Package>,
    pub action_note: Arc<miden_mast_package::Package>,
    pub shot_note: Arc<miden_mast_package::Package>,
    pub result_note: Arc<miden_mast_package::Package>,
    pub challenge_note: Arc<miden_mast_package::Package>,
    pub accept_note: Arc<miden_mast_package::Package>,
    pub reveal_note: Arc<miden_mast_package::Package>,
}

/// Build all packages. `base` is the path prefix to contracts directory.
/// From tests: `../contracts`, from binaries: `contracts`.
pub fn build_all_packages_from(base: &Path) -> anyhow::Result<AllPackages> {
    Ok(AllPackages {
        contract: Arc::new(build_project_in_dir(&base.join("battleship-account"), true)?),
        setup_note: Arc::new(build_project_in_dir(&base.join("setup-note"), true)?),
        action_note: Arc::new(build_project_in_dir(&base.join("action-note"), true)?),
        shot_note: Arc::new(build_project_in_dir(&base.join("shot-note"), true)?),
        result_note: Arc::new(build_project_in_dir(&base.join("result-note"), true)?),
        challenge_note: Arc::new(build_project_in_dir(&base.join("challenge-note"), true)?),
        accept_note: Arc::new(build_project_in_dir(&base.join("accept-note"), true)?),
        reveal_note: Arc::new(build_project_in_dir(&base.join("reveal-note"), true)?),
    })
}

/// Build all packages from default test path (../contracts).
pub fn build_all_packages() -> anyhow::Result<AllPackages> {
    build_all_packages_from(Path::new("../contracts"))
}

/// Get the MAST root (script root) of a compiled note package.
pub fn get_note_script_root(pkg: &miden_mast_package::Package) -> Word {
    
    let script = NoteScript::from_library(&pkg.mast).expect("from_library");
    script.root()
}

// ============================================================================
// Game state reading
// ============================================================================

/// Structured view of a game account's storage state.
#[derive(Debug)]
pub struct GameState {
    pub phase: u64,
    pub expected_turn: u64,
    pub ships_hit_count: u64,
    pub total_shots_received: u64,
    pub my_revealed: u64,
    pub opponent_verified: u64,
}

impl GameState {
    pub fn from_account(account: &miden_client::account::Account) -> Self {
        let config = account.storage().get_item(&game_config_slot()).unwrap();
        let opp = account.storage().get_item(&opponent_slot()).unwrap();
        let reveal = account.storage().get_item(&reveal_status_slot()).unwrap();
        Self {
            phase: config[2].as_canonical_u64(),
            expected_turn: config[3].as_canonical_u64(),
            ships_hit_count: opp[2].as_canonical_u64(),
            total_shots_received: opp[3].as_canonical_u64(),
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
}
