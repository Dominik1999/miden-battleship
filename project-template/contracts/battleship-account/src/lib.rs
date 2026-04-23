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

    /// Board cells: key=(0,0,row,col) -> cell state
    /// Ship counts: key=(1,0,0,ship_id) -> count of placed cells
    #[storage(description = "board cells and ship counts")]
    my_board: StorageMap<Word, Felt>,
}

#[component]
impl BattleshipAccount {
    /// Place a single ship cell on the board. Only valid during CREATED phase.
    pub fn place_ship(&mut self, row: Felt, col: Felt, ship_id: Felt) {
        let config: Word = self.game_config.get();
        assert!(config[2].as_canonical_u64() == PHASE_CREATED, "wrong phase");

        let r = row.as_canonical_u64();
        let c = col.as_canonical_u64();
        assert!(r < GRID_SIZE, "row out of bounds");
        assert!(c < GRID_SIZE, "col out of bounds");

        let sid = ship_id.as_canonical_u64();
        assert!(sid >= 1 && sid <= 5, "invalid ship id");

        // Check cell is empty
        let key = Word::from([felt!(0), felt!(0), row, col]);
        let current: Felt = self.my_board.get(key);
        assert!(current.as_canonical_u64() == CELL_WATER, "cell occupied");

        // Store the ship cell
        self.my_board.set(key, ship_id);

        // Increment per-ship count
        let count_key = Word::from([felt!(1), felt!(0), felt!(0), ship_id]);
        let count: Felt = self.my_board.get(count_key);
        self.my_board.set(count_key, count + felt!(1));

        // Increment total placed count
        let num_placed = config[1].as_canonical_u64() + 1;
        self.game_config.set(Word::from([
            config[0],
            Felt::new(num_placed),
            config[2],
            config[3],
        ]));
    }

    /// Finalize board setup: validate ship counts, store commitment, set phase.
    /// The commitment is pre-computed by the caller (note script or client).
    pub fn finalize_setup(
        &mut self,
        game_id: Word,
        opponent_prefix: Felt,
        opponent_suffix: Felt,
        commitment: Word,
    ) {
        let config: Word = self.game_config.get();
        assert!(config[2].as_canonical_u64() == PHASE_CREATED, "wrong phase");

        // Validate total placed count
        assert!(
            config[1].as_canonical_u64() == TOTAL_SHIP_CELLS,
            "wrong number of ships"
        );

        // Validate per-ship counts
        let s1: Felt = self
            .my_board
            .get(Word::from([felt!(1), felt!(0), felt!(0), felt!(1)]));
        assert!(s1.as_canonical_u64() == SHIP_1_SIZE, "ship 1 wrong size");

        let s2: Felt = self
            .my_board
            .get(Word::from([felt!(1), felt!(0), felt!(0), felt!(2)]));
        assert!(s2.as_canonical_u64() == SHIP_2_SIZE, "ship 2 wrong size");

        let s3: Felt = self
            .my_board
            .get(Word::from([felt!(1), felt!(0), felt!(0), felt!(3)]));
        assert!(s3.as_canonical_u64() == SHIP_3_SIZE, "ship 3 wrong size");

        let s4: Felt = self
            .my_board
            .get(Word::from([felt!(1), felt!(0), felt!(0), felt!(4)]));
        assert!(s4.as_canonical_u64() == SHIP_4_SIZE, "ship 4 wrong size");

        let s5: Felt = self
            .my_board
            .get(Word::from([felt!(1), felt!(0), felt!(0), felt!(5)]));
        assert!(s5.as_canonical_u64() == SHIP_5_SIZE, "ship 5 wrong size");

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
        let key = Word::from([felt!(0), felt!(0), row, col]);
        self.my_board.get(key)
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
        assert!(row.as_canonical_u64() < GRID_SIZE, "row out of bounds");
        assert!(col.as_canonical_u64() < GRID_SIZE, "col out of bounds");

        // Read cell
        let key = Word::from([felt!(0), felt!(0), row, col]);
        let cell: Felt = self.my_board.get(key);
        let cell_val = cell.as_canonical_u64();

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

        // Update cell
        self.my_board.set(key, Felt::new(new_cell));

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
