import { fireEvent, render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

function MockAudioContext() {
  const mockNode = { gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn().mockReturnThis(), disconnect: vi.fn(), type: "", frequency: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, Q: { value: 0 }, start: vi.fn(), stop: vi.fn(), buffer: null };
  return {
    currentTime: 0,
    destination: {},
    sampleRate: 44100,
    createOscillator: vi.fn(() => ({ ...mockNode })),
    createGain: vi.fn(() => ({ ...mockNode })),
    createBiquadFilter: vi.fn(() => ({ ...mockNode })),
    createBuffer: vi.fn(() => ({ getChannelData: () => new Float32Array(100) })),
    createBufferSource: vi.fn(() => ({ ...mockNode })),
  };
}
vi.stubGlobal("AudioContext", MockAudioContext);

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));
vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));

const mockUseGameplaySync = vi.fn();
vi.mock("@/hooks/useGameplaySync", () => ({ useGameplaySync: (...args: unknown[]) => mockUseGameplaySync(...args) }));

import { useAccount } from "@miden-sdk/react";
import { createMockGameAccount } from "@/__tests__/fixtures/battleship";
import { GamePlay } from "../GamePlay";
import { buildEnemyBoard } from "@/lib/gameplay";
import type { GameSession } from "@/lib/session";
import type { SessionActions } from "@/hooks/useGameSession";
import { CELL_HIT, CELL_MISS, CELL_WATER, PHASE_ACTIVE, PHASE_CHALLENGED } from "@/types/game";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAccount = any;

const baseState = { phase: PHASE_ACTIVE, expectedTurn: 2, shipsHitCount: 0, totalShotsReceived: 0, shotsFired: 0, resultsProcessed: 0, role: 1, lastShot: { row: 0, col: 0, turn: 0 }, outcome: 0, ownerWallet: null, opponentWallet: null } as const;
const fire = vi.fn(async () => true);
const claimForfeit = vi.fn(async () => true);
const idleView = {
  myState: baseState,
  outcome: "open" as const,
  myTurn: false,
  busy: false,
  waitingDeadline: null,
  blockTime: null,
  canClaimForfeit: false,
  stake: { amount: 0n, published: false, opponentAmount: null, claimed: false },
  incomingShots: [],
  feeBalance: 9_000n,
  lastError: null,
  fire,
  claimForfeit,
  myWallet: "mtst1wallet",
};

function sessionWith(shots: GameSession["shots"], stakeAmount = "0"): SessionActions {
  const session: GameSession = { version: 1, role: "challenger", myAddress: "mtst1a", mySeed: ["1", "2", "3", "4"], myWallet: "mtst1wallet", opponentAddress: "mtst1b", gameId: ["1", "1", "1", "1"], cells: [], stakeAmount, shots, pendingDeadline: null, myStakeNoteId: null, claimed: false, createdAt: 0 };
  return { session, start: vi.fn(), update: vi.fn(), clear: vi.fn() };
}

const renderPlay = (session = sessionWith([]), role: "challenger" | "acceptor" = "challenger") =>
  render(<GamePlay myAccount="mtst1a" opponentAccount="mtst1b" playerRole={role} session={session} onNewGame={vi.fn()} />);

describe("GamePlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGameplaySync.mockReturnValue(idleView);
    const myAccount = createMockGameAccount({ id: "mtst1a", phase: 2, expectedTurn: 2, shipsHitCount: 0, totalShotsReceived: 0 });
    vi.mocked(useAccount).mockReturnValue({ account: myAccount as AnyAccount, assets: [], isLoading: false, error: null, refetch: vi.fn(), getBalance: vi.fn(() => 0n) });
  });

  it("renders two game boards and the fee balance", () => {
    renderPlay();
    expect(screen.getByText("Your Fleet")).toBeInTheDocument();
    expect(screen.getByText("Enemy Waters")).toBeInTheDocument();
    expect(screen.getByText("0.009000 USDCx")).toBeInTheDocument();
  });

  it("shows my turn when the hook says so and waits otherwise", () => {
    mockUseGameplaySync.mockReturnValue({ ...idleView, myTurn: true });
    renderPlay();
    expect(screen.getByText(/YOUR TURN/)).toBeInTheDocument();
    mockUseGameplaySync.mockReturnValue({ ...idleView, myTurn: true, myState: { ...baseState, phase: PHASE_CHALLENGED } });
    renderPlay();
    expect(screen.getByText(/Fire the first shot/)).toBeInTheDocument();
    mockUseGameplaySync.mockReturnValue(idleView);
    renderPlay(sessionWith([]), "acceptor");
    expect(screen.getByText(/Opponent's turn/)).toBeInTheDocument();
  });

  it("fires at a clicked enemy cell on my turn and never at a cell already shot", () => {
    mockUseGameplaySync.mockReturnValue({ ...idleView, myTurn: true });
    renderPlay(sessionWith([{ turn: 1, row: 0, col: 0, status: "miss" }]));
    const cells = screen.getAllByRole("button", { name: /^Cell/ });
    const enemyCells = cells.slice(100);
    fireEvent.click(enemyCells[0]);
    expect(fire).not.toHaveBeenCalled();
    fireEvent.click(enemyCells[11]);
    expect(fire).toHaveBeenCalledWith(1, 1);
  });

  it("counts down to the forfeit and offers the claim once the deadline passed", () => {
    mockUseGameplaySync.mockReturnValue({ ...idleView, waitingDeadline: 10_000, blockTime: 2_800 });
    renderPlay();
    expect(screen.getByText(/forfeits in 2h 0m/)).toBeInTheDocument();
    mockUseGameplaySync.mockReturnValue({ ...idleView, waitingDeadline: 10_000, blockTime: 10_001, canClaimForfeit: true });
    renderPlay();
    fireEvent.click(screen.getByText("Claim the win by forfeit"));
    expect(claimForfeit).toHaveBeenCalled();
  });

  it("shows the outcome and a new-game button when the game is complete", () => {
    mockUseGameplaySync.mockReturnValue({ ...idleView, outcome: "won" });
    renderPlay();
    expect(screen.getByText(/VICTORY/)).toBeInTheDocument();
    expect(screen.getByText("New game")).toBeInTheDocument();
    mockUseGameplaySync.mockReturnValue({ ...idleView, outcome: "lost" });
    renderPlay();
    expect(screen.getByText(/DEFEAT/)).toBeInTheDocument();
  });

  it("gates the first shot on both stakes being locked", () => {
    mockUseGameplaySync.mockReturnValue({ ...idleView, stake: { amount: 2000n, published: true, opponentAmount: 1000n, claimed: false } });
    renderPlay(sessionWith([], "2000"));
    expect(screen.getByText(/Waiting for both stakes/)).toBeInTheDocument();
    expect(screen.getByText(/opponent's pending/)).toBeInTheDocument();
  });
});

describe("buildEnemyBoard", () => {
  it("marks hits and misses from the shot log, pending shots stay water", () => {
    const board = buildEnemyBoard([
      { turn: 1, row: 0, col: 0, status: "hit" },
      { turn: 3, row: 1, col: 1, status: "miss" },
      { turn: 5, row: 2, col: 2, status: "pending" },
    ]);
    expect(board[0][0].state).toBe(CELL_HIT);
    expect(board[1][1].state).toBe(CELL_MISS);
    expect(board[2][2].state).toBe(CELL_WATER);
  });
});
