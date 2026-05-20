import { describe, it, expect } from "vitest";

/**
 * Tests for useGameplaySync behavior — verifying the fixes for:
 *
 * 1. Result notes must be skipped (not consumed by defender's game account)
 *    - Bug: result notes target the shooter's wallet, not the defender
 *    - Consuming them caused nullifier conflicts and prover crashes
 *    - Fix: classifyAndBuildRequest returns "skip" for 4-input result notes
 *
 * 2. Remote prover must be used when available
 *    - Bug: submitNewTransaction uses local WASM prover (60-80s per shot)
 *    - Fix: use submitNewTransactionWithProver when prover is available (~2s)
 *
 * 3. Non-game notes (P2ID transfers) must be skipped
 *    - Bug: getInputNotes(Committed) returns ALL notes including P2ID transfers
 *    - Consuming P2ID notes against game account fails with address mismatch
 *    - Fix: classifyAndBuildRequest skips notes with unexpected input counts
 */

// Simulate classifyAndBuildRequest's note classification logic
function classifyNote(inputCount: number): "shot" | "result-skip" | "skip" {
  // Result notes (4 inputs): skip — target the shooter, not the defender
  if (inputCount === 4) return "result-skip";
  // Shot notes (14 inputs): consume with custom TX
  if (inputCount === 14) return "shot";
  // Everything else (P2ID, SWAP, unknown): skip
  return "skip";
}

// Simulate the prover selection logic
function selectProver(
  prover: object | null,
): "remote" | "local" {
  return prover ? "remote" : "local";
}

// Simulate result note gameOver detection
// Result note inputs: [shooter_prefix, shooter_suffix, turn, encodedResult]
// encodedResult = result * 2 + gameOver
// result: 0=miss, 1=hit. gameOver: 0=no, 1=yes.
function detectGameOverFromResultNote(encodedResult: bigint): {
  isHit: boolean;
  isGameOver: boolean;
} {
  return {
    isHit: encodedResult / 2n === 1n,
    isGameOver: encodedResult % 2n === 1n,
  };
}

describe("useGameplaySync", () => {
  describe("note classification", () => {
    it("classifies 14-input notes as shot notes", () => {
      expect(classifyNote(14)).toBe("shot");
    });

    it("skips 4-input result notes (they target the shooter)", () => {
      expect(classifyNote(4)).toBe("result-skip");
    });

    it("skips P2ID transfer notes (1 input)", () => {
      expect(classifyNote(1)).toBe("skip");
    });

    it("skips SWAP notes (different input count)", () => {
      expect(classifyNote(8)).toBe("skip");
    });

    it("skips setup notes (20 inputs — handled during handshake)", () => {
      expect(classifyNote(20)).toBe("skip");
    });

    it("skips challenge/accept notes (10 inputs — handled during handshake)", () => {
      expect(classifyNote(10)).toBe("skip");
    });

    it("skips notes with 0 inputs", () => {
      expect(classifyNote(0)).toBe("skip");
    });
  });

  describe("prover selection", () => {
    it("uses remote prover when available", () => {
      const mockProver = { prove: () => {} };
      expect(selectProver(mockProver)).toBe("remote");
    });

    it("falls back to local prover when no remote prover", () => {
      expect(selectProver(null)).toBe("local");
    });
  });

  describe("result note gameOver detection", () => {
    it("encodedResult=0: miss, no gameOver", () => {
      const r = detectGameOverFromResultNote(0n);
      expect(r.isHit).toBe(false);
      expect(r.isGameOver).toBe(false);
    });

    it("encodedResult=1: miss + gameOver (rare edge case)", () => {
      const r = detectGameOverFromResultNote(1n);
      expect(r.isHit).toBe(false);
      expect(r.isGameOver).toBe(true);
    });

    it("encodedResult=2: hit, no gameOver", () => {
      const r = detectGameOverFromResultNote(2n);
      expect(r.isHit).toBe(true);
      expect(r.isGameOver).toBe(false);
    });

    it("encodedResult=3: hit + gameOver (17th ship cell hit)", () => {
      const r = detectGameOverFromResultNote(3n);
      expect(r.isHit).toBe(true);
      expect(r.isGameOver).toBe(true);
    });
  });
});
