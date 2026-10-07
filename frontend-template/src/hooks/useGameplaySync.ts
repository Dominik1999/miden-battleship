import { useCallback, useEffect, useRef, useState } from "react";
import { AccountId, Felt, type Note, NoteFilter, NoteFilterTypes, Note as SdkNote } from "@miden-sdk/miden-sdk";
import { useAccount } from "@miden-sdk/react";
import { AUTO_SYNC_INTERVAL_MS, FAUCET_CLAIM_AMOUNT, FAUCET_CLAIM_COOLDOWN_MS, FEE_TOP_UP_THRESHOLD, MIDEN_FAUCET_URL, STAKE_EXPIRY_DELTA_SECONDS } from "@/config";
import {
  blockTimestamp,
  classifyNote,
  claimNotes,
  consumeNotes,
  feeBalance,
  myShotNote,
  parseResultStorage,
  parseShotStorage,
  parseStakeNote,
  pendingNotesFor,
  planResolution,
  planShot,
  predictShot,
  publishStake,
  reclaimNote,
  submitMove,
  sync,
  type GameContext,
  type Move,
  type ShotOutcome,
} from "@/lib/game";
import { readGameState } from "@/lib/state";
import { claimFaucetTokens, shouldTopUp } from "@/lib/funding";
import { useGameContext } from "@/hooks/useGameContext";
import type { SessionActions } from "@/hooks/useGameSession";
import { OUTCOME_LOST, OUTCOME_WON, OUTCOME_WON_BY_FORFEIT, PHASE_ACTIVE, PHASE_CHALLENGED, PHASE_COMPLETE, type GameState } from "@/types/game";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[GameplaySync] ${msg}`, "color: #0af; font-weight: bold", ...args);

export type Outcome = "open" | "won" | "lost" | "won-by-forfeit";

export interface StakeView {
  /** My stake in fee-asset base units (0 = no stake). */
  amount: bigint;
  /** My stake note is on-chain. */
  published: boolean;
  /** The opponent's stake note has arrived at my wallet, with its amount. */
  opponentAmount: bigint | null;
  /** The winner's wallet collected the defeat/forfeit note and both stakes. */
  claimed: boolean;
}

export interface GameplayView {
  myState: GameState | null;
  outcome: Outcome;
  /** I can fire now (the opponent's notes are in, the stakes are matched). */
  myTurn: boolean;
  /** A move or claim is being submitted. */
  busy: boolean;
  /** Block timestamp after which the opponent forfeits (while I wait for them). */
  waitingDeadline: number | null;
  /** Timestamp of the latest synced block. */
  blockTime: number | null;
  canClaimForfeit: boolean;
  stake: StakeView;
  /** Shots the opponent fired at me, as resolved on my account. */
  incomingShots: ShotOutcome[];
  feeBalance: bigint | null;
  lastError: string | null;
}

export interface GameplayOptions {
  myAddress: string;
  opponentAddress: string;
  session: SessionActions;
  enabled: boolean;
}

interface PendingNotes {
  accept: Note | null;
  result: Note | null;
  shot: Note | null;
  funding: Note[];
}

const initialView = (amount: bigint): GameplayView => ({
  myState: null,
  outcome: "open",
  myTurn: false,
  busy: false,
  waitingDeadline: null,
  blockTime: null,
  canClaimForfeit: false,
  stake: { amount, published: false, opponentAmount: null, claimed: false },
  incomingShots: [],
  feeBalance: null,
  lastError: null,
});

function outcomeOf(state: GameState | null): Outcome {
  if (!state || state.phase !== PHASE_COMPLETE) return "open";
  if (state.outcome === OUTCOME_WON) return "won";
  if (state.outcome === OUTCOME_LOST) return "lost";
  if (state.outcome === OUTCOME_WON_BY_FORFEIT) return "won-by-forfeit";
  return "open";
}

/**
 * Gameplay loop on the player's own game account. Every tick syncs, reads the pending notes
 * (the opponent's result for my last shot, their shot at me, the acceptance for the
 * challenger's first move), tops up fees, publishes my stake once the handshake is done and
 * drives the protocol:
 *
 * - the opponent's shot would sink my last ship → resolve it at once (I lost; the component
 *   emits the result and the defeat note);
 * - the result of my last shot says game over → process it (I won);
 * - otherwise expose `myTurn`; `fire()` consumes every pending note and fires in ONE transaction;
 * - while waiting, the deadline of my own unanswered note counts down to `claimForfeit()`;
 * - once complete, the winner's wallet claims the defeat/forfeit note with both stakes.
 *
 * One transaction per tick; every WASM access runs inside `runExclusive`.
 */
export function useGameplaySync({ myAddress, opponentAddress, session, enabled }: GameplayOptions) {
  const gameContext = useGameContext();
  const { refetch: refetchAccount } = useAccount(myAddress || undefined);
  const [view, setView] = useState<GameplayView>(() => initialView(BigInt(session.session?.stakeAmount ?? "0")));

  // The provider's lock and client are read through refs so a provider re-render never restarts the loop.
  const contextRef = useRef(gameContext);
  contextRef.current = gameContext;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const refetchRef = useRef(refetchAccount);
  refetchRef.current = refetchAccount;
  const busyRef = useRef(false);
  const handledRef = useRef(new Set<string>());
  const fundingRef = useRef<{ lastClaimAt: number | null; pendingClaim: boolean }>({ lastClaimAt: null, pendingClaim: false });
  const pendingRef = useRef<PendingNotes>({ accept: null, result: null, shot: null, funding: [] });

  const patch = useCallback((p: Partial<GameplayView> | ((v: GameplayView) => Partial<GameplayView>)) => {
    setView((v) => ({ ...v, ...(typeof p === "function" ? p(v) : p) }));
  }, []);

  /** Reads and classifies the notes waiting for my game account. */
  const readPending = useCallback(async (ctx: GameContext): Promise<PendingNotes> => {
    const feeFaucet = await ctx.client.feeFaucetId();
    const pending: PendingNotes = { accept: null, result: null, shot: null, funding: [] };
    for (const record of await pendingNotesFor(ctx, myAddress)) {
      const { kind } = await classifyNote(ctx, record, feeFaucet);
      const note = record.toNote();
      if (kind === "accept") pending.accept = note;
      else if (kind === "result") pending.result = note;
      else if (kind === "shot") pending.shot = note;
      else if (kind === "funding") pending.funding.push(note);
    }
    pendingRef.current = pending;
    return pending;
  }, [myAddress]);

  /** Builds and submits a move from the current pending notes; `fireAt` null = resolve only. */
  const playMove = useCallback(
    async (ctx: GameContext, pending: PendingNotes, fireAt: { row: number; col: number } | null) => {
      const move: Move = { inputs: [], expected: [] };
      let incoming: ShotOutcome | null = null;
      if (pending.accept) move.inputs.push({ note: pending.accept });
      if (pending.result) move.inputs.push({ note: pending.result });
      let deadline: number | null = null;
      if (pending.shot) {
        const plan = await planResolution(ctx, myAddress, pending.shot);
        move.inputs.push({ note: pending.shot, args: plan.args });
        move.expected.push(plan.result);
        if (plan.defeat) move.expected.push(plan.defeat);
        incoming = plan.outcome;
        deadline = plan.deadline;
      }
      let shot: { turn: number; row: number; col: number; deadline: number } | null = null;
      if (fireAt) {
        const plan = await planShot(ctx, myAddress, opponentAddress, fireAt.row, fireAt.col);
        move.fire = plan.args;
        move.expected.push(plan.note);
        shot = { turn: plan.turn, row: fireAt.row, col: fireAt.col, deadline: plan.deadline };
        deadline = plan.deadline;
      }
      log(`Move: ${move.inputs.length} input note(s), ${move.expected.length} expected note(s)${fireAt ? `, firing at (${fireAt.row}, ${fireAt.col})` : ""}`);
      await submitMove(ctx, myAddress, move);
      for (const note of move.inputs) handledRef.current.add(note.note.id().toString());
      sessionRef.current.update((s) => ({
        shots: shot ? [...s.shots, { turn: shot.turn, row: shot.row, col: shot.col, status: "pending" as const }] : s.shots,
        pendingDeadline: fireAt ? deadline : s.pendingDeadline,
      }));
      if (incoming) patch((v) => ({ incomingShots: [...v.incomingShots, incoming] }));
      pendingRef.current = { accept: null, result: null, shot: null, funding: [] };
    },
    [myAddress, opponentAddress, patch],
  );

  /** Stake bookkeeping: publish mine after the handshake, look for the opponent's at my wallet. */
  const syncStakes = useCallback(
    async (ctx: GameContext, state: GameState): Promise<{ opponentAmount: bigint | null; opponentNote: Note | null }> => {
      const s = sessionRef.current.session;
      if (!s) return { opponentAmount: null, opponentNote: null };
      const amount = BigInt(s.stakeAmount);
      if (amount <= 0n) return { opponentAmount: null, opponentNote: null };
      const myGame = AccountId.fromBech32(myAddress);
      if (!s.myStakeNoteId && state.phase >= PHASE_ACTIVE && state.opponentWallet) {
        const [p, q] = state.opponentWallet;
        const oppWallet = AccountId.fromPrefixSuffix(new Felt(p), new Felt(q));
        log(`Publishing my stake of ${amount} base units`);
        const expiry = (await blockTimestamp(ctx)) + STAKE_EXPIRY_DELTA_SECONDS;
        const note = await publishStake(ctx, { myWallet: AccountId.fromBech32(s.myWallet), myGame, oppWallet, oppGame: AccountId.fromBech32(opponentAddress) }, amount, expiry);
        sessionRef.current.update({ myStakeNoteId: note.id().toString() });
        patch((v) => ({ stake: { ...v.stake, published: true } }));
      }
      const feeFaucet = await ctx.client.feeFaucetId();
      for (const record of await pendingNotesFor(ctx, s.myWallet)) {
        if ((await classifyNote(ctx, record, feeFaucet)).kind !== "stake") continue;
        const note = record.toNote();
        const stake = parseStakeNote(note);
        if (stake.oppGame.toString() !== myGame.toString()) continue;
        return { opponentAmount: stake.amount, opponentNote: note };
      }
      return { opponentAmount: null, opponentNote: null };
    },
    [myAddress, opponentAddress, patch],
  );

  /** Rebuilds my own stake note from the output-note store (the note handle is not kept). */
  const myStakeNote = useCallback(async (ctx: GameContext): Promise<Note | null> => {
    const id = sessionRef.current.session?.myStakeNoteId;
    if (!id) return null;
    for (const record of await ctx.client.getOutputNotes(new NoteFilter(NoteFilterTypes.All))) {
      const recipient = record.recipient();
      if (!recipient) continue;
      const note = new SdkNote(record.assets(), record.metadata(), recipient);
      if (note.id().toString() === id) return note;
    }
    return null;
  }, []);

  /** The winner's wallet consumes the defeat/forfeit note together with both stakes. */
  const claimPrize = useCallback(
    async (ctx: GameContext, opponentStake: Note | null) => {
      const s = sessionRef.current.session;
      if (!s || s.claimed) return false;
      const amount = BigInt(s.stakeAmount);
      const feeFaucet = await ctx.client.feeFaucetId();
      let proof: Note | null = null;
      for (const record of await pendingNotesFor(ctx, s.myWallet)) {
        const { kind } = await classifyNote(ctx, record, feeFaucet);
        if (kind === "defeat" || kind === "forfeit") proof = record.toNote();
      }
      if (!proof) return false;
      const notes = [proof];
      if (amount > 0n) {
        const mine = await myStakeNote(ctx);
        if (!mine || !opponentStake) return false;
        notes.push(mine, opponentStake);
      }
      log(`Claiming ${notes.length} note(s) with the wallet`);
      await claimNotes(ctx, s.myWallet, notes);
      sessionRef.current.update({ claimed: true });
      patch((v) => ({ stake: { ...v.stake, claimed: true } }));
      return true;
    },
    [myStakeNote, patch],
  );

  /** One sync step; returns true when the account state may have changed. */
  const step = useCallback(
    async (ctx: GameContext): Promise<boolean> => {
      await sync(ctx);
      const account = await ctx.client.getAccount(AccountId.fromBech32(myAddress));
      const state = account ? readGameState(account.storage()) : null;
      patch({ myState: state });
      if (!state || !account) return false;

      // 1. Fees: read the balance and claim more when low.
      const balance = await feeBalance(ctx, myAddress);
      patch({ feeBalance: balance });
      const funding = fundingRef.current;
      if (shouldTopUp({ balance, threshold: FEE_TOP_UP_THRESHOLD, pendingClaim: funding.pendingClaim, lastClaimAt: funding.lastClaimAt, now: Date.now(), cooldownMs: FAUCET_CLAIM_COOLDOWN_MS })) {
        log(`Fee balance ${balance} below ${FEE_TOP_UP_THRESHOLD}, claiming from the faucet`);
        funding.pendingClaim = true;
        funding.lastClaimAt = Date.now();
        try {
          await claimFaucetTokens(MIDEN_FAUCET_URL, myAddress, FAUCET_CLAIM_AMOUNT);
        } catch (err) {
          funding.pendingClaim = false;
          log(`Faucet claim failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 2. Pending notes.
      const pending = await readPending(ctx);
      if (pending.funding.length > 0) {
        await consumeNotes(ctx, myAddress, pending.funding);
        for (const note of pending.funding) handledRef.current.add(note.id().toString());
        fundingRef.current.pendingClaim = false;
        log("Funding note consumed");
        return true;
      }
      if (pending.result) {
        const result = parseResultStorage(pending.result);
        sessionRef.current.update((s) => ({
          shots: s.shots.map((shot) => (shot.turn === result.turn && shot.status === "pending" ? { ...shot, status: result.isHit ? "hit" : "miss" } : shot)),
        }));
      }

      // 3. Game over: the winner's wallet claims.
      const outcome = outcomeOf(state);
      patch({ outcome });
      if (outcome !== "open") {
        const { opponentAmount, opponentNote } = await syncStakes(ctx, state);
        patch((v) => ({ stake: { ...v.stake, opponentAmount, published: !!sessionRef.current.session?.myStakeNoteId }, myTurn: false, waitingDeadline: null, canClaimForfeit: false }));
        if (outcome !== "lost") await claimPrize(ctx, opponentNote);
        return false;
      }

      // 4. Forced moves: resolve the sinking shot (I lose) or process the final result (I win).
      if (pending.shot) {
        const parsed = parseShotStorage(pending.shot);
        if (predictShot(account, parsed.row, parsed.col).gameOver) {
          log("The opponent's shot sinks our last ship: resolving it");
          await playMove(ctx, pending, null);
          return true;
        }
      }
      if (pending.result && parseResultStorage(pending.result).isGameOver) {
        log("Our last shot sank the enemy fleet: processing the final result");
        await playMove(ctx, { ...pending, shot: null }, null);
        return true;
      }

      // 5. Stakes gate the first shot: both notes must be in and match.
      const { opponentAmount } = await syncStakes(ctx, state);
      const stakeAmount = BigInt(sessionRef.current.session?.stakeAmount ?? "0");
      const stakesReady = stakeAmount === 0n || (opponentAmount !== null && opponentAmount >= stakeAmount);
      patch((v) => ({ stake: { ...v.stake, opponentAmount, published: !!sessionRef.current.session?.myStakeNoteId } }));

      // 6. Whose turn?
      const canMove =
        (state.phase === PHASE_CHALLENGED && pending.accept !== null) ||
        (state.phase === PHASE_ACTIVE && pending.shot !== null && (state.resultsProcessed === state.shotsFired || pending.result !== null));
      if (canMove) {
        patch({ myTurn: stakesReady, waitingDeadline: null, canClaimForfeit: false, blockTime: null });
        return false;
      }
      const deadline = sessionRef.current.session?.pendingDeadline ?? null;
      const waiting = state.phase === PHASE_ACTIVE && state.shotsFired > 0 ? deadline : null;
      const now = waiting ? await blockTimestamp(ctx) : null;
      patch({ myTurn: false, waitingDeadline: waiting, blockTime: now, canClaimForfeit: waiting !== null && now !== null && now > waiting });
      return false;
    },
    [myAddress, patch, readPending, syncStakes, claimPrize, playMove],
  );

  useEffect(() => {
    if (!enabled || !myAddress) return;
    let cancelled = false;

    const tick = async () => {
      if (busyRef.current || cancelled) return;
      busyRef.current = true;
      const { context, runExclusive } = contextRef.current;
      const ctx = context();
      try {
        const changed = await runExclusive(() => step(ctx));
        if (changed) await refetchRef.current();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Tick error: ${msg}`);
        patch({ lastError: msg });
      } finally {
        busyRef.current = false;
      }
    };

    log(`Starting gameplay sync (every ${AUTO_SYNC_INTERVAL_MS / 1000}s)`);
    void tick();
    const interval = setInterval(() => void tick(), AUTO_SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      log("Stopped gameplay sync.");
    };
  }, [enabled, myAddress, step, patch]);

  /** Runs an exclusive action while the sync loop stays out of the way. */
  const exclusiveAction = useCallback(
    async (label: string, action: (ctx: GameContext) => Promise<void>): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      patch({ busy: true, lastError: null, myTurn: false });
      const { context, runExclusive } = contextRef.current;
      try {
        await runExclusive(() => action(context()));
        await refetchRef.current();
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`${label} failed: ${msg}`);
        patch({ lastError: msg });
        return false;
      } finally {
        busyRef.current = false;
        patch({ busy: false });
      }
    },
    [patch],
  );

  /** My move: consume the opponent's pending notes and fire at (row, col) in one transaction. */
  const fire = useCallback(
    (row: number, col: number) =>
      exclusiveAction("Move", async (ctx) => {
        await sync(ctx);
        const pending = await readPending(ctx);
        await playMove(ctx, pending, { row, col });
      }),
    [exclusiveAction, readPending, playMove],
  );

  /** The opponent did not answer my last note in time: reclaim it (the component emits the forfeit note). */
  const claimForfeit = useCallback(
    () =>
      exclusiveAction("Forfeit claim", async (ctx) => {
        const s = sessionRef.current.session;
        const last = s?.shots.at(-1);
        if (!s || !last || s.pendingDeadline === null) throw new Error("No unanswered shot to reclaim");
        const note = await myShotNote(ctx, myAddress, opponentAddress, last.row, last.col, last.turn, s.pendingDeadline);
        await reclaimNote(ctx, myAddress, note);
        sessionRef.current.update({ pendingDeadline: null });
      }),
    [exclusiveAction, myAddress, opponentAddress],
  );

  return { ...view, fire, claimForfeit, myWallet: session.session?.myWallet ?? null };
}
