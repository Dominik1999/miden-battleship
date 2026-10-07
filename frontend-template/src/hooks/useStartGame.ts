import { useState, useCallback, useEffect, useRef } from "react";
import { AccountId, type InputNoteRecord } from "@miden-sdk/miden-sdk";
import { AUTO_SYNC_INTERVAL_MS } from "@/config";
import {
  classifyNote,
  consumeNotes,
  createAndFundGameAccount,
  createAndFundWallet,
  hasSentNote,
  parseHandshakeStorage,
  pendingNotesFor,
  publishHandshake,
  readGameIdentity,
  runSetup,
  sync,
} from "@/lib/game";
import { addressOf } from "@/lib/notes";
import { stringsToValues, valuesToStrings, type GameSession } from "@/lib/session";
import { readGameState } from "@/lib/state";
import { useGameContext } from "@/hooks/useGameContext";
import type { SessionActions } from "@/hooks/useGameSession";
import { PHASE_ACTIVE, PHASE_CREATED, type ShipCell } from "@/types/game";

export type StartStage = "idle" | "preparing" | "waiting-for-opponent" | "completing" | "ready" | "error";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[StartGame] ${msg}`, "color: #fa0; font-weight: bold", ...args);

/**
 * Starter flow: create + fund a private game account and a wallet, share the game account's
 * address, wait for a challenge note, then set up the board (with the challenger's game id),
 * accept the challenge (which verifies the challenger's seed and roots on-chain) and send the
 * accept note. In contract terms the starter is the acceptor: the joiner fires first.
 *
 * Every step is derived from on-chain state and the persisted session, so `resume()` after a
 * reload continues where the flow stopped.
 */
export function useStartGame(sessionActions: SessionActions) {
  const [stage, setStage] = useState<StartStage>("idle");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [gameAccountAddress, setGameAccountAddress] = useState<string | null>(null);
  const [opponentAddress, setOpponentAddress] = useState<string | null>(null);

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

  const startGame = useCallback(
    async (cells: ShipCell[], stakeAmount: bigint): Promise<string | null> => {
      setError(null);
      setStage("preparing");
      try {
        const ctx = context(setStatus);
        const { address, seed } = await runExclusive(() => createAndFundGameAccount(ctx));
        const wallet = await runExclusive(() => createAndFundWallet(ctx));
        const session: GameSession = {
          version: 1,
          role: "acceptor",
          myAddress: address,
          mySeed: valuesToStrings(seed),
          myWallet: wallet,
          opponentAddress: null,
          gameId: null,
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

  /** Continues a persisted starter session: the polling effect works out the next step. */
  const resume = useCallback((session: GameSession) => {
    setError(null);
    setGameAccountAddress(session.myAddress);
    setOpponentAddress(session.opponentAddress);
    setStatus("Resuming your game...");
    setStage("waiting-for-opponent");
  }, []);

  // Poll until the handshake is complete: CREATED/CHALLENGED → wait for the challenge note, set
  // up the board and accept it; ACTIVE → send the accept note unless it was already sent.
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
          const session = sessionRef.current.session;
          if (!session) throw new Error("No game session");
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
            const note = challenge.toNote();
            const { gameId, sender, wallet } = parseHandshakeStorage(note);
            log(`Challenge from ${sender.toString()}, game id [${gameId.join(", ")}], wallet ${wallet.toString()}`);
            if (phase === PHASE_CREATED) {
              setStatus("Storing your board on-chain...");
              await runSetup(ctx, address, gameId, sender, AccountId.fromBech32(session.myWallet), session.cells);
            }
            setStatus("Accepting the challenge (verifying the opponent's account)...");
            await consumeNotes(ctx, address, [note]);
            phase = PHASE_ACTIVE;
          }

          const identity = readGameIdentity((await ctx.client.getAccount(me)) ?? account);
          if (!identity) throw new Error("Game account has no opponent after the handshake");
          const opponent = addressOf(identity.opponent);
          sessionRef.current.update({ opponentAddress: opponent, gameId: valuesToStrings(identity.gameId) });
          if (!(await hasSentNote(ctx, "accept", opponent, identity.gameId))) {
            setStage("completing");
            setStatus("Sending the accept note...");
            await publishHandshake(ctx, "accept", address, opponent, { gameId: identity.gameId, seed: stringsToValues(session.mySeed), wallet: session.myWallet });
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

  return { startGame, resume, stage, status, error, gameAccountAddress, opponentAddress };
}
