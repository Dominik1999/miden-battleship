import { renderHook } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));
vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));

import { useAccount } from "@miden-sdk/react";
import { useGameState } from "../useGameState";
import { createMockGameAccount } from "@/__tests__/fixtures/battleship";
import { OUTCOME_LOST, PHASE_COMPLETE, ROLE_CHALLENGER } from "@/types/game";

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

  it("parses the account storage into GameState", () => {
    const mockAccount = createMockGameAccount({ id: "mtst1test", phase: PHASE_COMPLETE, expectedTurn: 5, shipsHitCount: 17, totalShotsReceived: 20, shotsFired: 9, resultsProcessed: 9, role: ROLE_CHALLENGER, outcome: OUTCOME_LOST });
    vi.mocked(useAccount).mockReturnValue({ account: mockAccount as AnyAccount, assets: [], isLoading: false, error: null, refetch: vi.fn(), getBalance: vi.fn(() => 0n) });
    const { result } = renderHook(() => useGameState("mtst1test"));
    expect(result.current.gameState).toMatchObject({ phase: PHASE_COMPLETE, shipsHitCount: 17, totalShotsReceived: 20, shotsFired: 9, resultsProcessed: 9, role: ROLE_CHALLENGER, outcome: OUTCOME_LOST });
    expect(result.current.isLoading).toBe(false);
  });
});
