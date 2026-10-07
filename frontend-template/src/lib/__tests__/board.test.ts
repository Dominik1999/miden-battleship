import { describe, it, expect, vi } from "vitest";

vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));

import { boardRowKey, getCellFromPacked, packBoard, readBoardRow } from "@/lib/board";
import { createMockGameStorage } from "@/__tests__/fixtures/battleship";

describe("board packing", () => {
  it("packs ship cells 3 bits per column", () => {
    const rows = packBoard([
      { row: 0, col: 0, shipId: 1 },
      { row: 0, col: 1, shipId: 1 },
      { row: 4, col: 9, shipId: 5 },
    ]);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toBe(1n | (1n << 3n));
    expect(rows[4]).toBe(5n << 27n);
    expect(getCellFromPacked(rows[0], 1)).toBe(1);
    expect(getCellFromPacked(rows[4], 9)).toBe(5);
    expect(getCellFromPacked(rows[4], 8)).toBe(0);
  });

  it("uses the array layout key [0, 0, 0, row]", () => {
    expect(boardRowKey(7).toU64s()).toEqual([0n, 0n, 0n, 7n]);
  });

  it("reads packed rows from the board map, missing rows are water", () => {
    const storage = createMockGameStorage({
      phase: 2,
      expectedTurn: 1,
      shipsHitCount: 0,
      totalShotsReceived: 0,
      boardCells: new Map([["2,3", 6]]),
    });
    expect(getCellFromPacked(readBoardRow(storage, 2), 3)).toBe(6);
    expect(readBoardRow(storage, 5)).toBe(0n);
  });
});
