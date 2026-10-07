import { describe, it, expect } from "vitest";
import { createMockGameStorage } from "@/__tests__/fixtures/battleship";
import { readGameState } from "@/lib/state";
import { OUTCOME_WON, PHASE_ACTIVE, ROLE_ACCEPTOR } from "@/types/game";

describe("readGameState", () => {
  it("reads phase, counters, turn state, last shot, outcome and wallets", () => {
    const storage = createMockGameStorage({
      phase: PHASE_ACTIVE,
      expectedTurn: 4,
      shipsHitCount: 3,
      totalShotsReceived: 5,
      shotsFired: 2,
      resultsProcessed: 1,
      role: ROLE_ACCEPTOR,
      lastShot: [7, 8, 4],
      outcome: OUTCOME_WON,
      ownerWallet: [11n, 12n],
      opponentWallet: [21n, 22n],
    });
    expect(readGameState(storage)).toEqual({
      phase: PHASE_ACTIVE,
      expectedTurn: 4,
      shipsHitCount: 3,
      totalShotsReceived: 5,
      shotsFired: 2,
      resultsProcessed: 1,
      role: ROLE_ACCEPTOR,
      lastShot: { row: 7, col: 8, turn: 4 },
      outcome: OUTCOME_WON,
      ownerWallet: [11n, 12n],
      opponentWallet: [21n, 22n],
    });
  });

  it("returns null wallets before setup / handshake and null state without the config slot", () => {
    const state = readGameState(createMockGameStorage({ phase: 0, expectedTurn: 0, shipsHitCount: 0, totalShotsReceived: 0 }));
    expect(state?.ownerWallet).toBeNull();
    expect(state?.opponentWallet).toBeNull();
    expect(readGameState({ getItem: () => undefined })).toBeNull();
  });
});
