import { useState, useCallback, useEffect, useRef } from "react";
import { AccountId, Address, NetworkId, type InputNoteRecord } from "@miden-sdk/miden-sdk";
import { AUTO_SYNC_INTERVAL_MS } from "@/config";
import {
  classifyNote,
  consumeNote,
  createAndFundGameAccount,
  handshakeStorageFor,
  hasSentNote,
  parseHandshakeStorage,
  pendingNotesFor,
  publishGameNote,
  randomValues,
  readGameIdentity,
  runSetup,
  type FeltValues,
  sync,
} from "@/lib/game";
import { useGameContext } from "@/hooks/useGameContext";
import { readGameState } from "@/hooks/useGameState";
import { PHASE_ACTIVE, PHASE_CREATED, type ShipCell } from "@/types/game";

export type StartStage =
  | "idle"
  | "preparing"
  | "waiting-for-opponent"
  | "completing"
  | "ready"
  | "error";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[StartGame] ${msg}`, "color: #fa0; font-weight: bold", ...args);

/**
 * Starter flow: create + fund a game account, share its address, wait for a challenge note,
 * then set up the board (with the challenger's game id), accept the challenge and send the
 * accept note. In contract terms the starter is the acceptor: the joiner fires first.
 */
export function useStartGame() {
  const [stage, setStage] = useState<StartStage>("idle");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [gameAccountAddress, setGameAccountAddress] = useState<string | null>(null);
  const [opponentAddress, setOpponentAddress] = useState<string | null>(null);
  const [commitment, setCommitment] = useState<FeltValues | null>(null);

  const { runExclusive, context } = useGameContext();
  const boardRef = useRef<{ cells: ShipCell[]; commitment: FeltValues } | null>(null);
  const busyRef = useRef(false);

  const fail = useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed: ${msg}`);
    setError(msg);
    setStage("error");
  }, []);

  const startGame = useCallback(
    async (cells: ShipCell[]): Promise<string | null> => {
      setError(null);
      setStage("preparing");
      try {
        const address = await runExclusive(() => createAndFundGameAccount(context(setStatus)));
        const commit = randomValues();
        boardRef.current = { cells, commitment: commit };
        setCommitment(commit);
        setGameAccountAddress(address);
        setStatus("Share your game account address with your opponent.");
        setStage("waiting-for-opponent");
        return address;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [runExclusive, context, fail],
  );

  // Poll until the handshake is complete. Every step is derived from on-chain state so the
  // flow survives interruptions: CHALLENGED/CREATED → wait for the challenge note, set up the
  // board and accept it; ACTIVE → send the accept note unless it was already sent.
  useEffect(() => {
    if ((stage !== "waiting-for-opponent" && stage !== "completing") || !gameAccountAddress) return;
    const address = gameAccountAddress;
    let stopped = false;

    const tick = async () => {
      if (busyRef.current || stopped) return;
      busyRef.current = true;
      try {
        const ctx = context(setStatus);
        const me = AccountId.fromBech32(address);
        const done = await runExclusive(async () => {
          await sync(ctx);
          const account = await ctx.client.getAccount(me);
          if (!account) throw new Error("Game account not found in the local store");
          let phase = readGameState(account.storage())?.phase ?? PHASE_CREATED;

          if (phase < PHASE_ACTIVE) {
            const feeFaucet = await ctx.client.feeFaucetId();
            let challenge: InputNoteRecord | null = null;
            for (const record of await pendingNotesFor(ctx, address)) {
              const classified = await classifyNote(ctx, record, feeFaucet);
              if (classified.kind === "challenge") {
                challenge = record;
                break;
              }
            }
            if (!challenge) return false;
            setStage("completing");
            const board = boardRef.current;
            if (!board) throw new Error("Board placement was lost");
            const note = challenge.toNote();
            const { gameId, sender, commitment: theirCommitment } = parseHandshakeStorage(note);
            log(`Challenge from ${sender.toString()}, game id [${gameId.join(", ")}], commitment [${theirCommitment.join(", ")}]`);
            if (phase === PHASE_CREATED) {
              setStatus("Storing your board on-chain...");
              await runSetup(ctx, address, gameId, sender, board.commitment, board.cells);
            }
            setStatus("Accepting the challenge...");
            await consumeNote(ctx, address, note);
            phase = PHASE_ACTIVE;
          }

          const identity = readGameIdentity((await ctx.client.getAccount(me)) ?? account);
          if (!identity) throw new Error("Game account has no opponent after the handshake");
          const opponent = Address.fromAccountId(identity.opponent).toBech32(NetworkId.testnet());
          const board = boardRef.current;
          if (!board) throw new Error("Board placement was lost");
          if (!(await hasSentNote(ctx, "accept", opponent, identity.gameId))) {
            setStage("completing");
            setStatus("Sending the accept note...");
            await publishGameNote(ctx, "accept", address, opponent, handshakeStorageFor(identity.gameId, me, board.commitment));
          }
          return opponent;
        });
        if (!done) return;
        setOpponentAddress(done);
        setStatus("Game ready!");
        setStage("ready");
      } catch (err) {
        fail(err);
      } finally {
        busyRef.current = false;
      }
    };

    void tick();
    const interval = setInterval(() => void tick(), AUTO_SYNC_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [stage, gameAccountAddress, runExclusive, context, fail]);

  return { startGame, stage, status, error, gameAccountAddress, opponentAddress, commitment };
}
