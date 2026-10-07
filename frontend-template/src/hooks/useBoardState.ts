import { useMemo } from "react";
import { useAccount } from "@miden-sdk/react";
import { GRID_SIZE } from "@/config";
import { getCellFromPacked, readBoardRow } from "@/lib/board";
import type { Board, BoardCell, CellState } from "@/types/game";
import { CELL_HIT, CELL_MISS, CELL_WATER } from "@/types/game";

/** An all-water grid. */
export function emptyBoard(): Board {
  const grid: Board = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    const rowCells: BoardCell[] = [];
    for (let col = 0; col < GRID_SIZE; col++) rowCells.push({ row, col, state: CELL_WATER });
    grid.push(rowCells);
  }
  return grid;
}

/**
 * Reads the player's own board from the account's board map (one packed row per map entry)
 * and builds a 10x10 grid. In opponent mode only hits and misses are shown.
 */
export function useBoardState(accountId: string, isOpponent: boolean) {
  const { account } = useAccount(accountId || undefined);

  const board = useMemo<Board | null>(() => {
    if (!account) return isOpponent ? emptyBoard() : null;
    const storage = account.storage();
    const grid: Board = [];
    for (let row = 0; row < GRID_SIZE; row++) {
      const packed = readBoardRow(storage, row);
      const rowCells: BoardCell[] = [];
      for (let col = 0; col < GRID_SIZE; col++) {
        const rawState = getCellFromPacked(packed, col) as CellState;
        const state: CellState = isOpponent
          ? rawState === CELL_HIT || rawState === CELL_MISS ? rawState : CELL_WATER
          : rawState;
        rowCells.push({ row, col, state });
      }
      grid.push(rowCells);
    }
    return grid;
  }, [account, isOpponent]);

  return { board, isLoading: !account };
}
