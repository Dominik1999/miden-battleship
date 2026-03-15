#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

use crate::bindings::miden::battleship_account::battleship_account;

/// Setup note for board placement.
///
/// Input layout (61 Felts):
///   [0..4]   game_id (4 Felts)
///   [4]      opponent_prefix
///   [5]      opponent_suffix
///   [6..10]  commitment (4 Felts, pre-computed by client)
///   [10..61] ship data: 17 * (row, col, ship_id) = 51 Felts
#[note]
struct SetupNote;

#[note]
impl SetupNote {
    #[note_script]
    fn run(self, _arg: Word) {
        let inputs = active_note::get_inputs();

        // Place 17 ship cells
        // Unrolled loop to avoid potential issues with control flow compilation
        battleship_account::place_ship(inputs[10], inputs[11], inputs[12]);
        battleship_account::place_ship(inputs[13], inputs[14], inputs[15]);
        battleship_account::place_ship(inputs[16], inputs[17], inputs[18]);
        battleship_account::place_ship(inputs[19], inputs[20], inputs[21]);
        battleship_account::place_ship(inputs[22], inputs[23], inputs[24]);
        battleship_account::place_ship(inputs[25], inputs[26], inputs[27]);
        battleship_account::place_ship(inputs[28], inputs[29], inputs[30]);
        battleship_account::place_ship(inputs[31], inputs[32], inputs[33]);
        battleship_account::place_ship(inputs[34], inputs[35], inputs[36]);
        battleship_account::place_ship(inputs[37], inputs[38], inputs[39]);
        battleship_account::place_ship(inputs[40], inputs[41], inputs[42]);
        battleship_account::place_ship(inputs[43], inputs[44], inputs[45]);
        battleship_account::place_ship(inputs[46], inputs[47], inputs[48]);
        battleship_account::place_ship(inputs[49], inputs[50], inputs[51]);
        battleship_account::place_ship(inputs[52], inputs[53], inputs[54]);
        battleship_account::place_ship(inputs[55], inputs[56], inputs[57]);
        battleship_account::place_ship(inputs[58], inputs[59], inputs[60]);

        // Finalize setup
        let game_id = Word::from([inputs[0], inputs[1], inputs[2], inputs[3]]);
        let commitment = Word::from([inputs[6], inputs[7], inputs[8], inputs[9]]);
        battleship_account::finalize_setup(game_id, inputs[4], inputs[5], commitment);
    }
}
