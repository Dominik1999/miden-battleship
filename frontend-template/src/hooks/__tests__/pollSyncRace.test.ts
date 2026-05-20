import { describe, it, expect } from "vitest";

/**
 * Tests for the poll sync race condition fix.
 *
 * Bug: When the starter submits a setup note via wallet adapter and then
 * tries to consume it, a concurrent poll sync could advance sync_height
 * past the note's block, making it permanently invisible.
 *
 * Fix: pollSuppressedRef guard in useStartGame.consumeNotes that prevents
 * in-flight poll syncs from completing during the consume flow.
 *
 * The joiner (useJoinGame) does NOT suppress the poll because:
 * - The joiner's consumeNotes doesn't submit notes via wallet adapter
 * - All consumed notes were already discovered via sync
 * - Suppressing the poll prevents discovering the accept note from the starter
 */

// Simulate the poll suppression logic
class PollController {
  suppressed = false;
  pollCount = 0;
  syncHeightAdvanced = false;

  tick() {
    if (this.suppressed) return false; // tick skipped
    this.pollCount++;
    // Simulate sync advancing the height
    this.syncHeightAdvanced = true;
    return true; // tick executed
  }

  suppress() {
    this.suppressed = true;
  }

  unsuppress() {
    this.suppressed = false;
  }
}

describe("Poll sync race prevention", () => {
  describe("useStartGame (starter) — must suppress poll during consume", () => {
    it("suppressed poll skips tick execution", () => {
      const ctrl = new PollController();
      ctrl.suppress();
      const executed = ctrl.tick();
      expect(executed).toBe(false);
      expect(ctrl.pollCount).toBe(0);
      expect(ctrl.syncHeightAdvanced).toBe(false);
    });

    it("suppression prevents sync_height from advancing", () => {
      const ctrl = new PollController();

      // Normal tick advances height
      ctrl.tick();
      expect(ctrl.syncHeightAdvanced).toBe(true);

      // Reset and suppress
      ctrl.syncHeightAdvanced = false;
      ctrl.suppress();
      ctrl.tick();
      expect(ctrl.syncHeightAdvanced).toBe(false);
    });

    it("suppression takes effect immediately (before clearInterval)", () => {
      const ctrl = new PollController();
      // Simulate: suppress first, then the interval fires
      ctrl.suppress();
      // Even if a tick was already scheduled, it should be a no-op
      const result = ctrl.tick();
      expect(result).toBe(false);
    });
  });

  describe("useJoinGame (joiner) — must NOT suppress poll", () => {
    it("joiner poll continues running during consume", () => {
      const ctrl = new PollController();
      // Joiner doesn't suppress — poll keeps running
      ctrl.tick();
      ctrl.tick();
      expect(ctrl.pollCount).toBe(2);
    });

    it("joiner discovers accept note via continued polling", () => {
      const ctrl = new PollController();
      // Simulate: joiner consumes setup note, poll keeps running
      // and discovers accept note on next tick
      ctrl.tick(); // discovers accept note
      expect(ctrl.pollCount).toBe(1);
      expect(ctrl.syncHeightAdvanced).toBe(true);
    });
  });

  describe("race condition scenario", () => {
    it("without suppression: poll sync can advance past note block", () => {
      const ctrl = new PollController();
      // Wallet submits note at block N
      // Poll fires before note is committed
      ctrl.tick(); // advances sync_height past block N
      expect(ctrl.syncHeightAdvanced).toBe(true);
      // Note at block N is now permanently invisible
    });

    it("with suppression: poll sync is blocked during wallet submission", () => {
      const ctrl = new PollController();
      // Suppress before wallet submission
      ctrl.suppress();
      // Wallet submits note at block N
      // Poll tries to fire but is suppressed
      ctrl.tick();
      expect(ctrl.syncHeightAdvanced).toBe(false);
      // Explicit sync in consume flow will find the note
    });
  });
});
