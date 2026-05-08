#![no_std]
#![feature(alloc_error_handler)]

extern crate alloc;

use miden::*;

// Phase constants
const PHASE_CREATED: u64 = 0;
const PHASE_CHALLENGED: u64 = 1;
const PHASE_ACTIVE: u64 = 2;
const PHASE_REVEAL: u64 = 3;
const PHASE_COMPLETE: u64 = 4;

// Cell state constants
const CELL_WATER: u64 = 0;
const CELL_HIT: u64 = 6;
const CELL_MISS: u64 = 7;

// Ship sizes (ship_id -> expected cell count)
const SHIP_1_SIZE: u64 = 5; // Carrier
const SHIP_2_SIZE: u64 = 4; // Battleship
const SHIP_3_SIZE: u64 = 3; // Cruiser
const SHIP_4_SIZE: u64 = 3; // Submarine
const SHIP_5_SIZE: u64 = 2; // Destroyer
const TOTAL_SHIP_CELLS: u64 = 17;

const GRID_SIZE: u64 = 10;

fn get_cell_from_packed(packed: u64, col: u64) -> u64 {
    (packed >> (col * 3)) & 0x7
}

fn set_cell_in_packed(packed: u64, col: u64, value: u64) -> u64 {
    let shift = col * 3;
    let mask = !(0x7u64 << shift);
    (packed & mask) | (value << shift)
}

#[component]
struct BattleshipAccount {
    /// [grid_size, num_placed, phase, expected_turn]
    #[storage(description = "game config")]
    game_config: StorageValue<Word>,

    /// [opponent_prefix, opponent_suffix, ships_hit_count, total_shots_received]
    #[storage(description = "opponent info")]
    opponent: StorageValue<Word>,

    /// [h0, h1, h2, h3] salted hash of ship placement
    #[storage(description = "board commitment")]
    board_commitment: StorageValue<Word>,

    /// [h0, h1, h2, h3] opponent's salted board commitment
    #[storage(description = "opponent board commitment")]
    opponent_commitment: StorageValue<Word>,

    /// [gid0, gid1, gid2, gid3]
    #[storage(description = "game id")]
    game_id: StorageValue<Word>,

    /// [my_revealed, opponent_verified, 0, 0]
    #[storage(description = "reveal status")]
    reveal_status: StorageValue<Word>,

    /// Board rows: each row packs 10 cells at 3 bits each into Felt[0]
    #[storage(description = "board row 0")]
    board_row_0: StorageValue<Word>,
    #[storage(description = "board row 1")]
    board_row_1: StorageValue<Word>,
    #[storage(description = "board row 2")]
    board_row_2: StorageValue<Word>,
    #[storage(description = "board row 3")]
    board_row_3: StorageValue<Word>,
    #[storage(description = "board row 4")]
    board_row_4: StorageValue<Word>,
    #[storage(description = "board row 5")]
    board_row_5: StorageValue<Word>,
    #[storage(description = "board row 6")]
    board_row_6: StorageValue<Word>,
    #[storage(description = "board row 7")]
    board_row_7: StorageValue<Word>,
    #[storage(description = "board row 8")]
    board_row_8: StorageValue<Word>,
    #[storage(description = "board row 9")]
    board_row_9: StorageValue<Word>,
}

#[component]
impl BattleshipAccount {
    fn get_board_row(&self, row: u64) -> Word {
        match row {
            0 => self.board_row_0.get(),
            1 => self.board_row_1.get(),
            2 => self.board_row_2.get(),
            3 => self.board_row_3.get(),
            4 => self.board_row_4.get(),
            5 => self.board_row_5.get(),
            6 => self.board_row_6.get(),
            7 => self.board_row_7.get(),
            8 => self.board_row_8.get(),
            9 => self.board_row_9.get(),
            _ => panic!("row out of bounds"),
        }
    }

    fn set_board_row(&mut self, row: u64, value: Word) {
        match row {
            0 => self.board_row_0.set(value),
            1 => self.board_row_1.set(value),
            2 => self.board_row_2.set(value),
            3 => self.board_row_3.set(value),
            4 => self.board_row_4.set(value),
            5 => self.board_row_5.set(value),
            6 => self.board_row_6.set(value),
            7 => self.board_row_7.set(value),
            8 => self.board_row_8.set(value),
            9 => self.board_row_9.set(value),
            _ => panic!("row out of bounds"),
        };
    }

