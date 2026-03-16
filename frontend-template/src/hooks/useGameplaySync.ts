import { useEffect, useRef, useCallback } from "react";
import { useMidenClient, useMiden, useNotes, useSyncState, useConsume, useTransaction } from "@miden-sdk/react";
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
 * Shot-notes (14 inputs) create output result-notes, so we use useTransaction
 * with withExpectedOutputRecipients(). Result-notes (4 inputs) are simple
 * consumes with no output notes, so we use useConsume.
 */
export function useGameplaySync(
  myAccountId: string,
  enabled: boolean,
  refetchState: () => void,
) {
  const { sync } = useSyncState();
  const client = useMidenClient();
  const { runExclusive } = useMiden();
  const { notes: allNotes, refetch: refetchNotes } = useNotes(
    myAccountId ? { accountId: myAccountId } : undefined,
  );
  const { consume } = useConsume();
  const { execute } = useTransaction();

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  // IDs we've successfully consumed or that failed (never retry these)
  const handledIds = useRef<Set<string>>(new Set());
  // Note IDs that existed when gameplay started (snapshot on first render)
  const preGameIds = useRef<Set<string> | null>(null);
  // Keep latest notes in a ref so the interval closure sees fresh data
  const notesRef = useRef(allNotes);
  notesRef.current = allNotes;
  // Cached raw bytes of result_note.masp (NOT the WASM object — WASM objects
  // can be consumed/freed when passed to constructors, so we cache bytes and
  // create fresh NoteScript instances each time)
  const resultMaspBytesRef = useRef<Uint8Array | null>(null);

  // Snapshot pre-game notes on first render with data
  if (preGameIds.current === null && allNotes && allNotes.length > 0) {
    preGameIds.current = new Set(allNotes.map((n) => n.id().toString()));
    log(`Snapshotted ${preGameIds.current.size} pre-game note(s)`);
  }

  /** Load .masp bytes (cached) and create a FRESH NoteScript each call */
  const loadResultScript = useCallback(async (): Promise<NoteScript> => {
    if (!resultMaspBytesRef.current) {
      log("Fetching result_note.masp...");
      const buf = await fetch(`${import.meta.env.BASE_URL}packages/result_note.masp`).then((r) =>
        r.arrayBuffer(),
      );
      resultMaspBytesRef.current = new Uint8Array(buf);
    }
    // Create fresh WASM objects each time to avoid consumed-pointer issues
    const pkg = Package.deserialize(resultMaspBytesRef.current);
    const script = NoteScript.fromPackage(pkg);
    // Diagnostic: verify the loaded script root matches RESULT_SCRIPT_ROOT from config
    const root = script.root();
    const rootFelts = root.toFelts();
    const loadedRoot = [rootFelts[0].asInt(), rootFelts[1].asInt(), rootFelts[2].asInt(), rootFelts[3].asInt()];
    const configRoot = RESULT_SCRIPT_ROOT;
    const match = loadedRoot.every((v, i) => v === configRoot[i]);
    log(`Result script root from .masp: [${loadedRoot.join(", ")}]`);
    log(`RESULT_SCRIPT_ROOT from config: [${configRoot.join(", ")}]`);
    log(`Roots match: ${match}`);
    if (!match) {
      log("WARNING: Script root mismatch! The kernel will fail to find the script.");
    }
    return script;
  }, []);

  /**
   * Build a TransactionRequest for consuming a shot-note.
   * Reads the defender's board to predict hit/miss and builds the correct
   * NoteRecipient so the kernel can verify the output result-note.
   */
  const buildShotNoteRequest = useCallback(
    async (noteIdStr: string) => {
      const accountIdObj = AccountId.fromBech32(myAccountId);
      const resultScript = await loadResultScript();

      // Use runExclusive to safely read account storage from the WASM client
      return await runExclusive(async () => {
        const noteRecord = await client.getInputNote(noteIdStr);
        if (!noteRecord) {
          throw new Error(`Note ${noteIdStr} not found in local store`);
        }

        const note = noteRecord.toNote();
        log(`Note metadata: tag=${note.metadata().tag().asU32()}, type=${note.metadata().noteType()}`);
        const noteInputs = note.recipient().inputs().values();
        log(`Note has ${noteInputs.length} inputs`);

        if (noteInputs.length === 4) {
          // Result-note — return null to signal useConsume path
          const turn = noteInputs[2].asInt();
          const encodedResult = noteInputs[3].asInt();
          const shotResult = encodedResult / 2n;
          const gameOver = encodedResult % 2n;
          log(`Result note: turn=${turn}, result=${shotResult === 1n ? "HIT" : "MISS"}, gameOver=${gameOver}`);
          return null;
        }

        if (noteInputs.length !== 14) {
          log(`Skipping note ${noteIdStr} — unknown type (${noteInputs.length} inputs)`);
          return "skip" as const;
        }

        // --- SHOT-NOTE (14 inputs): build TX request with expected output recipient ---
        const noteScriptRoot = [noteInputs[7].asInt(), noteInputs[8].asInt(), noteInputs[9].asInt(), noteInputs[10].asInt()];
        log(`Shot note's result_script_root (inputs[7..10]): [${noteScriptRoot.join(", ")}]`);
        log(`Config RESULT_SCRIPT_ROOT: [${RESULT_SCRIPT_ROOT.join(", ")}]`);
        const inputsMatch = noteScriptRoot.every((v, i) => v === RESULT_SCRIPT_ROOT[i]);
        log(`Shot inputs match config: ${inputsMatch}`);

        const row = noteInputs[0].asInt();
        const col = noteInputs[1].asInt();
        const turn = noteInputs[2];
        const serialNum = Word.newFromFelts([noteInputs[3], noteInputs[4], noteInputs[5], noteInputs[6]]);
        const shooterPrefix = noteInputs[11];
        const shooterSuffix = noteInputs[12];

        // Read the defender's own board cell at (row, col) to predict hit/miss
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wasmClient = (client as any).wasmWebClient;
        if (!wasmClient) {
          throw new Error("Cannot access raw WASM WebClient for storage read");
        }
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

        // Read current shipsHitCount to determine game_over
        const opponentSlot = defenderAccount.storage().getItem(SLOT_OPPONENT);
        const shipsHitCount = opponentSlot ? Number(opponentSlot.toU64s()[2]) : 0;
        const newHitCount = isHit ? shipsHitCount + 1 : shipsHitCount;
        const gameOver = newHitCount >= TOTAL_SHIP_CELLS ? 1n : 0n;

        const encodedResult = new Felt(result * 2n + gameOver);
        log(`Predicted shot result: cell=${cellState}, hit=${isHit}, shipsHit=${shipsHitCount}→${newHitCount}, gameOver=${gameOver}, encoded=${result * 2n + gameOver}`);

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
        const recipientArray = new NoteRecipientArray([correctRecipient]);

        const noteAndArgs = new NoteAndArgs(note);
        const noteAndArgsArray = new NoteAndArgsArray([noteAndArgs]);

        return new TransactionRequestBuilder()
          .withInputNotes(noteAndArgsArray)
          .withExpectedOutputRecipients(recipientArray)
          .build();
      });
    },
    [myAccountId, client, runExclusive, loadResultScript],
  );

  /**
   * Consume a single note. Shot-notes go through useTransaction (custom TX
   * with expected output recipients). Result-notes go through useConsume.
   * Both paths use the wallet adapter's proper signing flow.
   */
  const consumeNote = useCallback(
    async (noteIdStr: string) => {
      const txRequest = await buildShotNoteRequest(noteIdStr);

      if (txRequest === "skip") {
        return; // unknown note type, skip silently
      }

      if (txRequest === null) {
        // Result-note: simple consume via SDK hook
        log(`Consuming result-note ${noteIdStr} via useConsume...`);
        await consume({ accountId: myAccountId, noteIds: [noteIdStr] });
        log(`Result-note ${noteIdStr} consumed`);
        return;
      }

      // Shot-note: custom TX with expected output recipients via SDK hook
      log(`Consuming shot-note ${noteIdStr} via useTransaction...`);
      await execute({
        accountId: myAccountId,
        request: () => txRequest,
        skipSync: true, // we already synced in the tick
      });
      log(`Shot-note ${noteIdStr} consumed, result-note created`);
    },
    [myAccountId, buildShotNoteRequest, consume, execute],
  );

  const tick = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await sync();
      refetchNotes();

      const notes = notesRef.current ?? [];
      const pending = notes.filter(
        (n) =>
          !n.isConsumed() &&
          !n.isProcessing() &&
          n.isAuthenticated() &&
          !handledIds.current.has(n.id().toString()) &&
          !(preGameIds.current?.has(n.id().toString()) ?? false),
      );

      if (pending.length > 0) {
        // Consume notes one at a time to handle errors individually
        for (const note of pending) {
          const noteId = note.id().toString();
          log(`Auto-consuming note: ${noteId}`);
          try {
            await consumeNote(noteId);
            handledIds.current.add(noteId);
            log(`Consumed ${noteId} successfully`);
          } catch (consumeErr) {
            handledIds.current.add(noteId);
            log(
              `Consume failed for ${noteId} (marked as handled): ${consumeErr instanceof Error ? consumeErr.message : String(consumeErr)}`,
            );
          }
        }

        // Re-sync after consuming to get updated state
        await sync();
        refetchNotes();
      }

      refetchState();
    } catch (err) {
      log(
        `Sync error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      busyRef.current = false;
    }
  }, [myAccountId, sync, consumeNote, refetchNotes, refetchState]);

  useEffect(() => {
    if (!enabled || !myAccountId) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    log(`Starting gameplay sync (every ${AUTO_SYNC_INTERVAL_MS / 1000}s)`);

    // Run immediately on enable, then on interval
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
