import type { Board, PlayerRole } from "@/types/game";
import { CELL_HIT, CELL_MISS } from "@/types/game";
import { emptyBoard } from "@/hooks/useBoardState";

export interface FiredShot {
  row: number;
  col: number;
  status: "pending" | "hit" | "miss";
}

/** The enemy board as seen from my shot log (the opponent's account is not tracked locally). */
export function buildEnemyBoard(shots: Map<number, FiredShot>): Board {
  const board = emptyBoard();
  for (const shot of shots.values()) {
    if (shot.status === "hit") board[shot.row][shot.col].state = CELL_HIT;
    else if (shot.status === "miss") board[shot.row][shot.col].state = CELL_MISS;
  }
  return board;
}

/**
 * Turn convention: the challenger (joiner) fires odd turns 1, 3, 5...; the acceptor (starter)
 * fires even turns 2, 4, 6... `totalShotsReceived` on my account counts the opponent's shots,
 * so my next shot is the one after the last shot I received.
 */
export function nextShotTurn(role: PlayerRole, totalShotsReceived: number): number {
  return role === "challenger" ? 2 * totalShotsReceived + 1 : 2 * totalShotsReceived;
}
