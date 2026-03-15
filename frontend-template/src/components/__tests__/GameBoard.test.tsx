import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Board, BoardCell } from "@/types/game";
import { CELL_WATER, CELL_HIT, CELL_MISS } from "@/types/game";
import { GameBoard } from "../GameBoard";

function createBoard(overrides?: Record<string, number>): Board {
  const board: Board = [];
  for (let row = 0; row < 10; row++) {
    const rowCells: BoardCell[] = [];
    for (let col = 0; col < 10; col++) {
      const key = `${row},${col}`;
      rowCells.push({
        row,
        col,
        state: (overrides?.[key] ?? CELL_WATER) as BoardCell["state"],
      });
    }
    board.push(rowCells);
  }
  return board;
}

describe("GameBoard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders 100 cells", () => {
    const board = createBoard();
    render(<GameBoard board={board} label="Test Board" />);
    const cells = screen.getAllByRole("button");
    expect(cells).toHaveLength(100);
  });

  it("renders column and row labels", () => {
    const board = createBoard();
    render(<GameBoard board={board} label="Test Board" />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("J")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
  });

  it("renders the board label", () => {
    const board = createBoard();
    render(<GameBoard board={board} label="Your Fleet" />);
    expect(screen.getByText("Your Fleet")).toBeInTheDocument();
  });

  it("calls onCellClick when an interactive cell is clicked", async () => {
    const board = createBoard();
    const handleClick = vi.fn();
    render(
      <GameBoard
        board={board}
        label="Test"
        interactive
        onCellClick={handleClick}
      />,
    );

    const user = userEvent.setup();
    const cells = screen.getAllByRole("button");
    await user.click(cells[0]); // row 0, col 0
    expect(handleClick).toHaveBeenCalledWith(0, 0);
  });

  it("does not fire click on already-hit cells", async () => {
    const board = createBoard({ "0,0": CELL_HIT });
    const handleClick = vi.fn();
    render(
      <GameBoard
        board={board}
        label="Test"
        interactive
        onCellClick={handleClick}
      />,
    );

    const user = userEvent.setup();
    const hitCell = screen.getAllByRole("button")[0];
    await user.click(hitCell);
    expect(handleClick).not.toHaveBeenCalled();
  });

  it("does not fire click on miss cells", async () => {
    const board = createBoard({ "0,0": CELL_MISS });
    const handleClick = vi.fn();
    render(
      <GameBoard
        board={board}
        label="Test"
        interactive
        onCellClick={handleClick}
      />,
    );

    const user = userEvent.setup();
    const missCell = screen.getAllByRole("button")[0];
    await user.click(missCell);
    expect(handleClick).not.toHaveBeenCalled();
  });
});
