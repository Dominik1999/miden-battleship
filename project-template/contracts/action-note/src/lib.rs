#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

use crate::bindings::miden::battleship_account::battleship_account;

/// Generic action note for testing battleship component methods.
///
/// Input layout varies by action:
///   Action 1 (process_shot): [1, row, col, turn]
///   Action 2 (accept_challenge): [2, gid0..3, opp_prefix, opp_suffix, commit0..3] = 11 Felts
///   Action 3 (receive_acceptance): [3, gid0..3, acc_prefix, acc_suffix, commit0..3] = 11 Felts
///   Action 4 (enter_reveal): [4]
///   Action 5 (mark_my_reveal): [5]
///   Action 6 (verify_opponent_reveal): [6, commit0..3] = 5 Felts
///   Action 7 (place_ship): [7, row, col, ship_id]
#[note]
struct ActionNote;

#[note]
impl ActionNote {
    #[note_script]
    fn run(self, _arg: Word) {
        let inputs = active_note::get_storage();
        let action = inputs[0].as_canonical_u64();

        if action == 1 {
            // process_shot(row, col, turn) -> encoded_result
            let _result = battleship_account::process_shot(inputs[1], inputs[2], inputs[3]);
        } else if action == 2 {
            // accept_challenge(game_id, opponent_prefix, opponent_suffix, opponent_commitment)
            let game_id = Word::from([inputs[1], inputs[2], inputs[3], inputs[4]]);
            let commitment = Word::from([inputs[7], inputs[8], inputs[9], inputs[10]]);
            battleship_account::accept_challenge(game_id, inputs[5], inputs[6], commitment);
        } else if action == 3 {
            // receive_acceptance(game_id, acceptor_prefix, acceptor_suffix, acceptor_commitment)
            let game_id = Word::from([inputs[1], inputs[2], inputs[3], inputs[4]]);
            let commitment = Word::from([inputs[7], inputs[8], inputs[9], inputs[10]]);
            battleship_account::receive_acceptance(game_id, inputs[5], inputs[6], commitment);
        } else if action == 4 {
            // enter_reveal()
            battleship_account::enter_reveal();
        } else if action == 5 {
            // mark_my_reveal()
            battleship_account::mark_my_reveal();
        } else if action == 6 {
            // verify_opponent_reveal(commitment)
            let commitment = Word::from([inputs[1], inputs[2], inputs[3], inputs[4]]);
            battleship_account::verify_opponent_reveal(commitment);
        } else if action == 7 {
            // place_ship(row, col, ship_id)
            battleship_account::place_ship(inputs[1], inputs[2], inputs[3]);
        }
    }
}
