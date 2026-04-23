import { useState, useCallback } from "react";
import { useSyncState } from "@miden-sdk/react";
import {
  useMidenFiWallet,
  Transaction,
} from "@miden-sdk/miden-wallet-adapter";
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
 * Builds a shot-note targeting the defender's game account and submits it via wallet.
 *
 * Shot-note inputs (14 Felts):
 *   [0] row, [1] col, [2] turn,
 *   [3..7] result_serial_num, [7..11] result_script_root,
 *   [11] shooter_prefix, [12] shooter_suffix, [13] shooter_tag
 */
export function useFireShot(
  defenderAddress: string,
  refetchState: () => void,
) {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const { address: walletAddress, connected, requestTransaction } = useMidenFiWallet();
  const { sync } = useSyncState();

  const fireShot = useCallback(
    async (row: number, col: number, turn: number) => {
      if (!walletAddress || !requestTransaction) {
        log("Not ready: wallet not connected");
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
        const walletAccountId = AccountId.fromBech32(walletAddress);

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
        // shooter AccountId decomposed into prefix + suffix
        inputFelts.push(walletAccountId.prefix());
        inputFelts.push(walletAccountId.suffix());
        // shooter_tag — tag for the result-note to come back to us
        const shooterTag = NoteTag.withAccountTarget(walletAccountId);
        inputFelts.push(new Felt(BigInt(shooterTag.asU32())));

        const storage = new NoteStorage(inputFelts);
        const serialNum = randomWord();
        const recipient = new NoteRecipient(serialNum, noteScript, storage);

        // Build note metadata targeting the defender's game account
        const tag = NoteTag.withAccountTarget(defenderAccountId);
        const metadata = new NoteMetadata(
          walletAccountId,
          NoteType.Public,
          tag,
        );

        // Assemble note and submit
        const note = new Note(new NoteAssets(), metadata, recipient);
        const txRequest = new TransactionRequestBuilder()
          .withOwnOutputNotes(new NoteArray([note]))
          .build();

        const tx = Transaction.createCustomTransaction(
          walletAddress,
          defenderAddress,
          txRequest,
        );
        log("Submitting shot via wallet...");
        await requestTransaction(tx);
        log("Shot submitted successfully");
        setIsSubmitting(false);

        // Wait for network to process the shot, then re-sync
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
    [walletAddress, requestTransaction, defenderAddress, sync, refetchState],
  );

  return {
    fireShot,
    isSubmitting,
    isWaiting,
    error,
    walletConnected: connected,
  };
}
