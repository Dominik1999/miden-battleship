import { describe, it, expect } from "vitest";

/**
 * Tests for note filtering logic used in useStartGame and useJoinGame.
 *
 * The consume flows must only process game-related notes and skip:
 * - P2ID token transfers (target the wallet, not the game account)
 * - Result notes (target the shooter, not the defender)
 * - Unknown note types
 *
 * Game notes are identified by their input count:
 * - Setup note: 20 inputs (game_id + opponent + commitment + 10 board rows)
 * - Challenge note: 10 inputs (game_id + account + commitment)
 * - Accept note: 10 inputs (game_id + account + commitment)
 * - Shot note: 14 inputs (row + col + turn + serial_num + script_root + shooter)
 * - Result note: 4 inputs (shooter_prefix + suffix + turn + result)
 *
 * Non-game notes (P2ID, SWAP, etc.) have different input counts.
 */

// Simulate the filtering logic used in useStartGame's pendingNotes
function isStarterGameNote(inputCount: number): boolean {
  // Starter expects challenge notes (10 inputs)
  return inputCount === 10;
}

// Simulate the filtering logic used in useJoinGame's pendingNotes
function isJoinerGameNote(inputCount: number): boolean {
  // Joiner expects setup notes (20 inputs) and accept notes (10 inputs)
  return inputCount === 20 || inputCount === 10;
}

// Simulate the filtering logic used in useGameplaySync's classifyAndBuildRequest
function classifyGameplayNote(inputCount: number): "shot" | "result-skip" | "skip" {
  if (inputCount === 4) return "result-skip";
  if (inputCount === 14) return "shot";
  return "skip";
}

describe("Note filtering", () => {
  describe("Starter (useStartGame) pendingNotes filter", () => {
    it("accepts challenge notes (10 inputs)", () => {
      expect(isStarterGameNote(10)).toBe(true);
    });

    it("rejects P2ID token transfers (1 input — just the target account)", () => {
      expect(isStarterGameNote(1)).toBe(false);
    });

    it("rejects setup notes (20 inputs — those are for the joiner)", () => {
      expect(isStarterGameNote(20)).toBe(false);
    });

    it("rejects shot notes (14 inputs — handled by gameplay sync)", () => {
      expect(isStarterGameNote(14)).toBe(false);
    });

    it("rejects result notes (4 inputs)", () => {
      expect(isStarterGameNote(4)).toBe(false);
    });

    it("rejects notes with 0 inputs", () => {
      expect(isStarterGameNote(0)).toBe(false);
    });
  });

  describe("Joiner (useJoinGame) pendingNotes filter", () => {
    it("accepts setup notes (20 inputs)", () => {
      expect(isJoinerGameNote(20)).toBe(true);
    });

    it("accepts accept notes (10 inputs)", () => {
      expect(isJoinerGameNote(10)).toBe(true);
    });

    it("rejects P2ID token transfers", () => {
      expect(isJoinerGameNote(1)).toBe(false);
    });

    it("rejects shot notes (14 inputs — handled by gameplay sync)", () => {
      expect(isJoinerGameNote(14)).toBe(false);
    });

    it("rejects result notes (4 inputs)", () => {
      expect(isJoinerGameNote(4)).toBe(false);
    });

    it("rejects notes with 0 inputs", () => {
      expect(isJoinerGameNote(0)).toBe(false);
    });
  });

  describe("Gameplay sync (useGameplaySync) note classification", () => {
    it("classifies shot notes (14 inputs) as 'shot'", () => {
      expect(classifyGameplayNote(14)).toBe("shot");
    });

    it("skips result notes (4 inputs) — they target the shooter", () => {
      expect(classifyGameplayNote(4)).toBe("result-skip");
    });

    it("skips P2ID token transfers (1 input)", () => {
      expect(classifyGameplayNote(1)).toBe("skip");
    });

    it("skips setup notes (20 inputs) — handled during handshake", () => {
      expect(classifyGameplayNote(20)).toBe("skip");
    });

    it("skips challenge notes (10 inputs) — handled during handshake", () => {
      expect(classifyGameplayNote(10)).toBe("skip");
    });

    it("skips notes with 0 inputs", () => {
      expect(classifyGameplayNote(0)).toBe("skip");
    });
  });

  describe("Edge cases", () => {
    it("no note type uses exactly 2 inputs — would be skipped everywhere", () => {
      expect(isStarterGameNote(2)).toBe(false);
      expect(isJoinerGameNote(2)).toBe(false);
      expect(classifyGameplayNote(2)).toBe("skip");
    });

    it("no note type uses exactly 15 inputs — would be skipped everywhere", () => {
      expect(isStarterGameNote(15)).toBe(false);
      expect(isJoinerGameNote(15)).toBe(false);
      expect(classifyGameplayNote(15)).toBe("skip");
    });
  });
});
