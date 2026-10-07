/**
 * MASM contract sources, imported as raw text from the sibling contracts project
 * (`@masm` → project-template/contracts/masm, see vite.config.ts). They are
 * compiled at runtime by the web SDK (see contracts.ts), so no `.masp` artifacts
 * need to be copied into the frontend.
 *
 * `battleshipAccount` and `stakeNote` are templates: the account carries `{{ISCn}}`
 * placeholders for its initial storage commitment, the stake note `{{DEFEATn}}` /
 * `{{FORFEITn}}` placeholders for the roots of the notes it recognises.
 */
import battleshipAccount from "@masm/battleship_account.masm?raw";
import setupTx from "@masm/scripts/setup_tx.masm?raw";
import fireTx from "@masm/scripts/fire_tx.masm?raw";
import challengeNote from "@masm/challenge_note.masm?raw";
import acceptNote from "@masm/accept_note.masm?raw";
import shotNote from "@masm/shot_note.masm?raw";
import resultNote from "@masm/result_note.masm?raw";
import defeatNote from "@masm/defeat_note.masm?raw";
import forfeitNote from "@masm/forfeit_note.masm?raw";
import stakeNote from "@masm/stake_note.masm?raw";

export const MASM_SOURCES = {
  battleshipAccount,
  setupTx,
  fireTx,
  challengeNote,
  acceptNote,
  shotNote,
  resultNote,
  defeatNote,
  forfeitNote,
  stakeNote,
} as const;

export type MasmSources = typeof MASM_SOURCES;

/** Replaces `{{NAMEi}}` placeholders (i = 0..3) with the four values of a word. */
export function substituteWord(source: string, name: string, values: readonly bigint[]): string {
  let out = source;
  values.slice(0, 4).forEach((value, i) => {
    out = out.split(`{{${name}${i}}}`).join(value.toString());
  });
  return out;
}
