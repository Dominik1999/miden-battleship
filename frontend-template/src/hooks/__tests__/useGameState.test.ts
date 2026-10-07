import { renderHook } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));
vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));

import { useAccount } from "@miden-sdk/react";
import { readGameState, useGameState } from "../useGameState";
import { createMockGameAccount, createMockGameStorage } from "@/__tests__/fixtures/battleship";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAccount = any;

describe("useGameState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null gameState when account is not loaded", () => {
    vi.mocked(useAccount).mockReturnValue({ account: null, assets: [], isLoading: true, error: null, refetch: vi.fn(), getBalance: vi.fn(() => 0n) });
    const { result } = renderHook(() => useGameState("mtst1test"));
    expect(result.current.gameState).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it("parses game_config, opponent and reveal_status storage into GameState", () => {
    const mockAccount = createMockGameAccount({ id: "mtst1test", phase: 3, expectedTurn: 5, shipsHitCount: 3, totalShotsReceived: 7, revealStatus: [1, 0] });
    vi.mocked(useAccount).mockReturnValue({ account: mockAccount as AnyAccount, assets: [], isLoading: false, error: null, refetch: vi.fn(), getBalance: vi.fn(() => 0n) });
    const { result } = renderHook(() => useGameState("mtst1test"));
    expect(result.current.gameState).toEqual({ phase: 3, expectedTurn: 5, shipsHitCount: 3, totalShotsReceived: 7, myRevealed: 1, opponentVerified: 0 });
    expect(result.current.isLoading).toBe(false);
  });

  it("readGameState defaults the reveal flags to 0 when the slot is missing", () => {
    const storage = createMockGameStorage({ phase: 2, expectedTurn: 1, shipsHitCount: 0, totalShotsReceived: 0 });
    expect(readGameState(storage)?.myRevealed).toBe(0);
    expect(readGameState({ getItem: () => undefined })).toBeNull();
  });
});
