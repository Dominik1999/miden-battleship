import { useMemo } from "react";
import { useAccount } from "@miden-sdk/react";
import { Felt, Word } from "@miden-sdk/miden-sdk";
import { SLOT_BOARD, GRID_SIZE } from "@/config";
import type { Board, BoardCell, CellState } from "@/types/game";
import { CELL_HIT, CELL_MISS, CELL_WATER } from "@/types/game";

/**
 * Reads the board StorageMap for a game account and builds a 10x10 grid.
 * In opponent mode, ship cells are hidden (shown as CELL_WATER unless hit/miss).
 */
export function useBoardState(accountId: string, isOpponent: boolean) {
  const { account } = useAccount(accountId);

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
      for (let col = 0; col < GRID_SIZE; col++) {
        const key = Word.newFromFelts([
          new Felt(0n),
          new Felt(0n),
          new Felt(BigInt(row)),
          new Felt(BigInt(col)),
        ]);
        const value = account.storage().getMapItem(SLOT_BOARD, key);
        let state: CellState = CELL_WATER;

        if (value) {
          const rawState = Number(value.toU64s()[3]) as CellState;
          if (isOpponent) {
            // Hide ship positions — only show hits and misses
            state =
              rawState === CELL_HIT || rawState === CELL_MISS
                ? rawState
                : CELL_WATER;
          } else {
            state = rawState;
          }
        }

        rowCells.push({ row, col, state });
      }
      grid.push(rowCells);
    }

    return grid;
  }, [account, isOpponent]);

  return { board, isLoading: !account };
}
