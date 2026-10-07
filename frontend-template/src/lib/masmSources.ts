/**
 * MASM contract sources, imported as raw text from the sibling contracts project
 * (`@masm` → project-template/contracts/masm, see vite.config.ts). They are
 * compiled at runtime by the web SDK (see contracts.ts), so no `.masp` artifacts
 * need to be copied into the frontend.
 */
import battleshipAccount from "@masm/battleship_account.masm?raw";
import setupTx from "@masm/scripts/setup_tx.masm?raw";
import enterRevealTx from "@masm/scripts/enter_reveal_tx.masm?raw";
import markMyRevealTx from "@masm/scripts/mark_my_reveal_tx.masm?raw";
import challengeNote from "@masm/challenge_note.masm?raw";
import acceptNote from "@masm/accept_note.masm?raw";
import shotNote from "@masm/shot_note.masm?raw";
import resultNote from "@masm/result_note.masm?raw";
import revealNote from "@masm/reveal_note.masm?raw";

export const MASM_SOURCES = {
  battleshipAccount,
  setupTx,
  enterRevealTx,
  markMyRevealTx,
  challengeNote,
  acceptNote,
  shotNote,
  resultNote,
  revealNote,
} as const;

export type MasmSources = typeof MASM_SOURCES;
