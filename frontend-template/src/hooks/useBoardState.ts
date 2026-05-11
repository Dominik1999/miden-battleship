import { useMemo } from "react";
import { useAccount } from "@miden-sdk/react";
import { SLOT_BOARD_ROWS, GRID_SIZE } from "@/config";
import type { Board, BoardCell, CellState } from "@/types/game";
import { CELL_HIT, CELL_MISS, CELL_WATER } from "@/types/game";

function getCellFromPacked(packed: bigint, col: number): number {
  return Number((packed >> (BigInt(col) * 3n)) & 0x7n);
}

/**
 * Reads the board from packed StorageValue rows and builds a 10x10 grid.
 * In opponent mode, ship cells are hidden (shown as CELL_WATER unless hit/miss).
 */
export function useBoardState(accountId: string, isOpponent: boolean) {
  // When isOpponent=true, pass undefined to useAccount to prevent background
  // WASM queries that race with gameplay sync operations. Opponent boards show
  // all-water anyway (we can't read their storage).
  const { account } = useAccount(isOpponent ? undefined : accountId);

  const board = useMemo<Board | null>(() => {
    // For opponent boards, return an empty (all water) grid if the account
    // isn't available locally. We can't import the opponent's account
    // reliably, and their board is hidden anyway.
    if (!account && isOpponent) {
      const grid: Board = [];
      for (let row = 0; row < GRID_SIZE; row++) {
        const rowCells: BoardCell[] = [];
        for (let col = 0; col < GRID_SIZE; col++) {
          rowCells.push({ row, col, state: CELL_WATER });
        }
        grid.push(rowCells);
      }
      return grid;
    }
    if (!account) return null;

    const grid: Board = [];
    for (let row = 0; row < GRID_SIZE; row++) {
      const rowCells: BoardCell[] = [];
      const rowWord = account.storage().getItem(SLOT_BOARD_ROWS[row]);
      const packed = rowWord ? rowWord.toU64s()[0] : 0n;

      for (let col = 0; col < GRID_SIZE; col++) {
        const rawState = getCellFromPacked(packed, col) as CellState;
        let state: CellState = CELL_WATER;
        if (isOpponent) {
          state = rawState === CELL_HIT || rawState === CELL_MISS ? rawState : CELL_WATER;
        } else {
          state = rawState;
        }
        rowCells.push({ row, col, state });
      }
      grid.push(rowCells);
    }
    return grid;
  }, [account, isOpponent]);

  return { board, isLoading: !account };
}
