import { useState, useCallback, useEffect, useRef } from "react";
import { AccountId } from "@miden-sdk/miden-sdk";
import { AUTO_SYNC_INTERVAL_MS } from "@/config";
import {
  classifyNote,
  consumeNote,
  createAndFundGameAccount,
  handshakeStorageFor,
  pendingNotesFor,
  publishGameNote,
  randomValues,
  runSetup,
  type FeltValues,
  sync,
} from "@/lib/game";
import { useGameContext } from "@/hooks/useGameContext";
import { readGameState } from "@/hooks/useGameState";
import { PHASE_ACTIVE, type ShipCell } from "@/types/game";

export type JoinStage =
  | "idle"
  | "preparing"
  | "setting-up"
  | "challenging"
  | "waiting"
  | "accepting"
  | "ready"
  | "error";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[JoinGame] ${msg}`, "color: #f0a; font-weight: bold", ...args);

/**
 * Joiner flow: create + fund a game account, set up the board (fresh game id, the starter as
 * opponent), send the challenge note, wait for the accept note and consume it. In contract
 * terms the joiner is the challenger and fires first.
 */
export function useJoinGame() {
  const [stage, setStage] = useState<JoinStage>("idle");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [gameAccountAddress, setGameAccountAddress] = useState<string | null>(null);
  const [starterAddress, setStarterAddress] = useState<string | null>(null);
  const [commitment, setCommitment] = useState<FeltValues | null>(null);

  const { runExclusive, context } = useGameContext();
  const busyRef = useRef(false);

  const fail = useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed: ${msg}`);
    setError(msg);
    setStage("error");
  }, []);

  const joinGame = useCallback(
    async (starterAddr: string, cells: ShipCell[]): Promise<string | null> => {
      setError(null);
      setStarterAddress(starterAddr);
      setStage("preparing");
      try {
        const ctx = context(setStatus);
        const address = await runExclusive(() => createAndFundGameAccount(ctx));
        setGameAccountAddress(address);
        const gameId = randomValues();
        const commit = randomValues();
        setCommitment(commit);
        const me = AccountId.fromBech32(address);
        const starter = AccountId.fromBech32(starterAddr);

        setStage("setting-up");
        await runExclusive(async () => {
          setStatus("Storing your board on-chain...");
          await runSetup(ctx, address, gameId, starter, commit, cells);
        });
        setStage("challenging");
        await runExclusive(async () => {
          setStatus("Sending the challenge...");
          await publishGameNote(ctx, "challenge", address, starterAddr, handshakeStorageFor(gameId, me, commit));
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

  // Poll until the game is ACTIVE on-chain: consume the accept note when it arrives. Moving to
  // "accepting" stops the interval (this effect re-runs), but the in-flight consume carries on.
  useEffect(() => {
    if ((stage !== "waiting" && stage !== "accepting") || !gameAccountAddress) return;
    const address = gameAccountAddress;
    let stopped = false;

    const tick = async () => {
      if (busyRef.current || stopped) return;
      busyRef.current = true;
      try {
        const ctx = context(setStatus);
        const found = await runExclusive(async () => {
          await sync(ctx);
          const account = await ctx.client.getAccount(AccountId.fromBech32(address));
          const phase = account ? readGameState(account.storage())?.phase : undefined;
          if (phase !== undefined && phase >= PHASE_ACTIVE) return "active" as const;
          const feeFaucet = await ctx.client.feeFaucetId();
          for (const record of await pendingNotesFor(ctx, address)) {
            const classified = await classifyNote(ctx, record, feeFaucet);
            if (classified.kind === "accept") return record;
          }
          return null;
        });
        if (!found) return;
        if (found !== "active") {
          setStage("accepting");
          await runExclusive(async () => {
            setStatus("Opponent accepted! Activating the game...");
            await consumeNote(ctx, address, found.toNote());
          });
        }
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

  return { joinGame, stage, status, error, gameAccountAddress, starterAddress, commitment };
}
