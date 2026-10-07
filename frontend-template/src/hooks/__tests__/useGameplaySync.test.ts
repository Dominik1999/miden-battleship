import { renderHook, act, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));
vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));

type MoveShape = { inputs: { note: { kind: string }; args?: unknown }[]; expected: unknown[]; fire?: unknown };
type Fn<R> = (...args: unknown[]) => R;
const idLike = (text: string): { toString(): string } => ({ toString: () => text });
const game = vi.hoisted(() => ({
  sync: vi.fn<Fn<Promise<void>>>(async () => {}),
  feeBalance: vi.fn<Fn<Promise<bigint>>>(async () => 9_000n),
  blockTimestamp: vi.fn<Fn<Promise<number>>>(async () => 5_000),
  pendingNotesFor: vi.fn<Fn<Promise<unknown[]>>>(async () => []),
  classifyNote: vi.fn(async (_ctx: unknown, record: { kind: string }) => ({ kind: record.kind, record })),
  consumeNotes: vi.fn<Fn<Promise<string>>>(async () => "0xtx"),
  parseResultStorage: vi.fn<Fn<{ shooter: unknown; turn: number; isHit: boolean; isGameOver: boolean; deadline: number }>>(() => ({ shooter: {}, turn: 1, isHit: true, isGameOver: false, deadline: 9 })),
  parseShotStorage: vi.fn<Fn<{ row: number; col: number; turn: number; deadline: number }>>(() => ({ row: 3, col: 3, turn: 2, deadline: 9 })),
  parseStakeNote: vi.fn<Fn<{ oppGame: { toString(): string }; amount: bigint }>>(() => ({ oppGame: idLike(""), amount: 0n })),
  predictShot: vi.fn<Fn<{ isHit: boolean; gameOver: boolean }>>(() => ({ isHit: false, gameOver: false })),
  planResolution: vi.fn<Fn<Promise<unknown>>>(async () => ({ args: [1n, 1n, 1n, 1n], result: { id: () => ({ toString: () => "0xres" }) }, defeat: null, deadline: 50_000, outcome: { row: 3, col: 3, turn: 2, isHit: false, gameOver: false } })),
  planShot: vi.fn<Fn<Promise<unknown>>>(async () => ({ args: [0n, 0n, 50_000n, 0n], note: { id: () => ({ toString: () => "0xshot" }) }, turn: 3, deadline: 50_000 })),
  submitMove: vi.fn<Fn<Promise<string>>>(async () => "0xtx"),
  publishStake: vi.fn<Fn<Promise<unknown>>>(async () => ({ id: () => ({ toString: () => "0xstake" }) })),
  reclaimNote: vi.fn<Fn<Promise<unknown>>>(async () => ({})),
  myShotNote: vi.fn<Fn<Promise<unknown>>>(async () => ({ mine: true })),
  claimNotes: vi.fn<Fn<Promise<string>>>(async () => "0xtx"),
}));
vi.mock("@/lib/game", () => game);
vi.mock("@/lib/funding", () => ({ claimFaucetTokens: vi.fn(), shouldTopUp: () => false }));
const client = vi.hoisted(() => ({ getAccount: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined), feeFaucetId: vi.fn(async () => idLike("fee")) }));
vi.mock("@/hooks/useGameContext", () => {
  const ctx = { client, compiler: {}, prover: null };
  const value = { client, runExclusive: async <T,>(fn: () => Promise<T>) => fn(), context: () => ctx };
  return { useGameContext: () => value };
});

import { useGameplaySync } from "../useGameplaySync";
import type { SessionActions } from "@/hooks/useGameSession";
import type { GameSession } from "@/lib/session";
import { OUTCOME_LOST, OUTCOME_WON, PHASE_ACTIVE, PHASE_CHALLENGED, PHASE_COMPLETE, ROLE_ACCEPTOR, ROLE_CHALLENGER } from "@/types/game";

const ME = "mtst1me";
const OPP = "mtst1opp";

function storageFor(state: Partial<{ phase: number; shotsFired: number; resultsProcessed: number; role: number; outcome: number }>) {
  const SLOT = "miden_battleship_account::battleship_account";
  const word = (v: bigint[]) => ({ toU64s: () => v });
  const slots: Record<string, ReturnType<typeof word>> = {
    [`${SLOT}::game_config`]: word([10n, 17n, BigInt(state.phase ?? PHASE_ACTIVE), 0n]),
    [`${SLOT}::opponent`]: word([1n, 2n, 0n, 0n]),
    [`${SLOT}::turn_state`]: word([BigInt(state.shotsFired ?? 0), BigInt(state.resultsProcessed ?? 0), BigInt(state.role ?? ROLE_CHALLENGER), 0n]),
    [`${SLOT}::last_shot`]: word([0n, 0n, 0n, 0n]),
    [`${SLOT}::outcome`]: word([BigInt(state.outcome ?? 0), 0n, 0n, 0n]),
    [`${SLOT}::owner_wallet`]: word([5n, 6n, 0n, 0n]),
    [`${SLOT}::opponent_wallet`]: word([7n, 8n, 0n, 0n]),
  };
  return { getItem: (name: string) => slots[name] };
}

