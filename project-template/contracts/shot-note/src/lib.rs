#![no_std]
#![feature(alloc_error_handler)]

extern crate alloc;
use alloc::vec;

use miden::*;

use crate::bindings::miden::battleship_account::battleship_account;

/// Shot note: calls process_shot on the defender's account, then creates
/// a result-note as an output note containing the shot result.
///
/// Inputs layout (14 Felts):
///   [0]  row
///   [1]  col
///   [2]  turn
///   [3..7]  result_serial_num (Word) — serial number for the result-note
///   [7..11] result_script_root (Word) — MAST root of the result-note script
///   [11] shooter_prefix
///   [12] shooter_suffix
///   [13] shooter_tag
#[note]
struct ShotNote;

#[note]
impl ShotNote {
    #[note_script]
    fn run(self, _arg: Word) {
        let inputs = active_note::get_storage();

        let row = inputs[0];
        let col = inputs[1];
        let turn = inputs[2];

        // Call process_shot on the consuming (defender's) account
        let encoded_result = battleship_account::process_shot(row, col, turn);

        // Build result-note recipient
        let serial_num = Word::from([inputs[3], inputs[4], inputs[5], inputs[6]]);
        let script_root = Word::from([inputs[7], inputs[8], inputs[9], inputs[10]]);
        let shooter_prefix = inputs[11];
        let shooter_suffix = inputs[12];
        let shooter_tag = inputs[13];

        // Result-note inputs: [shooter_prefix, shooter_suffix, turn, encoded_result]
        let recipient = note::build_recipient(
            serial_num,
            script_root,
            vec![shooter_prefix, shooter_suffix, turn, encoded_result],
        );

        let tag = Tag::from(shooter_tag);
        let note_type = NoteType::from(Felt::new(1)); // Public

        let _note_idx = output_note::create(tag, note_type, recipient);
    }
}
