import type { CellState } from "@/types/game";
import { CELL_WATER, CELL_HIT, CELL_MISS } from "@/types/game";
import "./Cell.css";

interface CellProps {
  state: CellState;
  interactive: boolean;
  onClick?: () => void;
}

function cellClassName(state: CellState, interactive: boolean): string {
  const classes = ["cell"];
  if (state === CELL_WATER) classes.push("cell-water");
  else if (state === CELL_HIT) classes.push("cell-hit");
  else if (state === CELL_MISS) classes.push("cell-miss");
  else if (state >= 1 && state <= 5) classes.push("cell-ship");
  if (interactive) classes.push("cell-interactive");
  return classes.join(" ");
}

export function Cell({ state, interactive, onClick }: CellProps) {
  return (
    <button
      className={cellClassName(state, interactive)}
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      aria-label={`Cell ${state === CELL_HIT ? "hit" : state === CELL_MISS ? "miss" : state >= 1 && state <= 5 ? "ship" : "water"}`}
    />
  );
}
