import { renderHook } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));
vi.mock("@miden-sdk/miden-sdk", () => {
  function MockFelt(this: { value: bigint }, v: bigint) { this.value = v; }
  return {
    Felt: MockFelt,
    Word: {
      newFromFelts: vi.fn((felts: Array<{ value: bigint }>) => ({
        toU64s: () => felts.map((f) => f.value),
      })),
    },
  };
});

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
    vi.mocked(useAccount).mockReturnValue({
      account: null,
      assets: [],
      isLoading: true,
      error: null,
      refetch: vi.fn(),
      getBalance: vi.fn(() => 0n),
    });

    const { result } = renderHook(() => useBoardState("mtst1test", false));
    expect(result.current.board).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it("builds a 10x10 grid from storage", () => {
    const boardCells = new Map<string, number>();
    boardCells.set("0,0", 1); // Ship at row 0, col 0
    boardCells.set("0,1", 6); // Hit at row 0, col 1
    boardCells.set("3,5", 7); // Miss at row 3, col 5

    const mockAccount = createMockGameAccount({
      id: "mtst1test",
      boardCells,
    });

    vi.mocked(useAccount).mockReturnValue({
      account: mockAccount as AnyAccount,
      assets: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      getBalance: vi.fn(() => 0n),
    });

    const { result } = renderHook(() => useBoardState("mtst1test", false));
    expect(result.current.board).not.toBeNull();
    expect(result.current.board!.length).toBe(10);
    expect(result.current.board![0].length).toBe(10);

    // Check specific cells
    expect(result.current.board![0][0].state).toBe(1); // Ship
    expect(result.current.board![0][1].state).toBe(6); // Hit
    expect(result.current.board![3][5].state).toBe(7); // Miss
    expect(result.current.board![5][5].state).toBe(0); // Water (empty)
  });

  it("returns all-water grid in opponent mode (no WASM query)", () => {
    // In opponent mode, useAccount receives undefined to prevent background
    // WASM queries that race with gameplay sync. The board is always all-water
    // since we can't read the opponent's storage.
    vi.mocked(useAccount).mockReturnValue({
      account: null,
      assets: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      getBalance: vi.fn(() => 0n),
    });
    const { result } = renderHook(() => useBoardState("mtst1test", true));
    expect(result.current.board).not.toBeNull();
    expect(result.current.board!.length).toBe(10);
    expect(result.current.board![0].length).toBe(10);
    // All cells should be water
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        expect(result.current.board![r][c].state).toBe(0);
      }
    }
  });
});
