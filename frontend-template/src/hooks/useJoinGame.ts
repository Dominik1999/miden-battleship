import { useState, useCallback, useEffect, useRef } from "react";
import { AccountId } from "@miden-sdk/miden-sdk";
import { AUTO_SYNC_INTERVAL_MS } from "@/config";
import {
  classifyNote,
  createAndFundGameAccount,
  createAndFundWallet,
  hasSentNote,
  pendingNotesFor,
  publishHandshake,
  runSetup,
  sync,
} from "@/lib/game";
import { randomValues } from "@/lib/notes";
import { stringsToValues, valuesToStrings, type GameSession } from "@/lib/session";
import { readGameState } from "@/lib/state";
import { useGameContext } from "@/hooks/useGameContext";
import type { SessionActions } from "@/hooks/useGameSession";
import { PHASE_ACTIVE, PHASE_CREATED, type ShipCell } from "@/types/game";

export type JoinStage = "idle" | "preparing" | "setting-up" | "challenging" | "waiting" | "ready" | "error";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[JoinGame] ${msg}`, "color: #f0a; font-weight: bold", ...args);

/**
 * Joiner flow: create + fund a private game account and a wallet, set up the board (fresh game
 * id, the starter as opponent), send the challenge note and wait for the accept note. In
 * contract terms the joiner is the challenger: its first move consumes the accept note (which
 * verifies the starter's seed and roots on-chain) and fires turn 1 — see useGameplaySync.
 */
export function useJoinGame(sessionActions: SessionActions) {
  const [stage, setStage] = useState<JoinStage>("idle");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [gameAccountAddress, setGameAccountAddress] = useState<string | null>(null);
  const [starterAddress, setStarterAddress] = useState<string | null>(null);

  const { runExclusive, context } = useGameContext();
  const sessionRef = useRef(sessionActions);
  sessionRef.current = sessionActions;
  const busyRef = useRef(false);

  const fail = useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed: ${msg}`);
    setError(msg);
    setStage("error");
  }, []);

  const joinGame = useCallback(
    async (starterAddr: string, cells: ShipCell[], stakeAmount: bigint): Promise<string | null> => {
      setError(null);
      setStarterAddress(starterAddr);
      setStage("preparing");
      try {
        const ctx = context(setStatus);
        const { address, seed } = await runExclusive(() => createAndFundGameAccount(ctx));
        const wallet = await runExclusive(() => createAndFundWallet(ctx));
        const gameId = randomValues();
        const session: GameSession = {
          version: 1,
          role: "challenger",
          myAddress: address,
          mySeed: valuesToStrings(seed),
          myWallet: wallet,
          opponentAddress: starterAddr,
          gameId: valuesToStrings(gameId),
          cells,
          stakeAmount: stakeAmount.toString(),
          shots: [],
          pendingDeadline: null,
          myStakeNoteId: null,
          claimed: false,
          createdAt: Date.now(),
        };
        sessionRef.current.start(session);
        setGameAccountAddress(address);
        setStage("setting-up");
        await runExclusive(async () => {
          setStatus("Storing your board on-chain...");
          await runSetup(ctx, address, gameId, AccountId.fromBech32(starterAddr), AccountId.fromBech32(wallet), cells);
        });
        setStage("challenging");
        await runExclusive(async () => {
          setStatus("Sending the challenge...");
          await publishHandshake(ctx, "challenge", address, starterAddr, { gameId, seed, wallet });
        });
        setStatus("Waiting for the opponent to accept...");
        setStage("waiting");
        return address;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [runExclusive, context, fail],
  );

  /** Continues a persisted joiner session: redoes setup/challenge if they never landed, then waits. */
  const resume = useCallback(
    async (session: GameSession) => {
      setError(null);
      setGameAccountAddress(session.myAddress);
      setStarterAddress(session.opponentAddress);
      setStage("waiting");
      try {
        const ctx = context(setStatus);
        const gameId = session.gameId ? stringsToValues(session.gameId) : null;
        const starter = session.opponentAddress;
        if (!gameId || !starter) throw new Error("The session has no opponent");
        await runExclusive(async () => {
          await sync(ctx);
          const account = await ctx.client.getAccount(AccountId.fromBech32(session.myAddress));
          const phase = account ? (readGameState(account.storage())?.phase ?? PHASE_CREATED) : PHASE_CREATED;
          if (phase === PHASE_CREATED) {
            setStatus("Storing your board on-chain...");
            await runSetup(ctx, session.myAddress, gameId, AccountId.fromBech32(starter), AccountId.fromBech32(session.myWallet), session.cells);
          }
          if (phase < PHASE_ACTIVE && !(await hasSentNote(ctx, "challenge", starter, gameId))) {
            setStatus("Sending the challenge...");
            await publishHandshake(ctx, "challenge", session.myAddress, starter, { gameId, seed: stringsToValues(session.mySeed), wallet: session.myWallet });
          }
        });
        setStatus("Waiting for the opponent to accept...");
      } catch (err) {
        fail(err);
      }
    },
    [runExclusive, context, fail],
  );

  // Poll until the accept note is visible (or the game is already ACTIVE after a resume): the
  // first move consumes the acceptance, so the game screen takes over from here.
  useEffect(() => {
    if (stage !== "waiting" || !gameAccountAddress) return;
    const address = gameAccountAddress;
    let stopped = false;

    const tick = async () => {
      if (busyRef.current || stopped) return;
      busyRef.current = true;
      try {
        const ctx = context(setStatus);
        const ready = await runExclusive(async () => {
          await sync(ctx);
          const account = await ctx.client.getAccount(AccountId.fromBech32(address));
          const phase = account ? readGameState(account.storage())?.phase : undefined;
          if (phase !== undefined && phase >= PHASE_ACTIVE) return true;
          const feeFaucet = await ctx.client.feeFaucetId();
          for (const record of await pendingNotesFor(ctx, address)) {
            if ((await classifyNote(ctx, record, feeFaucet)).kind === "accept") return true;
          }
          return false;
        });
        if (!ready) return;
        setStatus("Opponent accepted! Fire the first shot.");
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

  return { joinGame, resume, stage, status, error, gameAccountAddress, starterAddress };
}