    /// Store packed board rows. Must be called before finalize_board.
    /// rows_a = [row0, row1, row2, row3]
    /// rows_b = [row4, row5, row6, row7]
    /// rows_c = [row8, row9, 0, 0]
    pub fn set_board_rows(
        &mut self,
        rows_a: Word,
        rows_b: Word,
        rows_c: Word,
    ) {
        let config: Word = self.game_config.get();
        assert!(config[2].as_canonical_u64() == PHASE_CREATED, "wrong phase");

        let rows: [Felt; 10] = [
            rows_a[0], rows_a[1], rows_a[2], rows_a[3],
            rows_b[0], rows_b[1], rows_b[2], rows_b[3],
            rows_c[0], rows_c[1],
        ];

        // Count total cells and per-ship counts
        let mut total: u64 = 0;
        let mut ship1: u64 = 0;
        let mut ship2: u64 = 0;
        let mut ship3: u64 = 0;
        let mut ship4: u64 = 0;
        let mut ship5: u64 = 0;

        let mut r: u64 = 0;
        while r < GRID_SIZE {
            let packed = rows[r as usize].as_canonical_u64();
            let mut c: u64 = 0;
            while c < GRID_SIZE {
                let cell = get_cell_from_packed(packed, c);
                if cell >= 1 && cell <= 5 {
                    total += 1;
                    match cell {
                        1 => ship1 += 1,
                        2 => ship2 += 1,
                        3 => ship3 += 1,
                        4 => ship4 += 1,
                        5 => ship5 += 1,
                        _ => {}
                    }
                } else {
                    assert!(cell == CELL_WATER, "invalid cell value");
                }
                c += 1;
            }
            r += 1;
        }

        // Validate ship counts
        assert!(total == TOTAL_SHIP_CELLS, "wrong number of ships");
        assert!(ship1 == SHIP_1_SIZE, "ship 1 wrong size");
        assert!(ship2 == SHIP_2_SIZE, "ship 2 wrong size");
        assert!(ship3 == SHIP_3_SIZE, "ship 3 wrong size");
        assert!(ship4 == SHIP_4_SIZE, "ship 4 wrong size");
        assert!(ship5 == SHIP_5_SIZE, "ship 5 wrong size");

        // Write board rows to storage
        let mut r2: u64 = 0;
        while r2 < GRID_SIZE {
            self.set_board_row(r2, Word::from([rows[r2 as usize], felt!(0), felt!(0), felt!(0)]));
            r2 += 1;
        }

        // Mark rows as placed (num_placed = TOTAL_SHIP_CELLS) but stay in CREATED phase.
        // finalize_board must be called next to transition to CHALLENGED.
        self.game_config.set(Word::from([
            Felt::new(GRID_SIZE),
            Felt::new(TOTAL_SHIP_CELLS),
            Felt::new(PHASE_CREATED),
            felt!(0),
        ]));
    }

    /// Finalize board setup: store game metadata and transition to CHALLENGED phase.
    /// Must be called after set_board_rows.
    pub fn finalize_board(
        &mut self,
        game_id: Word,
        opponent_prefix: Felt,
        opponent_suffix: Felt,
        commitment: Word,
    ) {
        let config: Word = self.game_config.get();
        assert!(config[2].as_canonical_u64() == PHASE_CREATED, "wrong phase");

        // Validate that board rows were placed
        assert!(
            config[1].as_canonical_u64() == TOTAL_SHIP_CELLS,
            "board rows not set"
        );

        // Store game_id
        self.game_id.set(game_id);

        // Store opponent info
        self.opponent.set(Word::from([
            opponent_prefix,
            opponent_suffix,
            felt!(0),
            felt!(0),
        ]));

        // Store commitment
        self.board_commitment.set(commitment);

        // Set phase to CHALLENGED
        self.game_config.set(Word::from([
            Felt::new(GRID_SIZE),
            Felt::new(TOTAL_SHIP_CELLS),
            Felt::new(PHASE_CHALLENGED),
            felt!(0),
        ]));
    }

