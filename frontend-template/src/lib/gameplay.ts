import { emptyBoard } from "@/hooks/useBoardState";
import type { SessionShot } from "@/lib/session";
import { CELL_HIT, CELL_MISS, type Board } from "@/types/game";

/** The enemy board as seen from my shot log (the opponent's account is private). */
export function buildEnemyBoard(shots: SessionShot[]): Board {
  const board = emptyBoard();
  for (const shot of shots) {
    if (shot.status === "hit") board[shot.row][shot.col].state = CELL_HIT;
    else if (shot.status === "miss") board[shot.row][shot.col].state = CELL_MISS;
  }
  return board;
}

/** "11h 59m" style countdown; null when the deadline has passed. */
export function formatCountdown(deadline: number, now: number): string | null {
  const remaining = deadline - now;
  if (remaining <= 0) return null;
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${remaining % 60}s`;
}
