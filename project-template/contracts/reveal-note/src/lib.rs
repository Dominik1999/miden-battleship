#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

use crate::bindings::miden::battleship_account::battleship_account;

/// Reveal note: sent by a player to their opponent after the game ends.
/// Calls verify_opponent_reveal() on the consuming account to verify
/// the revealed board matches the stored opponent commitment.
///
/// Inputs (4 Felts):
///   [0..4]  commitment (the opponent's board commitment to verify)
///
/// Note: In production, this would carry the full board data (salt + 17 ship cells = 55 Felts)
/// and re-hash it. For now, the commitment is pre-verified by the caller and passed directly.
#[note]
struct RevealNote;

#[note]
impl RevealNote {
    #[note_script]
    fn run(self, _arg: Word) {
        let inputs = active_note::get_inputs();

        let commitment = Word::from([inputs[0], inputs[1], inputs[2], inputs[3]]);

        battleship_account::verify_opponent_reveal(commitment);
    }
}
