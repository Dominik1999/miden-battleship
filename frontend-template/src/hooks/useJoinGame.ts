import { useState, useCallback, useEffect, useRef } from "react";
import {
  useAccount,
  useConsume,
  useImportAccount,
  useMiden,
  useMidenClient,
  useNotes,
  useSyncState,
} from "@miden-sdk/react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter";
import { AccountId, NoteTag, NoteFilter, NoteFilterTypes } from "@miden-sdk/miden-sdk";
import { randomWord } from "@/lib/miden";
import {
  loadPackage,
  createGameAccount,
  buildSetupInputs,
  buildHandshakeInputs,
  submitNote,
} from "@/lib/notes";
import {
  SLOT_GAME_CONFIG,
  AUTO_SYNC_INTERVAL_MS,
  NETWORK_SYNC_DELAY_MS,
  CONSUME_MAX_RETRIES,
  CONSUME_RETRY_DELAY_MS,
} from "@/config";
import { PHASE_ACTIVE } from "@/types/game";
import type { ShipCell } from "@/types/game";

export type JoinStage =
  | "idle"
  | "loading"
  | "creating-account"
  | "setting-up"
  | "challenging"
  | "syncing"
  | "waiting"
  | "ready"
  | "error";

const log = (msg: string, ...args: unknown[]) =>
  console.log(
    `%c[JoinGame] ${msg}`,
    "color: #f0a; font-weight: bold",
    ...args,
  );

