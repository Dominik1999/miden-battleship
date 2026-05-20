import { useEffect, useRef, useCallback, useState } from "react";
import { useMidenClient, useMiden, useNotes, useAccount } from "@miden-sdk/react";
import {
  TransactionRequestBuilder,
  NoteAndArgs,
  NoteAndArgsArray,
  NoteRecipient,
  NoteRecipientArray,
  NoteScript,
  NoteStorage,
  NoteFilter,
  NoteFilterTypes,
  Package,
  AccountId,
  Felt,
  FeltArray,
  Word,
} from "@miden-sdk/miden-sdk";
import { AUTO_SYNC_INTERVAL_MS, SLOT_BOARD_ROWS, SLOT_OPPONENT, TOTAL_SHIP_CELLS } from "@/config";

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
 * Raw WebClient operations (syncState, getInputNotes, submitNewTransaction)
 * are serialized through runExclusive() to avoid concurrent WASM access.
 */
export function useGameplaySync(
  myAccountId: string,
  enabled: boolean,
) {
  const client = useMidenClient();
  const { runExclusive, prover } = useMiden();
  const proverRef = useRef(prover);
  proverRef.current = prover;
  const { notes: allNotes } = useNotes(
    myAccountId ? { accountId: myAccountId } : undefined,
  );
  const { refetch: refetchAccount } = useAccount(myAccountId);
  const refetchRef = useRef(refetchAccount);
  refetchRef.current = refetchAccount;

  // Track whether the opponent's game is over (detected from result notes).
  // When a result note contains gameOver=1, it means WE fired the winning shot.
  // We don't consume the result note — just read the flag from its inputs.
  const [opponentGameOver, setOpponentGameOver] = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  const tickRef = useRef<() => Promise<void>>(async () => {});
  const notesRef = useRef(allNotes);
  notesRef.current = allNotes;
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
    return script;
  }, []);

  /**
   * Classify a note and build a TX request if it's a shot-note.
   * MUST be called from within a runExclusive block (no internal locking).
   * Returns: TransactionRequest (shot), null (result-note), or "skip".
   */
  const classifyAndBuildRequest = useCallback(
    async (noteIdStr: string) => {
      const accountIdObj = AccountId.fromBech32(myAccountId);
      const resultScript = await loadResultScript();

      const noteRecord = await client.getInputNote(noteIdStr);
      if (!noteRecord) {
        throw new Error(`Note ${noteIdStr} not found in local store`);
      }

      const note = noteRecord.toNote();
      const noteInputs = note.recipient().storage().items();
      log(`Note ${noteIdStr}: ${noteInputs.length} inputs`);

      if (noteInputs.length === 4) {
        // Result-note: don't consume — these target the shooter's wallet, not
        // the defender's game account. Consuming causes nullifier conflicts.
        // But DO read the gameOver flag: if gameOver=1, WE fired the winning shot.
        const encodedResult = noteInputs[3].asInt();
        const isGameOver = encodedResult % 2n === 1n;
        log(`Result note (skipping): result=${encodedResult / 2n === 1n ? "HIT" : "MISS"}, gameOver=${isGameOver}`);
        if (isGameOver) {
          log("*** GAME OVER detected from result note — we won! ***");
          setOpponentGameOver(true);
        }
        return "skip" as const;
      }

      if (noteInputs.length !== 14) {
        log(`Skipping note ${noteIdStr} — unknown type (${noteInputs.length} inputs)`);
        return "skip" as const;
      }

      // Shot-note: build TX request with expected output recipient
      const row = noteInputs[0].asInt();
      const col = noteInputs[1].asInt();
      const turn = noteInputs[2];
      const serialNum = Word.newFromFelts([noteInputs[3], noteInputs[4], noteInputs[5], noteInputs[6]]);
      const shooterPrefix = noteInputs[11];
      const shooterSuffix = noteInputs[12];

      // Read the defender's own board cell to predict hit/miss
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wasmClient = (client as any).wasmWebClient;
      if (!wasmClient) {
        throw new Error("Cannot access raw WASM WebClient for storage read");
      }
      const defenderAccount = await wasmClient.getAccount(accountIdObj);
      if (!defenderAccount) {
        throw new Error("Cannot read defender account from local store");
      }
      const rowWord = defenderAccount.storage().getItem(SLOT_BOARD_ROWS[Number(row)]);
      const packedRow = rowWord ? rowWord.toU64s()[0] : 0n;
      const cellState = Number((packedRow >> (col * 3n)) & 0x7n);
      const isHit = cellState >= 1 && cellState <= 5;
      const result = isHit ? 1n : 0n;

      const opponentSlot = defenderAccount.storage().getItem(SLOT_OPPONENT);
      const shipsHitCount = opponentSlot ? Number(opponentSlot.toU64s()[2]) : 0;
      const newHitCount = isHit ? shipsHitCount + 1 : shipsHitCount;
      const gameOver = newHitCount >= TOTAL_SHIP_CELLS ? 1n : 0n;

      const encodedResult = new Felt(result * 2n + gameOver);
      log(`Shot at (${row},${col}): cell=${cellState}, hit=${isHit}, gameOver=${gameOver}`);

      const resultNoteInputs = new FeltArray();
      resultNoteInputs.push(shooterPrefix);
      resultNoteInputs.push(shooterSuffix);
      resultNoteInputs.push(turn);
      resultNoteInputs.push(encodedResult);

      const correctRecipient = new NoteRecipient(
        serialNum,
        resultScript,
        new NoteStorage(resultNoteInputs),
      );

      const noteAndArgs = new NoteAndArgs(note);

      return new TransactionRequestBuilder()
        .withInputNotes(new NoteAndArgsArray([noteAndArgs]))
        .withExpectedOutputRecipients(new NoteRecipientArray([correctRecipient]))
        .build();
    },
    [myAccountId, client, loadResultScript],
  );

  // The tick: sync + classify + consume, ALL within a single runExclusive.
  tickRef.current = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await runExclusive(async () => {
        // Sync directly (no SDK sync() which triggers useAccount re-fetches)
        await client.syncState();

        // Read only committed (unconsumed) notes from client inside the lock.
        // Using Committed instead of All avoids re-processing consumed handshake notes.
        const committedNotes = await client.getInputNotes(new NoteFilter(NoteFilterTypes.Committed));
        const pending = committedNotes.filter(
          (n: { id: () => { toString: () => string }; isConsumed: () => boolean; isProcessing: () => boolean; isAuthenticated: () => boolean }) =>
            !n.isProcessing() &&
            n.isAuthenticated() &&
            !handledNoteIds.has(n.id().toString()) &&
            !(preGameNoteIds?.has(n.id().toString()) ?? false),
        );

        if (pending.length > 0) {
          log(`Found ${pending.length} pending note(s)`);

          // Process ONE note per tick to keep proving time bounded
          const noteId = pending[0].id().toString();

          try {
            const txRequest = await classifyAndBuildRequest(noteId);
            if (txRequest === "skip") {
              handledNoteIds.add(noteId);
            } else {
              // Shot-note: custom TX via raw client, using remote prover if available
              const accountIdObj = AccountId.fromBech32(myAccountId);
              log(`Consuming shot-note ${noteId}...`);
              if (proverRef.current) {
                await client.submitNewTransactionWithProver(accountIdObj, txRequest, proverRef.current);
              } else {
                await client.submitNewTransaction(accountIdObj, txRequest);
              }
              handledNoteIds.add(noteId);
              log(`Shot-note ${noteId} consumed`);
            }
          } catch (err) {
            handledNoteIds.add(noteId);
            log(`Note ${noteId} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

      });
      // Trigger useAccount refetch so the UI picks up state changes
      // made via raw client.submitNewTransaction() inside runExclusive.
      refetchRef.current();
    } catch (err) {
      log(`Tick error: ${err instanceof Error ? err.message : String(err)}`);
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

  return { opponentGameOver };
}
