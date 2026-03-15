import { renderHook } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));
vi.mock("@miden-sdk/miden-sdk", () => ({
  Felt: vi.fn((v: bigint) => ({ value: v })),
  Word: { newFromFelts: vi.fn(() => ({})) },
}));

import { useAccount, useImportAccount } from "@miden-sdk/react";
import { useGameState } from "../useGameState";
import { createMockGameAccount } from "@/__tests__/fixtures/battleship";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAccount = any;

describe("useGameState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null gameState when account is not loaded", () => {
    vi.mocked(useAccount).mockReturnValue({
      account: null,
      assets: [],
      isLoading: true,
      error: null,
      refetch: vi.fn(),
      getBalance: vi.fn(() => 0n),
    });

    const { result } = renderHook(() => useGameState("mtst1test"));
    expect(result.current.gameState).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it("parses game_config and opponent storage into GameState", () => {
    const mockAccount = createMockGameAccount({
      id: "mtst1test",
      phase: 2,
      expectedTurn: 5,
      shipsHitCount: 3,
      totalShotsReceived: 7,
    });

    vi.mocked(useAccount).mockReturnValue({
      account: mockAccount as AnyAccount,
      assets: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      getBalance: vi.fn(() => 0n),
    });

    const { result } = renderHook(() => useGameState("mtst1test"));
    expect(result.current.gameState).toEqual({
      phase: 2,
      expectedTurn: 5,
      shipsHitCount: 3,
      totalShotsReceived: 7,
    });
    expect(result.current.isLoading).toBe(false);
  });

  it("imports the account after a short delay", async () => {
    vi.useFakeTimers();
    const mockImport = vi.fn(async () => ({}) as AnyAccount);
    vi.mocked(useImportAccount).mockReturnValue({
      importAccount: mockImport,
      account: null,
      isImporting: false,
      error: null,
      reset: vi.fn(),
    });

    renderHook(() => useGameState("mtst1test"));
    expect(mockImport).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    expect(mockImport).toHaveBeenCalledWith({
      type: "id",
      accountId: "mtst1test",
    });
    vi.useRealTimers();
  });
});
