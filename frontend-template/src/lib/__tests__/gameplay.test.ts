import { describe, it, expect } from "vitest";
import { formatCountdown } from "@/lib/gameplay";

describe("formatCountdown", () => {
  it("formats hours and minutes, then minutes and seconds, and null once passed", () => {
    expect(formatCountdown(43_200, 0)).toBe("12h 0m");
    expect(formatCountdown(5_000, 4_000)).toBe("16m 40s");
    expect(formatCountdown(10, 10)).toBeNull();
  });
});
