import { render, screen } from "@testing-library/react";
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
vi.mock("@/lib/game", () => ({ publishShot: vi.fn(async () => ({ noteId: "0x", resultSerial: [] })) }));

const mockUseGameplaySync = vi.fn();
vi.mock("@/hooks/useGameplaySync", () => ({ useGameplaySync: (...args: unknown[]) => mockUseGameplaySync(...args) }));

import { useAccount } from "@miden-sdk/react";
import { createMockGameAccount } from "@/__tests__/fixtures/battleship";
import { GamePlay } from "../GamePlay";
import { buildEnemyBoard, nextShotTurn } from "@/lib/gameplay";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAccount = any;

const idleSync = { results: [], incomingShots: [], opponentGameOver: false, feeBalance: 9_000n, revealed: false, lastError: null };

describe("GamePlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGameplaySync.mockReturnValue(idleSync);
    const myAccount = createMockGameAccount({ id: "mtst1a", phase: 2, expectedTurn: 2, shipsHitCount: 0, totalShotsReceived: 0 });
    vi.mocked(useAccount).mockReturnValue({ account: myAccount as AnyAccount, assets: [], isLoading: false, error: null, refetch: vi.fn(), getBalance: vi.fn(() => 0n) });
  });

  it("renders two game boards and the fee balance", () => {
    render(<GamePlay accountA="mtst1a" accountB="mtst1b" playerRole="challenger" commitment={null} />);
    expect(screen.getByText("Your Fleet")).toBeInTheDocument();
    expect(screen.getByText("Enemy Waters")).toBeInTheDocument();
    expect(screen.getByText("0.009000 USDCx")).toBeInTheDocument();
  });

  it("the challenger fires first; the acceptor waits for the first shot", () => {
    render(<GamePlay accountA="mtst1a" accountB="mtst1b" playerRole="challenger" commitment={null} />);
    expect(screen.getByText(/YOUR TURN/)).toBeInTheDocument();
    render(<GamePlay accountA="mtst1a" accountB="mtst1b" playerRole="acceptor" commitment={null} />);
    expect(screen.getByText(/Opponent's turn/)).toBeInTheDocument();
  });

  it("shows victory when a result note reported game over", () => {
    mockUseGameplaySync.mockReturnValue({ ...idleSync, opponentGameOver: true });
    render(<GamePlay accountA="mtst1a" accountB="mtst1b" playerRole="challenger" commitment={null} />);
    expect(screen.getByText(/VICTORY/)).toBeInTheDocument();
  });

  it("shows loading state when the board is not ready", () => {
    vi.mocked(useAccount).mockReturnValue({ account: null, assets: [], isLoading: true, error: null, refetch: vi.fn(), getBalance: vi.fn(() => 0n) });
    render(<GamePlay accountA="mtst1a" accountB="mtst1b" playerRole="challenger" commitment={null} />);
    expect(screen.getByText("Loading boards...")).toBeInTheDocument();
  });
});

describe("turn and enemy board helpers", () => {
  it("challenger fires odd turns, acceptor even turns", () => {
    expect(nextShotTurn("challenger", 0)).toBe(1);
    expect(nextShotTurn("challenger", 3)).toBe(7);
    expect(nextShotTurn("acceptor", 1)).toBe(2);
    expect(nextShotTurn("acceptor", 4)).toBe(8);
  });

  it("builds the enemy board from resolved shots only", () => {
    const board = buildEnemyBoard(new Map([
      [1, { row: 0, col: 0, status: "hit" }],
      [3, { row: 2, col: 2, status: "miss" }],
      [5, { row: 4, col: 4, status: "pending" }],
    ]));
    expect(board[0][0].state).toBe(6);
    expect(board[2][2].state).toBe(7);
    expect(board[4][4].state).toBe(0);
  });
});
