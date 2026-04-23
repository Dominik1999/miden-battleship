import { useState, useCallback, useEffect, useRef } from "react";
import {
  useAccount,
  useConsume,
  useImportAccount,
  useMiden,
  useMidenClient,
  useNotes,
  useSyncState,
  useTransaction,
} from "@miden-sdk/react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter";
import { AccountId, Address, Felt, NetworkId, NoteTag } from "@miden-sdk/miden-sdk";
import { randomWord } from "@/lib/miden";
import {
  loadPackage,
  createGameAccount,
  buildSetupInputs,
  buildHandshakeInputs,
  submitNote,
} from "@/lib/notes";
import {
  SLOT_OPPONENT,
  AUTO_SYNC_INTERVAL_MS,
  NETWORK_SYNC_DELAY_MS,
  CONSUME_MAX_RETRIES,
  CONSUME_RETRY_DELAY_MS,
} from "@/config";
import type { ShipCell } from "@/types/game";

export type StartStage =
  | "idle"
  | "loading"
  | "creating-account"
  | "waiting-for-opponent"
  | "completing"
  | "syncing"
  | "ready"
  | "error";

const log = (msg: string, ...args: unknown[]) =>
  console.log(
    `%c[StartGame] ${msg}`,
    "color: #fa0; font-weight: bold",
    ...args,
  );

/** Reconstruct AccountId hex from prefix + suffix u64 values.
 *  AccountId is 15 bytes: 8-byte prefix + 7-byte suffix (last byte always 0x00).
 *  Hex format: "0x" + 16 prefix chars + 14 suffix chars = 32 chars total. */
function accountIdHexFromU64s(prefix: bigint, suffix: bigint): string {
  const hex =
    "0x" +
    prefix.toString(16).padStart(16, "0") +
    suffix.toString(16).padStart(16, "0");
  return hex.slice(0, 32);
}

