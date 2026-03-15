#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

/// Minimal result-note script.
/// Created by shot-note as an output note containing the shot result.
///
/// Inputs: [shooter_prefix, shooter_suffix, turn, encoded_result]
///
/// The primary consumption path is that the shooter reads the public note
/// data during sync and updates local UI. Consumption just cleans up the UTXO.
#[note]
struct ResultNote;

#[note]
impl ResultNote {
    #[note_script]
    fn run(self, _arg: Word) {
        // Minimal: no-op. The note exists to carry data (turn, result).
        // P2ID enforcement is optional for result-notes since the data is public.
    }
}
