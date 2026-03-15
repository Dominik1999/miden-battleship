import { Fragment } from "react";
import type { Board } from "@/types/game";
import { CELL_HIT, CELL_MISS } from "@/types/game";
import { Cell } from "./Cell";
import "./GameBoard.css";

const COL_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

interface GameBoardProps {
  board: Board;
  label: string;
  interactive?: boolean;
  onCellClick?: (row: number, col: number) => void;
}

export function GameBoard({
  board,
  label,
  interactive = false,
  onCellClick,
}: GameBoardProps) {
  return (
    <div className="game-board">
      <h3 className="board-label">{label}</h3>
      <div className="board-grid">
        {/* Column labels */}
        <div className="grid-corner" />
        {COL_LABELS.map((l) => (
          <div key={l} className="grid-label col-label">
            {l}
          </div>
        ))}

        {/* Rows */}
        {board.map((row, rowIdx) => (
          <Fragment key={`row-${rowIdx}`}>
            <div className="grid-label row-label">
              {rowIdx + 1}
            </div>
            {row.map((cell) => {
              const alreadyShot =
                cell.state === CELL_HIT || cell.state === CELL_MISS;
              const cellInteractive = interactive && !alreadyShot;
              return (
                <Cell
                  key={`${cell.row}-${cell.col}`}
                  state={cell.state}
                  interactive={cellInteractive}
                  onClick={
                    cellInteractive
                      ? () => onCellClick?.(cell.row, cell.col)
                      : undefined
                  }
                />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
