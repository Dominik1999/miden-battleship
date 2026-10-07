import { renderHook } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));
vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));

import { useAccount } from "@miden-sdk/react";
import { useBoardState } from "../useBoardState";
import { createMockGameAccount } from "@/__tests__/fixtures/battleship";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAccount = any;

describe("useBoardState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null board when account is not loaded", () => {
    vi.mocked(useAccount).mockReturnValue({ account: null, assets: [], isLoading: true, error: null, refetch: vi.fn(), getBalance: vi.fn(() => 0n) });
    const { result } = renderHook(() => useBoardState("mtst1test", false));
    expect(result.current.board).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it("builds a 10x10 grid from the board map", () => {
    const boardCells = new Map<string, number>([["0,0", 1], ["0,1", 6], ["3,5", 7]]);
    const mockAccount = createMockGameAccount({ id: "mtst1test", boardCells });
    vi.mocked(useAccount).mockReturnValue({ account: mockAccount as AnyAccount, assets: [], isLoading: false, error: null, refetch: vi.fn(), getBalance: vi.fn(() => 0n) });
    const { result } = renderHook(() => useBoardState("mtst1test", false));
    const board = result.current.board!;
    expect(board.length).toBe(10);
    expect(board[0].length).toBe(10);
    expect(board[0][0].state).toBe(1);
    expect(board[0][1].state).toBe(6);
    expect(board[3][5].state).toBe(7);
    expect(board[5][5].state).toBe(0);
  });

  it("hides ships in opponent mode and returns water when the account is unknown", () => {
    const mockAccount = createMockGameAccount({ id: "mtst1test", boardCells: new Map([["0,0", 1], ["0,1", 6]]) });
    vi.mocked(useAccount).mockReturnValue({ account: mockAccount as AnyAccount, assets: [], isLoading: false, error: null, refetch: vi.fn(), getBalance: vi.fn(() => 0n) });
    const { result } = renderHook(() => useBoardState("mtst1test", true));
    expect(result.current.board![0][0].state).toBe(0);
    expect(result.current.board![0][1].state).toBe(6);

    vi.mocked(useAccount).mockReturnValue({ account: null, assets: [], isLoading: false, error: null, refetch: vi.fn(), getBalance: vi.fn(() => 0n) });
    const { result: unknown } = renderHook(() => useBoardState("mtst1test", true));
    expect(unknown.current.board!.flat().every((c) => c.state === 0)).toBe(true);
  });
});
