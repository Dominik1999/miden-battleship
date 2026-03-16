import { useEffect, useRef, useCallback } from "react";
import { useMidenClient, useMiden } from "@miden-sdk/react";
import {
  TransactionRequestBuilder,
  NoteAndArgs,
  NoteAndArgsArray,
  NoteRecipient,
  NoteRecipientArray,
  NoteScript,
  NoteInputs,
  Package,
  AccountId,
  Felt,
  FeltArray,
  Word,
} from "@miden-sdk/miden-sdk";
import { AUTO_SYNC_INTERVAL_MS, RESULT_SCRIPT_ROOT, SLOT_BOARD, SLOT_OPPONENT, TOTAL_SHIP_CELLS } from "@/config";

const log = (msg: string, ...args: unknown[]) =>
  console.log(
    `%c[GameplaySync] ${msg}`,
    "color: #0af; font-weight: bold",
    ...args,
  );

/**
 * Syncs from the network and auto-consumes incoming notes (opponent shots
 * and result notes) on the player's own game account during gameplay.
 *
 * Uses the raw WASM WebClient directly for sync and consumption to avoid
 * the wallet adapter's note screener popups. The game account's auth is
 * handled internally by the WASM client (key stored in IndexedDB), so
 * wallet signing is not needed.
 */