    /// Get a cell's state
    pub fn get_cell(&self, row: Felt, col: Felt) -> Felt {
        let r = row.as_canonical_u64();
        let c = col.as_canonical_u64();
        assert!(r < GRID_SIZE, "row out of bounds");
        assert!(c < GRID_SIZE, "col out of bounds");

        let row_word: Word = self.get_board_row(r);
        let packed = row_word[0].as_canonical_u64();
        Felt::new(get_cell_from_packed(packed, c))
    }

    /// Get current game phase
    pub fn get_game_phase(&self) -> Felt {
        let config: Word = self.game_config.get();
        config[2]
    }

    /// Accept a challenge (called on Acceptor's account by challenge-note).
    /// The acceptor must already have finalized their board (phase=CHALLENGED).
    pub fn accept_challenge(
        &mut self,
        game_id: Word,
        opponent_prefix: Felt,
        opponent_suffix: Felt,
        opponent_commitment: Word,
    ) {
        let config: Word = self.game_config.get();
        assert!(
            config[2].as_canonical_u64() == PHASE_CHALLENGED,
            "wrong phase for accept"
        );

        // Verify game_id matches
        let stored_game_id: Word = self.game_id.get();
        assert!(stored_game_id == game_id, "game_id mismatch");

        // Verify opponent matches stored
        let stored_opponent: Word = self.opponent.get();
        assert!(
            stored_opponent[0] == opponent_prefix,
            "opponent prefix mismatch"
        );
        assert!(
            stored_opponent[1] == opponent_suffix,
            "opponent suffix mismatch"
        );

        // Store opponent commitment
        self.opponent_commitment.set(opponent_commitment);

        // Set phase to ACTIVE, expected_turn = 1
        // (Acceptor defends challenger's first shot which is turn 1)
        self.game_config.set(Word::from([
            Felt::new(GRID_SIZE),
            Felt::new(TOTAL_SHIP_CELLS),
            Felt::new(PHASE_ACTIVE),
            felt!(1),
        ]));
    }

    /// Receive acceptance (called on Challenger's account by accept-note).
    pub fn receive_acceptance(
        &mut self,
        game_id: Word,
        acceptor_prefix: Felt,
        acceptor_suffix: Felt,
        acceptor_commitment: Word,
    ) {
        let config: Word = self.game_config.get();
        assert!(
            config[2].as_canonical_u64() == PHASE_CHALLENGED,
            "wrong phase for receive_acceptance"
        );

        // Verify game_id matches
        let stored_game_id: Word = self.game_id.get();
        assert!(stored_game_id == game_id, "game_id mismatch");

        // Verify acceptor matches stored opponent
        let stored_opponent: Word = self.opponent.get();
        assert!(
            stored_opponent[0] == acceptor_prefix,
            "acceptor prefix mismatch"
        );
        assert!(
            stored_opponent[1] == acceptor_suffix,
            "acceptor suffix mismatch"
        );

        // Store opponent commitment
        self.opponent_commitment.set(acceptor_commitment);

        // Set phase to ACTIVE, expected_turn = 2
        // (Challenger fires turn 1, so challenger's next incoming shot is turn 2)
        self.game_config.set(Word::from([
            Felt::new(GRID_SIZE),
            Felt::new(TOTAL_SHIP_CELLS),
            Felt::new(PHASE_ACTIVE),
            felt!(2),
        ]));
    }

