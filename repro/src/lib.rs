#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

const PHASE_ACTIVE: u64 = 2;
const PHASE_REVEAL: u64 = 3;
const CELL_HIT: u64 = 6;
const CELL_MISS: u64 = 7;
const TOTAL_SHIP_CELLS: u64 = 17;
const GRID_SIZE: u64 = 10;

#[component]
struct BattleshipAccount {
    #[storage(description = "game config")]
    game_config: StorageValue<Word>,

    #[storage(description = "opponent info")]
    opponent: StorageValue<Word>,

    #[storage(description = "board cells")]
    my_board: StorageMap<Word, Felt>,
}

#[component]
impl BattleshipAccount {
    /// Panics with 6 asserts. Compiles fine with 5 (remove any one assert).
    pub fn process_shot(&mut self, row: Felt, col: Felt, turn: Felt) -> Felt {
        let config: Word = self.game_config.get();
        assert!(config[2].as_canonical_u64() == PHASE_ACTIVE, "a1");
        assert!(turn.as_canonical_u64() == config[3].as_canonical_u64(), "a2");
        assert!(row.as_canonical_u64() < GRID_SIZE, "a3");
        assert!(col.as_canonical_u64() < GRID_SIZE, "a4");

        let key = Word::from([felt!(0), felt!(0), row, col]);
        let cell: Felt = self.my_board.get(key);
        let cell_val = cell.as_canonical_u64();
        assert!(cell_val != CELL_HIT, "a5");
        assert!(cell_val != CELL_MISS, "a6");

        let opp: Word = self.opponent.get();
        let ships_hit_count = opp[2].as_canonical_u64();
        let total_shots = opp[3].as_canonical_u64();

        let is_hit = cell_val >= 1 && cell_val <= 5;
        let result: u64 = if is_hit { 1 } else { 0 };
        let new_cell: u64 = if is_hit { CELL_HIT } else { CELL_MISS };
        let new_hit_count: u64 = if is_hit { ships_hit_count + 1 } else { ships_hit_count };

        self.my_board.set(key, Felt::new(new_cell));
        self.opponent.set(Word::from([opp[0], opp[1], Felt::new(new_hit_count), Felt::new(total_shots + 1)]));

        let game_over: u64 = if new_hit_count == TOTAL_SHIP_CELLS { 1 } else { 0 };
        let new_phase: u64 = if game_over == 1 { PHASE_REVEAL } else { PHASE_ACTIVE };

        self.game_config.set(Word::from([Felt::new(GRID_SIZE), Felt::new(TOTAL_SHIP_CELLS), Felt::new(new_phase), Felt::new(config[3].as_canonical_u64() + 2)]));

        Felt::new(result * 2 + game_over)
    }
}
