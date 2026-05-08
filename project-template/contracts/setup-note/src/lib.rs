#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

use crate::bindings::miden::battleship_account::battleship_account;

/// Setup note for board placement (packed format).
///
/// Input layout (20 Felts):
///   [0..4]   game_id (4 Felts)
///   [4]      opponent_prefix
///   [5]      opponent_suffix
///   [6..10]  commitment (4 Felts, pre-computed by client)
///   [10..20] packed_rows (10 Felts, each packs 10 cells at 3 bits)
#[note]
struct SetupNote;

#[note]
impl SetupNote {
    #[note_script]
    fn run(self, _arg: Word) {
        let inputs = active_note::get_storage();

        let game_id = Word::from([inputs[0], inputs[1], inputs[2], inputs[3]]);
        let commitment = Word::from([inputs[6], inputs[7], inputs[8], inputs[9]]);

        // rows_a = [row0..row3], rows_b = [row4..row7], rows_c = [row8, row9, 0, 0]
        let rows_a = Word::from([inputs[10], inputs[11], inputs[12], inputs[13]]);
        let rows_b = Word::from([inputs[14], inputs[15], inputs[16], inputs[17]]);
        let rows_c = Word::from([inputs[18], inputs[19], felt!(0), felt!(0)]);

        battleship_account::set_board_rows(rows_a, rows_b, rows_c);
        battleship_account::finalize_board(game_id, inputs[4], inputs[5], commitment);
    }
}
