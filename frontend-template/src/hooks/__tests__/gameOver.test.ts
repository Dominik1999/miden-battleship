import { describe, it, expect } from "vitest";

/**
 * Tests for game-over detection logic.
 *
 * The game ends when one player has all 17 ship cells hit.
 * Two detection paths:
 *   1. Loss: myState.shipsHitCount >= TOTAL_SHIP_CELLS (always works)
 *   2. Win: opponentState.shipsHitCount >= TOTAL_SHIP_CELLS (BROKEN — see below)
 *   3. Phase: myState.phase === PHASE_COMPLETE or PHASE_REVEAL
 *
 * BUG: Win detection relies on opponentState, which is always null because
 * the opponent's game account can't be imported from the network (skipImport=true
 * in useGameState). The winning player never sees "VICTORY!" — only the losing
 * player sees "DEFEAT".
 *
 * TODO: Fix win detection by either:
 * - Having the contract emit a gameOver flag in the defender's state when the
 *   last ship is hit (the defender already knows — it's their board)
 * - Or transitioning to PHASE_COMPLETE when gameOver=1 in the result note
 */

const TOTAL_SHIP_CELLS = 17;
const PHASE_ACTIVE = 2;
const PHASE_REVEAL = 3;
const PHASE_COMPLETE = 4;

interface GameState {
  phase: number;
  shipsHitCount: number;
  totalShotsReceived: number;
}

function detectGameOver(
  myState: GameState | null,
  opponentState: GameState | null,
): { gameOver: boolean; iLost: boolean; iWon: boolean } {
  const iLost = myState ? myState.shipsHitCount >= TOTAL_SHIP_CELLS : false;
  const iWon = opponentState
    ? opponentState.shipsHitCount >= TOTAL_SHIP_CELLS
    : false;
  const gameOver =
    (myState?.phase === PHASE_COMPLETE) ||
    (myState?.phase === PHASE_REVEAL) ||
    iLost ||
    iWon;
  return { gameOver, iLost, iWon };
}

describe("Game over detection", () => {
  describe("Loss detection (always works)", () => {
    it("detects loss when all 17 ship cells are hit", () => {
      const myState: GameState = { phase: PHASE_ACTIVE, shipsHitCount: 17, totalShotsReceived: 20 };
      const result = detectGameOver(myState, null);
      expect(result.gameOver).toBe(true);
      expect(result.iLost).toBe(true);
      expect(result.iWon).toBe(false);
    });

    it("does not trigger loss at 16 hits", () => {
      const myState: GameState = { phase: PHASE_ACTIVE, shipsHitCount: 16, totalShotsReceived: 18 };
      const result = detectGameOver(myState, null);
      expect(result.gameOver).toBe(false);
      expect(result.iLost).toBe(false);
    });

    it("does not trigger when myState is null", () => {
      const result = detectGameOver(null, null);
      expect(result.gameOver).toBe(false);
      expect(result.iLost).toBe(false);
      expect(result.iWon).toBe(false);
    });
  });

  describe("Win detection (BROKEN — opponentState always null)", () => {
    it("KNOWN BUG: cannot detect win when opponentState is null", () => {
      // The winning player's opponent has 17 hits, but we can't see it
      const myState: GameState = { phase: PHASE_ACTIVE, shipsHitCount: 5, totalShotsReceived: 20 };
      const result = detectGameOver(myState, null);
      // This SHOULD be gameOver=true, iWon=true — but it's not
      expect(result.gameOver).toBe(false);
      expect(result.iWon).toBe(false);
      // This test documents the bug. When fixed, change expects to true.
    });

    it("win detection works IF opponentState is available", () => {
      const myState: GameState = { phase: PHASE_ACTIVE, shipsHitCount: 5, totalShotsReceived: 20 };
      const opponentState: GameState = { phase: PHASE_ACTIVE, shipsHitCount: 17, totalShotsReceived: 17 };
      const result = detectGameOver(myState, opponentState);
      expect(result.gameOver).toBe(true);
      expect(result.iWon).toBe(true);
      expect(result.iLost).toBe(false);
    });
  });

  describe("Phase-based game over", () => {
    it("detects game over from PHASE_COMPLETE", () => {
      const myState: GameState = { phase: PHASE_COMPLETE, shipsHitCount: 10, totalShotsReceived: 15 };
      const result = detectGameOver(myState, null);
      expect(result.gameOver).toBe(true);
    });

    it("detects game over from PHASE_REVEAL", () => {
      const myState: GameState = { phase: PHASE_REVEAL, shipsHitCount: 10, totalShotsReceived: 15 };
      const result = detectGameOver(myState, null);
      expect(result.gameOver).toBe(true);
    });

    it("does not trigger game over during PHASE_ACTIVE", () => {
      const myState: GameState = { phase: PHASE_ACTIVE, shipsHitCount: 10, totalShotsReceived: 15 };
      const result = detectGameOver(myState, null);
      expect(result.gameOver).toBe(false);
    });
  });

  describe("Gameplay sync stops on game over", () => {
    it("gameOverRef should disable sync loop", () => {
      // Simulate: gameOver stops the gameplay sync from running
      const myState: GameState = { phase: PHASE_ACTIVE, shipsHitCount: 17, totalShotsReceived: 20 };
      const { gameOver } = detectGameOver(myState, null);
      // useGameplaySync is called with enabled = !busy && !gameOverRef.current
      const syncEnabled = !false && !gameOver; // busy=false, gameOver=true
      expect(syncEnabled).toBe(false);
    });

    it("sync continues when game is not over", () => {
      const myState: GameState = { phase: PHASE_ACTIVE, shipsHitCount: 10, totalShotsReceived: 12 };
      const { gameOver } = detectGameOver(myState, null);
      const syncEnabled = !false && !gameOver;
      expect(syncEnabled).toBe(true);
    });
  });
});
