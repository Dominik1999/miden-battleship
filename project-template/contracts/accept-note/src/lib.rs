#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

use crate::bindings::miden::battleship_account::battleship_account;

/// Accept note: sent by the acceptor back to the challenger.
/// Calls receive_acceptance() on the consuming (challenger's) account.
///
/// Inputs (10 Felts):
///   [0..4]  game_id
///   [4]     acceptor_prefix (opponent for the challenger)
///   [5]     acceptor_suffix
///   [6..10] acceptor_commitment
#[note]
struct AcceptNote;

#[note]
impl AcceptNote {
    #[note_script]
    fn run(self, _arg: Word) {
        let inputs = active_note::get_storage();

        let game_id = Word::from([inputs[0], inputs[1], inputs[2], inputs[3]]);
        let acceptor_prefix = inputs[4];
        let acceptor_suffix = inputs[5];
        let acceptor_commitment = Word::from([inputs[6], inputs[7], inputs[8], inputs[9]]);

        battleship_account::receive_acceptance(
            game_id,
            acceptor_prefix,
            acceptor_suffix,
            acceptor_commitment,
        );
    }
}
