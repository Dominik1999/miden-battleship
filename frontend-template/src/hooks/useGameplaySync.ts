import { useEffect, useRef, useCallback } from "react";
import { useMidenClient, useMiden, useNotes, useSyncState } from "@miden-sdk/react";
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
} from "@miden-sdk/miden-sdk";
import { randomWord } from "@/lib/miden";
import { AUTO_SYNC_INTERVAL_MS, RESULT_SCRIPT_ROOT } from "@/config";

const log = (msg: string, ...args: unknown[]) =>
  console.log(
    `%c[GameplaySync] ${msg}`,
    "color: #0af; font-weight: bold",
    ...args,
  );

/**
 * Syncs from the network and auto-consumes incoming notes (opponent shots)
 * on the player's own game account during gameplay.
 *
 * Uses TransactionRequestBuilder.withInputNotes() + withExpectedOutputRecipients()
 * because shot notes create output notes (result notes). The kernel needs
 * the result note's script pre-loaded in the DataStore to create public output notes.
 */
export function useGameplaySync(
  myAccountId: string,
  enabled: boolean,
  refetchState: () => void,
) {
  const { sync } = useSyncState();
  const client = useMidenClient();
  const { runExclusive, prover } = useMiden();
  const { notes: allNotes, refetch: refetchNotes } = useNotes(
    myAccountId ? { accountId: myAccountId } : undefined,
  );

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
      const buf = await fetch("/packages/result_note.masp").then((r) =>
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
   * Consume a single note using TransactionRequestBuilder.withInputNotes().
   * Provides the result note script via withExpectedOutputRecipients() so the
   * kernel's DataStore has it when the shot note creates the result output note.
   *
   * Uses executeTransaction() directly (bypassing the worker serialization path)
   * to avoid potential loss of expected_output_recipients during serialization.
   */
  const consumeNoteWithInputs = useCallback(
    async (noteIdStr: string) => {
      const accountIdObj = AccountId.fromBech32(myAccountId);
      const resultScript = await loadResultScript();

      await runExclusive(async () => {
        // Fetch the full note record from the local client store
        const noteRecord = await client.getInputNote(noteIdStr);
        if (!noteRecord) {
          throw new Error(`Note ${noteIdStr} not found in local store`);
        }

        const note = noteRecord.toNote();
        // Diagnostic: log note details
        log(`Note metadata: tag=${note.metadata().tag().asU32()}, type=${note.metadata().noteType()}`);
        const noteInputs = note.recipient().inputs().values();
        log(`Note has ${noteInputs.length} inputs`);
        if (noteInputs.length >= 11) {
          const noteScriptRoot = [noteInputs[7].asInt(), noteInputs[8].asInt(), noteInputs[9].asInt(), noteInputs[10].asInt()];
          log(`Shot note's result_script_root (inputs[7..10]): [${noteScriptRoot.join(", ")}]`);
          log(`Config RESULT_SCRIPT_ROOT: [${RESULT_SCRIPT_ROOT.join(", ")}]`);
          const inputsMatch = noteScriptRoot.every((v, i) => v === RESULT_SCRIPT_ROOT[i]);
          log(`Shot inputs match config: ${inputsMatch}`);
        }
        const noteAndArgs = new NoteAndArgs(note);
        const noteAndArgsArray = new NoteAndArgsArray([noteAndArgs]);

        // Build NoteRecipient with the result note script (fresh WASM objects each time).
        const dummyInputs = new NoteInputs(new FeltArray());
        const dummyRecipient = new NoteRecipient(
          randomWord(),
          resultScript,
          dummyInputs,
        );
        const recipientArray = new NoteRecipientArray([dummyRecipient]);

        const txRequest = new TransactionRequestBuilder()
          .withInputNotes(noteAndArgsArray)
          .withExpectedOutputRecipients(recipientArray)
          .build();

        log(`Executing TX for note ${noteIdStr} (direct WASM client, no worker)...`);

        // Access the raw WASM WebClient directly to bypass worker serialization.
        // The wrapper's executeTransaction/submitNewTransaction serialize the
        // TransactionRequest and send it to a worker. This serialization may
        // lose expected_output_recipients, causing the kernel to fail when
        // the shot note calls output_note::create().
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wasmClient = (client as any).wasmWebClient;
        if (!wasmClient) {
          throw new Error("Cannot access raw WASM WebClient — wasmWebClient is null");
        }

        const txResult = await wasmClient.executeTransaction(
          accountIdObj,
          txRequest,
        );
        log(`TX executed successfully on main thread, proving...`);

        // Prove with remote prover and submit
        const proven = await wasmClient.proveTransaction(txResult, prover ?? undefined);
        log(`TX proved, submitting...`);
        const height = await wasmClient.submitProvenTransaction(proven, txResult);
        log(`TX submitted at height ${height}, applying...`);
        await wasmClient.applyTransaction(txResult, height);
        log(`TX for note ${noteIdStr} completed`);
      });
    },
    [myAccountId, client, runExclusive, prover, loadResultScript],
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
            await consumeNoteWithInputs(noteId);
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
  }, [myAccountId, sync, consumeNoteWithInputs, refetchNotes, refetchState]);

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
