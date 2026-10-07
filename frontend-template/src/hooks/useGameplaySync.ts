import { useEffect, useRef, useState } from "react";
import { useAccount } from "@miden-sdk/react";
import { AUTO_SYNC_INTERVAL_MS, FAUCET_CLAIM_COOLDOWN_MS, FEE_TOP_UP_THRESHOLD, MIDEN_FAUCET_URL, FAUCET_CLAIM_AMOUNT } from "@/config";
import {
  classifyNote,
  consumeNote,
  consumeShot,
  feeBalance,
  parseResultStorage,
  pendingNotesFor,
  publishGameNote,
  revealStorageFor,
  runTxScript,
  type FeltValues,
  type GameContext,
  type ResultData,
  type ShotOutcome,
  sync,
} from "@/lib/game";
import { claimFaucetTokens, shouldTopUp } from "@/lib/funding";
import { useGameContext } from "@/hooks/useGameContext";
import { PHASE_ACTIVE, PHASE_REVEAL, type GameState } from "@/types/game";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[GameplaySync] ${msg}`, "color: #0af; font-weight: bold", ...args);

export interface GameplaySyncOptions {
  /** Current state of my game account (phase, counters, reveal flags). */
  myState: GameState | null;
  /** The opponent's game account address. */
  opponentAddress: string;
  /** My board commitment (sent in the reveal note once the game is decided). */
  commitment: FeltValues | null;
}

export interface GameplaySyncState {
  /** Result notes received so far (my shots, resolved by the opponent). */
  results: ResultData[];
  /** Shots the opponent fired at me, as resolved on my account. */
  incomingShots: ShotOutcome[];
  /** Set when a result note says my shot sank the last ship: I won. */
  opponentGameOver: boolean;
  /** Fee-asset balance of my game account, when known. */
  feeBalance: bigint | null;
  /** My reveal note has been published and marked. */
  revealed: boolean;
  lastError: string | null;
}

/**
 * Gameplay loop on the player's own game account: syncs, resolves incoming shot notes (which
 * creates the result note for the shooter), reads result notes, tops up fees from the faucet
 * and, once the game is decided, runs the reveal protocol. One note per tick keeps proving
 * time bounded. Every WASM access runs inside `runExclusive`.
 */
export function useGameplaySync(myAddress: string, enabled: boolean, options: GameplaySyncOptions): GameplaySyncState {
  const { runExclusive, context } = useGameContext();
  const { refetch: refetchAccount } = useAccount(myAddress || undefined);
  const [state, setState] = useState<GameplaySyncState>({
    results: [],
    incomingShots: [],
    opponentGameOver: false,
    feeBalance: null,
    revealed: false,
    lastError: null,
  });

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef(state);
  stateRef.current = state;
  const refetchRef = useRef(refetchAccount);
  refetchRef.current = refetchAccount;
  const busyRef = useRef(false);
  const handledRef = useRef(new Set<string>());
  const fundingRef = useRef<{ lastClaimAt: number | null; pendingClaim: boolean }>({ lastClaimAt: null, pendingClaim: false });
  const revealRef = useRef<{ entered: boolean; revealed: boolean }>({ entered: false, revealed: false });

  useEffect(() => {
    if (!enabled || !myAddress) return;
    let cancelled = false;

    const tick = async () => {
      if (busyRef.current || cancelled) return;
      busyRef.current = true;
      const ctx: GameContext = context();
      try {
        const changed = await runExclusive(() => step(ctx, myAddress));
        if (changed) await refetchRef.current();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Tick error: ${msg}`);
        setState((s) => ({ ...s, lastError: msg }));
      } finally {
        busyRef.current = false;
      }
    };

    /** One sync step; returns true when the account state may have changed. */
    const step = async (ctx: GameContext, address: string): Promise<boolean> => {
      await sync(ctx);
      const feeFaucet = await ctx.client.feeFaucetId();
      const changed = false;

      // 1. Fees: read the balance and claim more when low.
      const balance = await feeBalance(ctx, address);
      setState((s) => (s.feeBalance === balance ? s : { ...s, feeBalance: balance }));
      const funding = fundingRef.current;
      if (shouldTopUp({ balance, threshold: FEE_TOP_UP_THRESHOLD, pendingClaim: funding.pendingClaim, lastClaimAt: funding.lastClaimAt, now: Date.now(), cooldownMs: FAUCET_CLAIM_COOLDOWN_MS })) {
        log(`Fee balance ${balance} below ${FEE_TOP_UP_THRESHOLD}, claiming from the faucet`);
        funding.pendingClaim = true;
        funding.lastClaimAt = Date.now();
        try {
          await claimFaucetTokens(MIDEN_FAUCET_URL, address, FAUCET_CLAIM_AMOUNT);
        } catch (err) {
          funding.pendingClaim = false;
          log(`Faucet claim failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 2. Incoming notes: one transaction per tick.
      for (const record of await pendingNotesFor(ctx, address)) {
        const id = record.id()?.toString();
        if (!id || handledRef.current.has(id)) continue;
        const classified = await classifyNote(ctx, record, feeFaucet);
        const note = record.toNote();
        switch (classified.kind) {
          case "shot": {
            handledRef.current.add(id);
            const outcome = await consumeShot(ctx, address, record);
            setState((s) => ({ ...s, incomingShots: [...s.incomingShots, outcome] }));
            return true;
          }
          case "result": {
            handledRef.current.add(id);
            const result = parseResultStorage(note);
            log(`Result for turn ${result.turn}: ${result.isHit ? "HIT" : "MISS"}${result.isGameOver ? " — all enemy ships sunk!" : ""}`);
            setState((s) => ({
              ...s,
              results: s.results.some((r) => r.turn === result.turn) ? s.results : [...s.results, result],
              opponentGameOver: s.opponentGameOver || result.isGameOver,
            }));
            // result notes are data carriers; consuming them would only cost a fee
            continue;
          }
          case "funding": {
            handledRef.current.add(id);
            await consumeNote(ctx, address, note);
            fundingRef.current.pendingClaim = false;
            log("Funding note consumed");
            return true;
          }
          case "reveal": {
            if (optionsRef.current.myState?.phase !== PHASE_REVEAL) continue; // verify only in the REVEAL phase
            handledRef.current.add(id);
            await consumeNote(ctx, address, note);
            log("Opponent's reveal verified");
            return true;
          }
          default:
            handledRef.current.add(id);
            log(`Ignoring ${classified.kind} note ${id}`);
            continue;
        }
      }

      // 3. Reveal protocol once the game is decided.
      const { myState, opponentAddress, commitment } = optionsRef.current;
      const reveal = revealRef.current;
      if (myState && commitment) {
        if (myState.phase === PHASE_ACTIVE && stateRef.current.opponentGameOver && !reveal.entered) {
          reveal.entered = true;
          log("We won: entering the reveal phase");
          await runTxScript(ctx, address, "enterReveal");
          return true;
        }
        if (myState.phase === PHASE_REVEAL && !myState.myRevealed && !reveal.revealed) {
          reveal.revealed = true;
          log("Publishing our reveal note");
          await publishGameNote(ctx, "reveal", address, opponentAddress, revealStorageFor(commitment));
          await runTxScript(ctx, address, "markMyReveal");
          setState((s) => ({ ...s, revealed: true }));
          return true;
        }
      }
      return changed;
    };

    log(`Starting gameplay sync (every ${AUTO_SYNC_INTERVAL_MS / 1000}s)`);
    void tick();
    const interval = setInterval(() => void tick(), AUTO_SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      log("Stopped gameplay sync.");
    };
  }, [enabled, myAddress, runExclusive, context]);

  return state;
}