export function useGameplaySync(
  myAccountId: string,
  enabled: boolean,
  refetchState: () => void,
) {
  const client = useMidenClient();
  const { runExclusive, prover } = useMiden();

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  const handledIds = useRef<Set<string>>(new Set());
  const resultMaspBytesRef = useRef<Uint8Array | null>(null);

  /** Load .masp bytes (cached) and create a FRESH NoteScript each call */
  const loadResultScript = useCallback(async (): Promise<NoteScript> => {
    if (!resultMaspBytesRef.current) {
      log("Fetching result_note.masp...");
      const buf = await fetch(`${import.meta.env.BASE_URL}packages/result_note.masp`).then((r) =>
        r.arrayBuffer(),
      );
      resultMaspBytesRef.current = new Uint8Array(buf);
    }
    const pkg = Package.deserialize(resultMaspBytesRef.current);
    const script = NoteScript.fromPackage(pkg);
    const root = script.root();
    const rootFelts = root.toFelts();
    const loadedRoot = [rootFelts[0].asInt(), rootFelts[1].asInt(), rootFelts[2].asInt(), rootFelts[3].asInt()];
    const match = loadedRoot.every((v, i) => v === RESULT_SCRIPT_ROOT[i]);
    if (!match) {
      log("WARNING: Script root mismatch! The kernel will fail to find the script.");
    }
    return script;
  }, []);

  /**
   * One tick: sync via raw WASM client, find unconsumed notes, consume them.
   * Everything goes through wasmClient directly — no wallet adapter popups.
   */
  const tick = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const accountIdObj = AccountId.fromBech32(myAccountId);

      await runExclusive(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wasmClient = (client as any).wasmWebClient;
        if (!wasmClient) {
          throw new Error("Cannot access raw WASM WebClient");
        }

        // Sync from network using the raw WASM syncStateImpl().
        // We can't use client.syncState() inside runExclusive (lock conflict),
        // and the SDK's sync() hook triggers note screener wallet popups.
        await wasmClient.syncStateImpl();

        // Get all input notes for this account
        const allNotes = await wasmClient.getInputNotes(0); // 0 = Committed status
        const pending = allNotes.filter(
          (n: { id: () => { toString: () => string } }) =>
            !handledIds.current.has(n.id().toString()),
        );

        if (pending.length === 0) {
          refetchState();
          return;
        }

        for (const noteRecord of pending) {
          const noteIdStr = noteRecord.id().toString();
          log(`Processing note: ${noteIdStr}`);
          try {
            const note = noteRecord.toNote();
            const noteInputs = note.recipient().inputs().values();
            log(`Note has ${noteInputs.length} inputs`);

            const noteAndArgs = new NoteAndArgs(note);
            const noteAndArgsArray = new NoteAndArgsArray([noteAndArgs]);

            let txRequest;

            if (noteInputs.length === 14) {
              // --- SHOT-NOTE: defender consumes, creates result output note ---
              const resultScript = await loadResultScript();

              const row = noteInputs[0].asInt();
              const col = noteInputs[1].asInt();
              const turn = noteInputs[2];
              const serialNum = Word.newFromFelts([noteInputs[3], noteInputs[4], noteInputs[5], noteInputs[6]]);
              const shooterPrefix = noteInputs[11];
              const shooterSuffix = noteInputs[12];

              // Read defender's board cell to predict hit/miss
              const defenderAccount = await wasmClient.getAccount(accountIdObj);
              if (!defenderAccount) {
                throw new Error("Cannot read defender account from local store");
              }
              const boardKey = Word.newFromFelts([
                new Felt(0n), new Felt(0n), new Felt(row), new Felt(col),
              ]);
              const cellValue = defenderAccount.storage().getMapItem(SLOT_BOARD, boardKey);
              const cellState = cellValue ? Number(cellValue.toU64s()[3]) : 0;
              const isHit = cellState >= 1 && cellState <= 5;
              const result = isHit ? 1n : 0n;

              const opponentSlot = defenderAccount.storage().getItem(SLOT_OPPONENT);
              const shipsHitCount = opponentSlot ? Number(opponentSlot.toU64s()[2]) : 0;
              const newHitCount = isHit ? shipsHitCount + 1 : shipsHitCount;
              const gameOver = newHitCount >= TOTAL_SHIP_CELLS ? 1n : 0n;

              const encodedResult = new Felt(result * 2n + gameOver);
              log(`Shot at (${row},${col}): cell=${cellState}, hit=${isHit}, shipsHit=${shipsHitCount}→${newHitCount}, gameOver=${gameOver}, encoded=${result * 2n + gameOver}`);

              const resultNoteInputs = new FeltArray();
              resultNoteInputs.push(shooterPrefix);
              resultNoteInputs.push(shooterSuffix);
              resultNoteInputs.push(turn);
              resultNoteInputs.push(encodedResult);

              const correctRecipient = new NoteRecipient(
                serialNum,
                resultScript,
                new NoteInputs(resultNoteInputs),
              );

              txRequest = new TransactionRequestBuilder()
                .withInputNotes(noteAndArgsArray)
                .withExpectedOutputRecipients(new NoteRecipientArray([correctRecipient]))
                .build();
            } else if (noteInputs.length === 4) {
              // --- RESULT-NOTE: shooter consumes to clean up UTXO ---
              const turn = noteInputs[2].asInt();
              const encodedResult = noteInputs[3].asInt();
              const shotResult = encodedResult / 2n;
              const gameOver = encodedResult % 2n;
              log(`Result note: turn=${turn}, result=${shotResult === 1n ? "HIT" : "MISS"}, gameOver=${gameOver}`);

              txRequest = new TransactionRequestBuilder()
                .withInputNotes(noteAndArgsArray)
                .build();
            } else {
              log(`Skipping note ${noteIdStr} — unknown type (${noteInputs.length} inputs)`);
              handledIds.current.add(noteIdStr);
              continue;
            }

            log(`Executing TX for note ${noteIdStr}...`);
            const txResult = await wasmClient.executeTransaction(accountIdObj, txRequest);
            log(`TX executed, proving...`);
            const proven = await wasmClient.proveTransaction(txResult, prover ?? undefined);
            log(`TX proved, submitting...`);
            const height = await wasmClient.submitProvenTransaction(proven, txResult);
            log(`TX submitted at height ${height}, applying...`);
            await wasmClient.applyTransaction(txResult, height);
            log(`Note ${noteIdStr} consumed successfully`);
            handledIds.current.add(noteIdStr);
          } catch (err) {
            handledIds.current.add(noteIdStr);
            log(`Consume failed for ${noteIdStr}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Re-sync after consuming
        await wasmClient.syncState();
      });

      refetchState();
    } catch (err) {
      log(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busyRef.current = false;
    }
  }, [myAccountId, client, runExclusive, prover, loadResultScript, refetchState]);

  useEffect(() => {
    if (!enabled || !myAccountId) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    log(`Starting gameplay sync (every ${AUTO_SYNC_INTERVAL_MS / 1000}s)`);
    tick();
    intervalRef.current = setInterval(tick, AUTO_SYNC_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        log("Stopped gameplay sync.");
      }
    };
  }, [enabled, myAccountId, tick]);
}