    /// Process an incoming shot. Returns encoded result: result * 2 + game_over.
    /// result: 0=miss, 1=hit. game_over: 0=no, 1=yes.
    /// Encoded values: 0=miss, 1=miss+gameover, 2=hit, 3=hit+gameover.
    pub fn process_shot(&mut self, row: Felt, col: Felt, turn: Felt) -> Felt {
        let config: Word = self.game_config.get();
        assert!(config[2].as_canonical_u64() == PHASE_ACTIVE, "wrong phase for shot");

        // Validate turn
        assert!(turn.as_canonical_u64() == config[3].as_canonical_u64(), "wrong turn number");

        // Check bounds
        let r = row.as_canonical_u64();
        let c = col.as_canonical_u64();
        assert!(r < GRID_SIZE, "row out of bounds");
        assert!(c < GRID_SIZE, "col out of bounds");

        // Read cell from packed row
        let row_word: Word = self.get_board_row(r);
        let packed = row_word[0].as_canonical_u64();
        let cell_val = get_cell_from_packed(packed, c);

        // Check not already shot (valid cells are 0-5; hit=6, miss=7)
        assert!(cell_val <= 5, "cell already shot");

        // Read opponent info
        let opp: Word = self.opponent.get();
        let ships_hit_count = opp[2].as_canonical_u64();
        let total_shots = opp[3].as_canonical_u64();

        // Determine result
        let is_hit = cell_val >= 1 && cell_val <= 5;
        let result: u64 = if is_hit { 1 } else { 0 };
        let new_cell: u64 = if is_hit { CELL_HIT } else { CELL_MISS };
        let new_hit_count: u64 = if is_hit {
            ships_hit_count + 1
        } else {
            ships_hit_count
        };

        // Update cell in packed row
        let new_packed = set_cell_in_packed(packed, c, new_cell);
        self.set_board_row(r, Word::from([Felt::new(new_packed), felt!(0), felt!(0), felt!(0)]));

        // Update opponent info (counters)
        self.opponent.set(Word::from([
            opp[0],
            opp[1],
            Felt::new(new_hit_count),
            Felt::new(total_shots + 1),
        ]));

        // Check victory
        let game_over: u64 = if new_hit_count == TOTAL_SHIP_CELLS {
            1
        } else {
            0
        };
        let new_phase: u64 = if game_over == 1 {
            PHASE_REVEAL
        } else {
            PHASE_ACTIVE
        };

        // Update config: advance expected_turn by 2 (turns alternate)
        self.game_config.set(Word::from([
            Felt::new(GRID_SIZE),
            Felt::new(TOTAL_SHIP_CELLS),
            Felt::new(new_phase),
            Felt::new(config[3].as_canonical_u64() + 2),
        ]));

        // Return encoded: result * 2 + game_over
        Felt::new(result * 2 + game_over)
    }

    /// Winner calls this to transition own account ACTIVE -> REVEAL.
    pub fn enter_reveal(&mut self) {
        let config: Word = self.game_config.get();
        assert!(
            config[2].as_canonical_u64() == PHASE_ACTIVE,
            "wrong phase for enter_reveal"
        );

        self.game_config.set(Word::from([
            config[0],
            config[1],
            Felt::new(PHASE_REVEAL),
            config[3],
        ]));
    }

    /// Mark that this account has sent its reveal note.
    pub fn mark_my_reveal(&mut self) {
        let config: Word = self.game_config.get();
        assert!(
            config[2].as_canonical_u64() == PHASE_REVEAL,
            "wrong phase for mark_my_reveal"
        );

        let status: Word = self.reveal_status.get();
        self.reveal_status.set(Word::from([
            felt!(1),
            status[1],
            felt!(0),
            felt!(0),
        ]));

        // If opponent already verified, complete the game
        if status[1].as_canonical_u64() == 1 {
            self.game_config.set(Word::from([
                config[0],
                config[1],
                Felt::new(PHASE_COMPLETE),
                config[3],
            ]));
        }
    }

    /// Verify opponent's revealed board. Receives the pre-computed commitment
    /// and compares against stored opponent_commitment.
    pub fn verify_opponent_reveal(&mut self, commitment: Word) {
        let config: Word = self.game_config.get();
        assert!(
            config[2].as_canonical_u64() == PHASE_REVEAL,
            "wrong phase for verify"
        );

        // Verify commitment matches stored opponent commitment
        let stored: Word = self.opponent_commitment.get();
        assert!(stored == commitment, "commitment mismatch");

        // Set opponent_verified
        let status: Word = self.reveal_status.get();
        self.reveal_status.set(Word::from([
            status[0],
            felt!(1),
            felt!(0),
            felt!(0),
        ]));

        // If we already revealed, complete the game
        if status[0].as_canonical_u64() == 1 {
            self.game_config.set(Word::from([
                config[0],
                config[1],
                Felt::new(PHASE_COMPLETE),
                config[3],
            ]));
        }
    }
}
