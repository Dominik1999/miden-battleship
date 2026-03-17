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

// Module-scope sets — survive component remounts (StrictMode, conditional
// rendering). Reset naturally on page reload (alongside clearMidenStorage).
const handledNoteIds = new Set<string>();
let preGameNoteIds: Set<string> | null = null;

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
  // Stable ref for tick so the polling useEffect never restarts due to
  // tick's callback identity changing (which cascades from sync/consume/execute).
  const tickRef = useRef<() => Promise<void>>(async () => {});
  // Keep latest notes in a ref so the interval closure sees fresh data
  const notesRef = useRef(allNotes);
  notesRef.current = allNotes;
  // Cached raw bytes of result_note.masp (NOT the WASM object — WASM objects
  // can be consumed/freed when passed to constructors, so we cache bytes and
  // create fresh NoteScript instances each time)
  const resultMaspBytesRef = useRef<Uint8Array | null>(null);

  // Snapshot pre-game notes on first render with data
  if (preGameNoteIds === null && allNotes && allNotes.length > 0) {
    preGameNoteIds = new Set(allNotes.map((n) => n.id().toString()));
    log(`Snapshotted ${preGameNoteIds.size} pre-game note(s)`);
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

  // Keep tickRef pointing at the latest tick closure on every render.
  // This avoids wrapping in useCallback (whose identity changes cascade).
  tickRef.current = async () => {
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
          !handledNoteIds.has(n.id().toString()) &&
          !(preGameNoteIds?.has(n.id().toString()) ?? false),
      );

      if (pending.length > 0) {
        log(`Found ${pending.length} pending note(s) to process`);

        // Classify notes into shot-notes and result-notes
        const resultNoteIds: string[] = [];
        const shotNotes: { id: string }[] = [];

        for (const note of pending) {
          const noteId = note.id().toString();
          try {
            const txRequest = await buildShotNoteRequest(noteId);
            if (txRequest === "skip") {
              handledNoteIds.add(noteId);
            } else if (txRequest === null) {
              resultNoteIds.push(noteId);
            } else {
              shotNotes.push({ id: noteId });
            }
          } catch (err) {
            handledNoteIds.add(noteId);
            log(`Classification failed for ${noteId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Batch all result-notes into a single consume call (one popup)
        if (resultNoteIds.length > 0) {
          log(`Batch-consuming ${resultNoteIds.length} result-note(s): ${resultNoteIds.join(", ")}`);
          try {
            await consume({ accountId: myAccountId, noteIds: resultNoteIds });
            resultNoteIds.forEach((id) => handledNoteIds.add(id));
            log(`Result-notes consumed successfully`);
          } catch (err) {
            resultNoteIds.forEach((id) => handledNoteIds.add(id));
            log(`Result-note batch consume failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Process at most ONE shot-note per tick (each requires its own TX)
        if (shotNotes.length > 0) {
          const { id: shotId } = shotNotes[0];
          log(`Consuming shot-note ${shotId} (${shotNotes.length} total queued)`);
          try {
            await consumeNote(shotId);
            handledNoteIds.add(shotId);
            log(`Shot-note ${shotId} consumed successfully`);
          } catch (err) {
            handledNoteIds.add(shotId);
            log(`Shot-note consume failed for ${shotId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // SDK hooks already sync internally after each tx — just refetch notes
        refetchNotes();
      }

      refetchState();
    } catch (err) {
      log(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busyRef.current = false;
    }
  };

  useEffect(() => {
    if (!enabled || !myAccountId) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    log(`Starting gameplay sync (every ${AUTO_SYNC_INTERVAL_MS / 1000}s)`);

    // Stable wrapper that always calls the latest tick via ref.
    // This prevents the interval from being torn down and re-created
    // (with an immediate tick() call) every time tick's dependencies change.
    const stableTick = () => tickRef.current();

    stableTick();
    intervalRef.current = setInterval(stableTick, AUTO_SYNC_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        log("Stopped gameplay sync.");
      }
    };
  }, [enabled, myAccountId]);
}