type FakeNote = { kind: string; id: () => { toString: () => string } };
type FakeRecord = FakeNote & { toNote: () => FakeNote };
const note = (kind: string, id = `0x${kind}`): FakeRecord => ({ kind, toNote: () => ({ kind, id: () => ({ toString: () => id }) }), id: () => ({ toString: () => id }) });

function makeSession(overrides: Partial<GameSession> = {}): SessionActions & { current: GameSession } {
  const current: GameSession = { version: 1, role: "challenger", myAddress: ME, mySeed: ["1", "2", "3", "4"], myWallet: "mtst1wallet", opponentAddress: OPP, gameId: ["1", "1", "1", "1"], cells: [], stakeAmount: "0", shots: [], pendingDeadline: null, myStakeNoteId: null, claimed: false, createdAt: 0, ...overrides };
  const actions = {
    current,
    get session() {
      return actions.current;
    },
    start: vi.fn(),
    update: vi.fn((patch: Partial<GameSession> | ((s: GameSession) => Partial<GameSession>)) => {
      actions.current = { ...actions.current, ...(typeof patch === "function" ? patch(actions.current) : patch) };
    }),
    clear: vi.fn(),
  };
  return actions as unknown as SessionActions & { current: GameSession };
}

function mockAccount(state: Parameters<typeof storageFor>[0]) {
  client.getAccount.mockImplementation(async () => ({ storage: () => storageFor(state) }));
}
const lastMove = () => game.submitMove.mock.calls.at(-1)![2] as MoveShape;