export function useStartGame() {
  const [stage, setStage] = useState<StartStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [gameAccountAddress, setGameAccountAddress] = useState<string | null>(
    null,
  );
  const [opponentAddress, setOpponentAddress] = useState<string | null>(null);

  const {
    address: walletAddress,
    connected,
  } = useMidenFiWallet();
  const client = useMidenClient();
  const { runExclusive } = useMiden();
  const { sync } = useSyncState();
  const { importAccount } = useImportAccount();
  const { execute } = useTransaction();
  const { consume, isLoading: isConsuming } = useConsume();

  // Track game account to poll for opponent
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

  // Guard against concurrent consumeNotes calls (double-click prevention)
  const consumingRef = useRef(false);

  // Store ship cells and packages for deferred handshake
  const deferredRef = useRef<{
    cells: ShipCell[];
    commitment: Felt[];
    setupPkg: Awaited<ReturnType<typeof loadPackage>>;
    acceptPkg: Awaited<ReturnType<typeof loadPackage>>;
  } | null>(null);

  /**
   * Step 1: Player places ships, then calls startGame.
   * Creates game account, loads packages, returns game address.
   */
  const startGame = useCallback(
    async (cells: ShipCell[]): Promise<string | null> => {
      if (!walletAddress) {
        setError("Wallet not connected");
        setStage("error");
        return null;
      }
      setError(null);

      try {
        // Load packages
        setStage("loading");
        log("Loading .masp packages...");
        const [battleshipPkg, setupPkg, , acceptPkg] = await Promise.all([
          loadPackage("battleship_account.masp"),
          loadPackage("setup_note.masp"),
          loadPackage("challenge_note.masp"),
          loadPackage("accept_note.masp"),
        ]);

        // Snapshot existing note IDs so we only consume new ones later
        preGameNoteIds.current = new Set(
          (allNotes ?? []).map((n) => n.id().toString()),
        );
        log(`Snapshotted ${preGameNoteIds.current.size} pre-existing note IDs`);

        // Create game account with battleship component via WebClient
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

        // Register the tag so the client discovers notes targeted at this account during sync
        const gameAccountId = AccountId.fromBech32(accountAddress);
        const gameTag = NoteTag.withAccountTarget(gameAccountId);
        log(`Registering tag ${gameTag.asU32()} for game account...`);
        await runExclusive(() => client.addTag(gameTag.asU32().toString()));

        // Prepare deferred data (game_id will come from the joiner's challenge note)
        const commitment = randomWord();
        const commitFelts = commitment.toFelts();

        deferredRef.current = {
          cells,
          commitment: commitFelts,
          setupPkg,
          acceptPkg,
        };

        setGameAccountAddress(accountAddress);
        setStage("waiting-for-opponent");
        log("=== WAITING FOR OPPONENT ===");
        log(`Game account: ${accountAddress}`);
        log(`Wallet: ${walletAddress}`);
        log(`Share the game account address with your opponent.`);

        return accountAddress;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Start failed: ${msg}`);
        setStage("error");
        setError(msg);
        return null;
      }
    },
    [walletAddress, client, importAccount],
  );

  // Poll for opponent joining
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);

  useEffect(() => {
    if (stage !== "waiting-for-opponent" || !gameAccountAddress) return;

    pollCountRef.current = 0;
    log(`Starting poll loop (every ${AUTO_SYNC_INTERVAL_MS / 1000}s) for game account: ${gameAccountAddress}`);

    pollRef.current = setInterval(async () => {
      pollCountRef.current++;
      const tick = pollCountRef.current;
      try {
        log(`[poll #${tick}] Syncing from network...`);
        await sync();
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
    if (stage !== "waiting-for-opponent") return;
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

  // Get NEW non-consumed, authenticated notes (exclude pre-game notes)
  const pendingNotes = (allNotes ?? []).filter(
    (n) =>
      !n.isConsumed() &&
      !n.isProcessing() &&
      n.isAuthenticated() &&
      !preGameNoteIds.current.has(n.id().toString()) &&
      !consumedNoteIds.current.has(n.id().toString()),
  );

  // Starter's consume flow (two separate transactions for phase transitions):
  // 1. Read challenge note inputs to get joiner's address
  // 2. Submit own setup note (places ships via wallet)
  // 3. Consume ONLY the setup note (CREATED → CHALLENGED)
  // 4. Consume ONLY the challenge note (CHALLENGED → ACTIVE)
  // 5. Send accept note to joiner
  const consumeNotes = useCallback(async () => {
    if (consumingRef.current) {
      log("consumeNotes already in progress — skipping duplicate call");
      return;
    }
    if (
      !gameAccountAddress ||
      !walletAddress ||
      !execute ||
      !deferredRef.current ||
      pendingNotes.length === 0
    ) {
      log("consumeNotes called but not ready");
      return;
    }
    consumingRef.current = true;

    // Switch stage to prevent opponent detection effect from firing during consume
    setStage("completing");

    // Stop polling while consuming to prevent interference
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      log("Stopped poll loop for consume flow.");
    }

    try {
      // Ensure wallet account is tracked in the app's Miden client
      log("Importing wallet account into app client...");
      try {
        await importAccount({ type: "id", accountId: walletAddress });
        log("Wallet account imported.");
      } catch (e) {
        log(`Wallet import note: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Step 1: Extract joiner info AND game_id from the challenge note
      // Challenge note inputs: [0..3]=game_id, [4]=joiner_prefix, [5]=joiner_suffix, [6..9]=commitment
      const challengeNote = pendingNotes[0];
      const challengeNoteId = challengeNote.id().toString();
      const noteInputs = challengeNote.details().recipient().storage().items();
      const challengeGameId = [noteInputs[0], noteInputs[1], noteInputs[2], noteInputs[3]];
      const joinerPrefix = noteInputs[4];
      const joinerSuffix = noteInputs[5];
      log(`Challenge note (${challengeNoteId}) gameId=[${challengeGameId.map(String)}], joiner prefix=${joinerPrefix}, suffix=${joinerSuffix}`);

      const { cells, commitment, setupPkg, acceptPkg } = deferredRef.current;
      const walletId = AccountId.fromBech32(walletAddress);
      const gameAccountId = AccountId.fromBech32(gameAccountAddress);

      // Step 2: Submit our own setup note using the JOINER's game_id (must match for accept_challenge)
      log("Submitting starter setup note → own game account...");
      const setupNoteId = await submitNote(
        setupPkg,
        buildSetupInputs(challengeGameId, joinerPrefix, joinerSuffix, commitment, cells),
        gameAccountId,
        gameAccountAddress,
        1,
        walletAddress,
        walletId,
        execute,
      );
      log(`Setup note ID: ${setupNoteId}`);

      // Step 3: Wait for setup note to appear on-chain, then consume it ALONE
      // Retry loop: sync + consume, because the note may not be on-chain yet
      log(`=== CONSUMING SETUP NOTE (CREATED → CHALLENGED) ===`);
      log(`  Setup note: ${setupNoteId}`);
      for (let attempt = 1; attempt <= CONSUME_MAX_RETRIES; attempt++) {
        const delay = attempt === 1 ? NETWORK_SYNC_DELAY_MS : CONSUME_RETRY_DELAY_MS;
        log(`[attempt ${attempt}/${CONSUME_MAX_RETRIES}] Waiting ${delay / 1000}s then syncing...`);
        await new Promise((r) => setTimeout(r, delay));
        await sync();
        try {
          const setupResult = await consume({ accountId: gameAccountAddress, notes: [setupNoteId] });
          log(`Setup consume succeeded! TX: ${JSON.stringify(setupResult)}`);
          consumedNoteIds.current.add(setupNoteId);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[attempt ${attempt}/${CONSUME_MAX_RETRIES}] Setup consume failed: ${msg}`);
          if (attempt === CONSUME_MAX_RETRIES) throw err;
        }
      }

      // Step 4: Wait for setup consume to propagate, then consume the challenge note ALONE
      log(`=== CONSUMING CHALLENGE NOTE (CHALLENGED → ACTIVE) ===`);
      log(`  Challenge note: ${challengeNoteId}`);
      for (let attempt = 1; attempt <= CONSUME_MAX_RETRIES; attempt++) {
        const delay = attempt === 1 ? NETWORK_SYNC_DELAY_MS : CONSUME_RETRY_DELAY_MS;
        log(`[attempt ${attempt}/${CONSUME_MAX_RETRIES}] Waiting ${delay / 1000}s then syncing...`);
        await new Promise((r) => setTimeout(r, delay));
        await sync();
        try {
          const challengeResult = await consume({ accountId: gameAccountAddress, notes: [challengeNoteId] });
          log(`Challenge consume succeeded! TX: ${JSON.stringify(challengeResult)}`);
          consumedNoteIds.current.add(challengeNoteId);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[attempt ${attempt}/${CONSUME_MAX_RETRIES}] Challenge consume failed: ${msg}`);
          if (attempt === CONSUME_MAX_RETRIES) throw err;
        }
      }

      // Step 5: Send accept note to joiner
      log("Submitting accept note → joiner account...");
      const joinerHex = accountIdHexFromU64s(joinerPrefix.asInt(), joinerSuffix.asInt());
      const joinerId = AccountId.fromHex(joinerHex);
      const joinerAddr = Address.fromAccountId(joinerId).toBech32(NetworkId.testnet());
      await submitNote(
        acceptPkg,
        buildHandshakeInputs(challengeGameId, gameAccountId.prefix(), gameAccountId.suffix(), commitment),
        joinerId,
        joinerAddr,
        4,
        walletAddress,
        walletId,
        execute,
      );

      log("=== GAME READY ===");
      setOpponentAddress(joinerAddr);
      setStage("ready");
      refetchGame();
      refetchNotes();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Consume FAILED: ${msg}`);
      setError(msg);
    } finally {
      consumingRef.current = false;
    }
  }, [
    gameAccountAddress,
    walletAddress,
    execute,
    pendingNotes,
    consume,
    sync,
    refetchGame,
    refetchNotes,
  ]);

  // Detect opponent from game account storage
  useEffect(() => {
    if (stage !== "waiting-for-opponent" || !gameAccount) return;

    const opponent = gameAccount.storage().getItem(SLOT_OPPONENT);
    if (!opponent) {
      log("Storage check: SLOT_OPPONENT not found");
      return;
    }

    const values = opponent.toU64s();
    log(`Storage SLOT_OPPONENT: [${Array.from(values, (v) => v.toString()).join(", ")}]`);

    // opponent slot: [prefix, suffix, hits, shots]
    // If prefix is non-zero, an opponent has connected
    if (values[0] === 0n) {
      log("Opponent slot prefix is 0 — no opponent yet.");
      return;
    }

    log("=== OPPONENT DETECTED IN STORAGE ===");
    // Don't auto-trigger handshake — consumeNotes handles the full flow.
    // Just log and stop polling.
  }, [stage, gameAccount]);

  return {
    startGame,
    consumeNotes,
    consumableNoteCount: pendingNotes.length,
    isConsuming,
    stage,
    error,
    gameAccountAddress,
    opponentAddress,
    walletConnected: connected,
  };
}
