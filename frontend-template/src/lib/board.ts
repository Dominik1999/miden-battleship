import { Felt, Word } from "@miden-sdk/miden-sdk";
import { GRID_SIZE, SLOT_BOARD_MAP } from "@/config";
import type { ShipCell } from "@/types/game";

/** Bits per cell in a packed board row (cell values 0..7). */
export const CELL_BITS = 3n;
const CELL_MASK = 0x7n;

/** Minimal shape of `account.storage()` needed to read the board map. */
export interface BoardStorageReader {
  getMapItem(slotName: string, key: Word): { toU64s(): ArrayLike<bigint> } | undefined;
}

/** Storage-map key for a board row: [0, 0, 0, row] (array layout used by the contract). */
export function boardRowKey(row: number): Word {
  return Word.newFromFelts([
    new Felt(0n),
    new Felt(0n),
    new Felt(0n),
    new Felt(BigInt(row)),
  ]);
}

/** Read one packed board row (first felt of the map value); missing rows are all water. */
export function readBoardRow(storage: BoardStorageReader, row: number): bigint {
  const value = storage.getMapItem(SLOT_BOARD_MAP, boardRowKey(row));
  return value ? BigInt(value.toU64s()[0] ?? 0n) : 0n;
}

/** Extract the 3-bit cell state at `col` from a packed row. */
export function getCellFromPacked(packed: bigint, col: number): number {
  return Number((packed >> (BigInt(col) * CELL_BITS)) & CELL_MASK);
}

/** Pack ship cells into GRID_SIZE row values (3 bits per cell, col 0 in bits 0-2). */
export function packBoard(shipCells: ShipCell[]): bigint[] {
  const rows: bigint[] = new Array(GRID_SIZE).fill(0n);
  for (const cell of shipCells) {
    rows[cell.row] |= BigInt(cell.shipId) << (BigInt(cell.col) * CELL_BITS);
  }
  return rows;
}