describe("useGameplaySync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    game.pendingNotesFor.mockResolvedValue([]);
    game.blockTimestamp.mockResolvedValue(5_000);
    game.predictShot.mockReturnValue({ isHit: false, gameOver: false });
    game.parseResultStorage.mockReturnValue({ shooter: {}, turn: 1, isHit: true, isGameOver: false, deadline: 9 });
  });

  it("the challenger's first move is enabled by a pending accept note while still CHALLENGED", async () => {
    mockAccount({ phase: PHASE_CHALLENGED, role: 0 });
    game.pendingNotesFor.mockResolvedValue([note("accept")]);
    const { result } = renderHook(() => useGameplaySync({ myAddress: ME, opponentAddress: OPP, session: makeSession(), enabled: true }));
    await waitFor(() => expect(result.current.myTurn).toBe(true));
  });

  it("my turn needs the opponent's shot and the result of my last shot", async () => {
    mockAccount({ phase: PHASE_ACTIVE, shotsFired: 1, resultsProcessed: 0, role: ROLE_CHALLENGER });
    game.pendingNotesFor.mockResolvedValue([note("shot")]);
    const session = makeSession({ shots: [{ turn: 1, row: 0, col: 0, status: "pending" }], pendingDeadline: 6_000 });
    const { result } = renderHook(() => useGameplaySync({ myAddress: ME, opponentAddress: OPP, session, enabled: true }));
    await waitFor(() => expect(result.current.waitingDeadline).toBe(6_000));
    expect(result.current.myTurn).toBe(false);
    expect(result.current.canClaimForfeit).toBe(false);
  });

  it("fire() consumes the pending notes and fires in one move, logging the shot", async () => {
    mockAccount({ phase: PHASE_ACTIVE, shotsFired: 1, resultsProcessed: 0, role: ROLE_CHALLENGER });
    game.pendingNotesFor.mockResolvedValue([note("result"), note("shot")]);
    const session = makeSession({ shots: [{ turn: 1, row: 0, col: 0, status: "pending" }] });
    const { result } = renderHook(() => useGameplaySync({ myAddress: ME, opponentAddress: OPP, session, enabled: true }));
    await waitFor(() => expect(result.current.myTurn).toBe(true));
    expect(session.current.shots[0].status).toBe("hit"); // the pending result note was applied to the log
    await act(async () => {
      await result.current.fire(4, 5);
    });
    const move = lastMove();
    expect(move.inputs.map((i) => i.note.kind)).toEqual(["result", "shot"]);
    expect(move.inputs[1].args).toEqual([1n, 1n, 1n, 1n]);
    expect(move.expected).toHaveLength(2);
    expect(move.fire).toEqual([0n, 0n, 50_000n, 0n]);
    expect(session.current.shots.at(-1)).toEqual({ turn: 3, row: 4, col: 5, status: "pending" });
    expect(session.current.pendingDeadline).toBe(50_000);
  });

  it("resolves a sinking shot at once (no fire) and processes a final result at once", async () => {
    mockAccount({ phase: PHASE_ACTIVE, shotsFired: 1, resultsProcessed: 1, role: ROLE_ACCEPTOR });
    game.pendingNotesFor.mockResolvedValue([note("shot")]);
    game.predictShot.mockReturnValueOnce({ isHit: true, gameOver: true });
    renderHook(() => useGameplaySync({ myAddress: ME, opponentAddress: OPP, session: makeSession({ role: "acceptor" }), enabled: true }));
    await waitFor(() => expect(game.submitMove).toHaveBeenCalledTimes(1));
    expect(lastMove().fire).toBeUndefined();

    vi.clearAllMocks();
    mockAccount({ phase: PHASE_ACTIVE, shotsFired: 2, resultsProcessed: 1, role: ROLE_CHALLENGER });
    game.pendingNotesFor.mockResolvedValue([note("result")]);
    game.parseResultStorage.mockReturnValue({ shooter: {}, turn: 3, isHit: true, isGameOver: true, deadline: 9 });
    renderHook(() => useGameplaySync({ myAddress: ME, opponentAddress: OPP, session: makeSession(), enabled: true }));
    await waitFor(() => expect(game.submitMove).toHaveBeenCalledTimes(1));
    const move = lastMove();
    expect(move.inputs.map((i) => i.note.kind)).toEqual(["result"]);
    expect(move.fire).toBeUndefined();
  });

  it("offers the forfeit once the block time passes my deadline and reclaims my shot note", async () => {
    mockAccount({ phase: PHASE_ACTIVE, shotsFired: 1, resultsProcessed: 0, role: ROLE_CHALLENGER });
    game.blockTimestamp.mockResolvedValue(7_000);
    const session = makeSession({ shots: [{ turn: 1, row: 2, col: 3, status: "pending" }], pendingDeadline: 6_000 });
    const { result } = renderHook(() => useGameplaySync({ myAddress: ME, opponentAddress: OPP, session, enabled: true }));
    await waitFor(() => expect(result.current.canClaimForfeit).toBe(true));
    await act(async () => {
      await result.current.claimForfeit();
    });
    expect(game.myShotNote).toHaveBeenCalledWith(expect.anything(), ME, OPP, 2, 3, 1, 6_000);
    expect(game.reclaimNote).toHaveBeenCalled();
  });

  it("reports the outcome from the account and the winner claims with the wallet", async () => {
    mockAccount({ phase: PHASE_COMPLETE, outcome: OUTCOME_WON, role: ROLE_CHALLENGER });
    game.pendingNotesFor.mockImplementation(async (...[, address]: unknown[]) => (address === "mtst1wallet" ? [note("defeat")] : []));
    const session = makeSession();
    const { result } = renderHook(() => useGameplaySync({ myAddress: ME, opponentAddress: OPP, session, enabled: true }));
    await waitFor(() => expect(result.current.outcome).toBe("won"));
    await waitFor(() => expect(game.claimNotes).toHaveBeenCalledTimes(1));
    expect(session.current.claimed).toBe(true);

    vi.clearAllMocks();
    mockAccount({ phase: PHASE_COMPLETE, outcome: OUTCOME_LOST });
    const lost = renderHook(() => useGameplaySync({ myAddress: ME, opponentAddress: OPP, session: makeSession(), enabled: true }));
    await waitFor(() => expect(lost.result.current.outcome).toBe("lost"));
    expect(game.claimNotes).not.toHaveBeenCalled();
  });

  it("with a stake, the first shot waits for the opponent's matching stake note", async () => {
    mockAccount({ phase: PHASE_ACTIVE, role: ROLE_ACCEPTOR });
    game.pendingNotesFor.mockImplementation(async (...[, address]: unknown[]) => (address === ME ? [note("shot")] : []));
    const session = makeSession({ role: "acceptor", stakeAmount: "2000" });
    const { result } = renderHook(() => useGameplaySync({ myAddress: ME, opponentAddress: OPP, session, enabled: true }));
    await waitFor(() => expect(game.publishStake).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.stake.published).toBe(true));
    expect(result.current.myTurn).toBe(false);

    game.parseStakeNote.mockReturnValue({ oppGame: idLike(ME), amount: 2000n });
    game.pendingNotesFor.mockImplementation(async (...[, address]: unknown[]) => (address === ME ? [note("shot")] : [note("stake")]));
    await waitFor(() => expect(result.current.myTurn).toBe(true), { timeout: 8_000 });
    expect(result.current.stake.opponentAmount).toBe(2000n);
  });
});
