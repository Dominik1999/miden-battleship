#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

use crate::bindings::miden::battleship_account::battleship_account;

/// Challenge note: sent by the challenger to the acceptor.
/// Calls accept_challenge() on the consuming (acceptor's) account.
///
/// Inputs (11 Felts):
///   [0..4]  game_id
///   [4]     challenger_prefix (opponent for the acceptor)
///   [5]     challenger_suffix
///   [6..10] challenger_commitment
#[note]
struct ChallengeNote;

#[note]
impl ChallengeNote {
    #[note_script]
    fn run(self, _arg: Word) {
        let inputs = active_note::get_storage();

        let game_id = Word::from([inputs[0], inputs[1], inputs[2], inputs[3]]);
        let opponent_prefix = inputs[4];
        let opponent_suffix = inputs[5];
        let opponent_commitment = Word::from([inputs[6], inputs[7], inputs[8], inputs[9]]);

        battleship_account::accept_challenge(
            game_id,
            opponent_prefix,
            opponent_suffix,
            opponent_commitment,
        );
    }
}
