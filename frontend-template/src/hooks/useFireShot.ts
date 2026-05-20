import { useState, useCallback } from "react";
import { useMiden, useMidenClient, useSyncState } from "@miden-sdk/react";
import {
  TransactionRequestBuilder,
  Package,
  NoteScript,
  Note,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteStorage,
  NoteTag,
  NoteType,
  NoteArray,
  AccountId,
  Felt,
  FeltArray,
} from "@miden-sdk/miden-sdk";
import { randomWord } from "@/lib/miden";
import { RESULT_SCRIPT_ROOT, NETWORK_SYNC_DELAY_MS } from "@/config";

const log = (msg: string, ...args: unknown[]) =>
  console.log(
    `%c[FireShot] ${msg}`,
    "color: #f60; font-weight: bold",
    ...args,
  );

/**
 * Builds a shot-note targeting the defender's game account and submits it
 * directly from the shooter's game account — no wallet popup needed.
 *
 * Shot-note inputs (14 Felts):
 *   [0] row, [1] col, [2] turn,
 *   [3..7] result_serial_num, [7..11] result_script_root,
 *   [11] shooter_prefix, [12] shooter_suffix, [13] shooter_tag
 */
export function useFireShot(
  myAddress: string,
  defenderAddress: string,
  refetchState: () => void,
) {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const client = useMidenClient();
  const { runExclusive, prover } = useMiden();
  const { sync } = useSyncState();

  const fireShot = useCallback(
    async (row: number, col: number, turn: number) => {
      if (!myAddress || !client) {
        log("Not ready: no game account");
        return;
      }
      setError(null);
      setIsSubmitting(true);
      log(`Firing at (${row}, ${col}), turn=${turn}, defender=${defenderAddress}`);

      try {
        // Load pre-compiled shot-note package
        const buf = await fetch(`${import.meta.env.BASE_URL}packages/shot_note.masp`).then((r) =>
          r.arrayBuffer(),
        );
        const pkg = Package.deserialize(new Uint8Array(buf));
        const noteScript = NoteScript.fromPackage(pkg);

        const defenderAccountId = AccountId.fromBech32(defenderAddress);
        const myAccountId = AccountId.fromBech32(myAddress);

        // Build serial number for the result-note
        const resultSerialNum = randomWord();
        const resultFelts = resultSerialNum.toFelts();

        // Build 14 note inputs
        const inputFelts = new FeltArray();
        inputFelts.push(new Felt(BigInt(row)));
        inputFelts.push(new Felt(BigInt(col)));
        inputFelts.push(new Felt(BigInt(turn)));
        // result_serial_num (4 felts)
        for (let i = 0; i < 4; i++) {
          inputFelts.push(resultFelts[i]);
        }
        // result_script_root (4 felts)
        for (const val of RESULT_SCRIPT_ROOT) {
          inputFelts.push(new Felt(val));
        }
        // shooter AccountId decomposed into prefix + suffix (game account, not wallet)
        inputFelts.push(myAccountId.prefix());
        inputFelts.push(myAccountId.suffix());
        // shooter_tag — tag for the result-note to come back to our game account
        const shooterTag = NoteTag.withAccountTarget(myAccountId);
        inputFelts.push(new Felt(BigInt(shooterTag.asU32())));

        const storage = new NoteStorage(inputFelts);
        const serialNum = randomWord();
        const recipient = new NoteRecipient(serialNum, noteScript, storage);

        // Build note metadata targeting the defender's game account
        const tag = NoteTag.withAccountTarget(defenderAccountId);
        const metadata = new NoteMetadata(
          myAccountId,
          NoteType.Public,
          tag,
        );

        // Assemble note and submit directly from game account (no wallet popup)
        const note = new Note(new NoteAssets(), metadata, recipient);
        const txRequest = new TransactionRequestBuilder()
          .withOwnOutputNotes(new NoteArray([note]))
          .build();

        log("Submitting shot directly from game account (no wallet popup)...");
        await runExclusive(async () => {
          if (prover) {
            await client.submitNewTransactionWithProver(myAccountId, txRequest, prover);
          } else {
            await client.submitNewTransaction(myAccountId, txRequest);
          }
        });
        log("Shot submitted successfully");
        setIsSubmitting(false);

        // Brief delay then sync to update local state after submission.
        setIsWaiting(true);
        log(`Waiting ${NETWORK_SYNC_DELAY_MS / 1000}s for network...`);
        await new Promise((r) => setTimeout(r, NETWORK_SYNC_DELAY_MS));
        await sync();
        refetchState();
        setIsWaiting(false);
        log("Shot flow complete");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Shot FAILED: ${msg}`);
        setIsSubmitting(false);
        setIsWaiting(false);
        setError(msg);
      }
    },
    [myAddress, client, runExclusive, prover, defenderAddress, sync, refetchState],
  );

  return {
    fireShot,
    isSubmitting,
    isWaiting,
    error,
    walletConnected: !!myAddress,
  };
}
