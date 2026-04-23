#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

use crate::bindings::miden::battleship_account::battleship_account;

/// Minimal note that only calls process_shot. No branching.
/// Inputs: [row, col, turn]
#[note]
struct ShotTestNote;

#[note]
impl ShotTestNote {
    #[note_script]
    fn run(self, _arg: Word) {
        let inputs = active_note::get_storage();
        let _result = battleship_account::process_shot(inputs[0], inputs[1], inputs[2]);
    }
}