export function useJoinGame() {
  const [stage, setStage] = useState<JoinStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [gameAccountAddress, setGameAccountAddress] = useState<string | null>(
    null,
  );
  const [starterAddress, setStarterAddress] = useState<string | null>(null);

  const {
    address: walletAddress,
    connected,
    requestTransaction,
  } = useMidenFiWallet();
  const client = useMidenClient();
  const { runExclusive } = useMiden();
  const { sync } = useSyncState();
  const { importAccount } = useImportAccount();
  const { consume, isLoading: isConsuming } = useConsume();

  // Track our game account to poll for phase change
  const { account: gameAccount, refetch: refetchGame } = useAccount(
    gameAccountAddress ?? "",
  );

  // Track consumable notes for the game account
  const { consumableNotes, notes: allNotes, refetch: refetchNotes } = useNotes(
    gameAccountAddress ? { accountId: gameAccountAddress } : undefined,
  );

  // Track note IDs that existed before game creation so we only consume new ones
  const preGameNoteIds = useRef<Set<string>>(new Set());

  // Track note IDs we've already consumed (isConsumed() can lag behind)
  const consumedNoteIds = useRef<Set<string>>(new Set());

  // Track our own setup note ID so we can consume it first (before the accept note).
  // The contract requires CREATED → CHALLENGED (setup) before CHALLENGED → ACTIVE (accept).
  const setupNoteIdRef = useRef<string | null>(null);

  /**
   * Join a game by entering the starter's game account address.
   * Creates own game account, submits setup + challenge notes.
   */
  const joinGame = useCallback(
    async (
      starterAddr: string,
      cells: ShipCell[],
    ): Promise<string | null> => {
      if (!walletAddress || !requestTransaction) {
        setError("Wallet not connected");
        setStage("error");
        return null;
      }
      setError(null);
      setStarterAddress(starterAddr);

      try {
        // Load packages
        setStage("loading");
        log("Loading .masp packages...");
        const [battleshipPkg, setupPkg, challengePkg] = await Promise.all([
          loadPackage("battleship_account.masp"),
          loadPackage("setup_note.masp"),
          loadPackage("challenge_note.masp"),
        ]);

        // Snapshot existing note IDs so we only consume new ones later
        preGameNoteIds.current = new Set(
          (allNotes ?? []).map((n) => n.id().toString()),
        );
        log(`Snapshotted ${preGameNoteIds.current.size} pre-existing note IDs`);

        // Create joiner's game account via WebClient
        // Wrap in runExclusive to prevent concurrent WASM access
        setStage("creating-account");
        log("Creating game account...");
        const accountAddress = await runExclusive(() =>
          createGameAccount(client, battleshipPkg),
        );
        log(`Game account created: ${accountAddress}`);

        // Note: account is already in local store from client.newAccount().
        // importAccount({ type: "id" }) would fail because the account isn't
        // on-chain yet — it only gets deployed on first transaction (consume).

        const walletId = AccountId.fromBech32(walletAddress);
        const joinerAccountId = AccountId.fromBech32(accountAddress);
        const starterAccountId = AccountId.fromBech32(starterAddr);

        // Register tag so the client discovers notes targeted at our game account during sync
        const gameTag = NoteTag.withAccountTarget(joinerAccountId);
        log(`Registering tag ${gameTag.asU32()} for joiner game account...`);
        await runExclusive(() => client.addTag(gameTag.asU32().toString()));

        const gameId = randomWord();
        const commitment = randomWord();
        const gameIdFelts = gameId.toFelts();
        const commitFelts = commitment.toFelts();

        // Submit setup note (opponent = starter) — wallet is sender (has proper auth)
        // Save the note ID so consumeNotes() can consume it first (before accept note)
        setStage("setting-up");
        log("Submitting setup note (tag=2) → joiner game account...");
        const setupNoteId = await submitNote(
          setupPkg,
          buildSetupInputs(
            gameIdFelts,
            starterAccountId.prefix(),
            starterAccountId.suffix(),
            commitFelts,
            cells,
          ),
          joinerAccountId,
          accountAddress,
          2,
          walletAddress,
          walletId,
          requestTransaction as (tx: unknown) => Promise<unknown>,
        );

        setupNoteIdRef.current = setupNoteId;
        log(`Setup note ID saved: ${setupNoteId}`);

        // Submit challenge note (targeting starter) — wallet is sender
        setStage("challenging");
        log("Submitting challenge note (tag=3) → starter game account...");
        await submitNote(
          challengePkg,
          buildHandshakeInputs(
            gameIdFelts,
            joinerAccountId.prefix(),
            joinerAccountId.suffix(),
            commitFelts,
          ),
          starterAccountId,
          starterAddr,
          3,
          walletAddress,
          walletId,
          requestTransaction as (tx: unknown) => Promise<unknown>,
        );

        // Wait for initial sync
        setStage("syncing");
        log(`Waiting ${NETWORK_SYNC_DELAY_MS / 1000}s for network sync...`);
        await new Promise((r) => setTimeout(r, NETWORK_SYNC_DELAY_MS));
        await sync();
        log("Initial sync complete.");

        setGameAccountAddress(accountAddress);
        setStage("waiting");
        log("=== WAITING FOR STARTER TO ACCEPT ===");
        log(`Our game account: ${accountAddress}`);
        log(`Starter account: ${starterAddr}`);
        log(`Wallet: ${walletAddress}`);

        return accountAddress;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Join failed: ${msg}`);
        setStage("error");
        setError(msg);
        return null;
      }
    },
    [walletAddress, requestTransaction, client, importAccount, sync],
  );

  // Poll for game becoming active (starter sent accept)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const pollSuppressedRef = useRef(false);

  useEffect(() => {
    if (stage !== "waiting" || !gameAccountAddress) return;

    pollCountRef.current = 0;
    pollSuppressedRef.current = false;
    log(`Starting poll loop (every ${AUTO_SYNC_INTERVAL_MS / 1000}s) for game account: ${gameAccountAddress}`);

    pollRef.current = setInterval(async () => {
      if (pollSuppressedRef.current) return;
      pollCountRef.current++;
      const tick = pollCountRef.current;
      try {
        log(`[poll #${tick}] Syncing from network...`);
        if (pollSuppressedRef.current) return;
        await sync();
        if (pollSuppressedRef.current) return;
        log(`[poll #${tick}] Sync complete. Refetching account + notes...`);
        refetchGame();
        refetchNotes();
      } catch (err) {
        log(`[poll #${tick}] Poll error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, AUTO_SYNC_INTERVAL_MS);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        log("Poll loop stopped.");
      }
    };
  }, [stage, gameAccountAddress, sync, refetchGame, refetchNotes]);

  // Log note state changes
  useEffect(() => {
    if (stage !== "waiting") return;
    log(`Notes update — all: ${allNotes?.length ?? 0}, consumable: ${consumableNotes?.length ?? 0}`);
    if (allNotes && allNotes.length > 0) {
      allNotes.forEach((n, i) => {
        log(`  all[${i}]: id=${n.id().toString()}, consumed=${n.isConsumed()}, processing=${n.isProcessing()}, authenticated=${n.isAuthenticated()}`);
      });
    }
    if (consumableNotes && consumableNotes.length > 0) {
      consumableNotes.forEach((n, i) => {
        const rec = n.inputNoteRecord();
        log(`  consumable[${i}]: id=${rec.id().toString()}, consumed=${rec.isConsumed()}, processing=${rec.isProcessing()}`);
      });
    }
  }, [stage, allNotes, consumableNotes]);

  // Get NEW non-consumed, authenticated notes (exclude pre-game, already-consumed,
  // and non-game notes like P2ID token transfers that target the wallet, not the game account).
  const pendingNotes = (allNotes ?? []).filter(
    (n) => {
      if (n.isConsumed() || n.isProcessing() || !n.isAuthenticated()) return false;
      if (preGameNoteIds.current.has(n.id().toString())) return false;
      if (consumedNoteIds.current.has(n.id().toString())) return false;
      // Filter by note input count: game notes have 20 (setup) or 10 (challenge/accept) inputs.
      // P2ID notes and other non-game notes have different counts and would fail with
      // "P2ID's target account address and transaction address do not match".
      try {
        const inputCount = n.details().recipient().storage().items().length;
        return inputCount === 20 || inputCount === 10;
      } catch {
        return false;
      }
    },
  );

  // Consume notes ONE AT A TIME sequentially. The contract requires phase
  // transitions in order (CREATED→CHALLENGED→ACTIVE), so batching multiple
  // notes in a single consume() call fails with assertion errors.
  const consumeNotes = useCallback(async () => {
    if (!gameAccountAddress || pendingNotes.length === 0) {
      log("consumeNotes called but nothing to consume");
      return;
    }

    const noteIds = pendingNotes.map((n) => n.id().toString());
    log(`=== CONSUMING ${noteIds.length} NOTE(S) SEQUENTIALLY ===`);
    noteIds.forEach((id, i) => log(`  [${i}] ${id}`));
    log(`Against game account: ${gameAccountAddress}`);

    // Sort: setup note must be consumed first (CREATED → CHALLENGED)
    // before the accept note (CHALLENGED → ACTIVE). Without this ordering,
    // the accept note may be consumed first and hit an assertion failure.
    const setupId = setupNoteIdRef.current;
    if (setupId && noteIds.includes(setupId)) {
      const idx = noteIds.indexOf(setupId);
      noteIds.splice(idx, 1);
      noteIds.unshift(setupId);
      log(`Reordered: setup note ${setupId} moved to front`);
    }

    for (const noteId of noteIds) {
      let consumed = false;
      for (let attempt = 1; attempt <= CONSUME_MAX_RETRIES; attempt++) {
        try {
          // Diagnostic: dump local note store before consume attempt
          const allLocal = await client.getInputNotes(new NoteFilter(NoteFilterTypes.All));
          const committedLocal = await client.getInputNotes(new NoteFilter(NoteFilterTypes.Committed));
          log(`[diag] Before consume — ALL notes: ${allLocal.length}, COMMITTED: ${committedLocal.length}`);
          allLocal.forEach((n: { id: () => { toString: () => string }; isConsumed: () => boolean; isProcessing: () => boolean; isAuthenticated: () => boolean }, i: number) => {
            log(`[diag]   [${i}] id=${n.id().toString()}, consumed=${n.isConsumed()}, processing=${n.isProcessing()}, auth=${n.isAuthenticated()}`);
          });
          const match = allLocal.find((n: { id: () => { toString: () => string } }) => n.id().toString() === noteId);
          log(`[diag] Looking for ${noteId} — found? ${match ? "YES" : "NO"}`);

          log(`[attempt ${attempt}/${CONSUME_MAX_RETRIES}] Consuming note ${noteId}...`);
          const result = await consume({ accountId: gameAccountAddress, notes: [noteId] });
          log(`Consume succeeded for ${noteId}: ${JSON.stringify(result)}`);
          consumedNoteIds.current.add(noteId);
          consumed = true;

          // Sync between notes so the next consume sees the updated phase
          log("Syncing between notes...");
          await sync();
          refetchGame();
          refetchNotes();
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[attempt ${attempt}/${CONSUME_MAX_RETRIES}] Consume FAILED for ${noteId}: ${msg}`);
          if (attempt < CONSUME_MAX_RETRIES) {
            log(`Waiting ${CONSUME_RETRY_DELAY_MS / 1000}s before retry...`);
            await new Promise((r) => setTimeout(r, CONSUME_RETRY_DELAY_MS));
            await sync();
          }
        }
      }
      if (!consumed) {
        log(`Giving up on note ${noteId} after ${CONSUME_MAX_RETRIES} attempts`);
      }
    }
  }, [gameAccountAddress, pendingNotes, consume, sync, refetchGame, refetchNotes]);

  // Log storage state changes
  useEffect(() => {
    if (stage !== "waiting" || !gameAccount) return;

    const config = gameAccount.storage().getItem(SLOT_GAME_CONFIG);
    if (!config) {
      log("Storage check: SLOT_GAME_CONFIG not found");
      return;
    }

    const values = config.toU64s();
    const phase = Number(values[2]);
    log(`Storage SLOT_GAME_CONFIG: [${Array.from(values, (v) => v.toString()).join(", ")}], phase=${phase}`);

    if (phase >= PHASE_ACTIVE) {
      log("=== GAME IS ACTIVE ===");
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setStage("ready");
    }
  }, [stage, gameAccount]);

  return {
    joinGame,
    consumeNotes,
    consumableNoteCount: pendingNotes.length,
    isConsuming,
    stage,
    error,
    gameAccountAddress,
    starterAddress,
    walletConnected: connected,
  };
}
