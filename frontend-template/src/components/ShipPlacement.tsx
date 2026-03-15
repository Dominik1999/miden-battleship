import { useState, useCallback, useMemo } from "react";
import { GRID_SIZE } from "@/config";
import { SHIPS, type ShipCell, type ShipDef } from "@/types/game";
import "./ShipPlacement.css";

interface ShipPlacementProps {
  onConfirm: (cells: ShipCell[]) => void;
}

type Orientation = "horizontal" | "vertical";

interface PlacedShip {
  def: ShipDef;
  row: number;
  col: number;
  orientation: Orientation;
}

function getShipCells(ship: PlacedShip): ShipCell[] {
  const cells: ShipCell[] = [];
  for (let i = 0; i < ship.def.size; i++) {
    cells.push({
      row: ship.orientation === "vertical" ? ship.row + i : ship.row,
      col: ship.orientation === "horizontal" ? ship.col + i : ship.col,
      shipId: ship.def.id,
    });
  }
  return cells;
}

function isInBounds(ship: PlacedShip): boolean {
  const endRow =
    ship.orientation === "vertical" ? ship.row + ship.def.size - 1 : ship.row;
  const endCol =
    ship.orientation === "horizontal" ? ship.col + ship.def.size - 1 : ship.col;
  return endRow < GRID_SIZE && endCol < GRID_SIZE;
}

function overlaps(ship: PlacedShip, placed: PlacedShip[]): boolean {
  const newCells = getShipCells(ship);
  const existing = new Set(
    placed.flatMap(getShipCells).map((c) => `${c.row},${c.col}`),
  );
  return newCells.some((c) => existing.has(`${c.row},${c.col}`));
}

function randomLayout(): PlacedShip[] {
  const placed: PlacedShip[] = [];
  for (const def of SHIPS) {
    for (let attempts = 0; attempts < 200; attempts++) {
      const orientation: Orientation =
        Math.random() < 0.5 ? "horizontal" : "vertical";
      const maxRow =
        orientation === "vertical" ? GRID_SIZE - def.size : GRID_SIZE - 1;
      const maxCol =
        orientation === "horizontal" ? GRID_SIZE - def.size : GRID_SIZE - 1;
      const row = Math.floor(Math.random() * (maxRow + 1));
      const col = Math.floor(Math.random() * (maxCol + 1));
      const ship: PlacedShip = { def, row, col, orientation };
      if (!overlaps(ship, placed)) {
        placed.push(ship);
        break;
      }
    }
  }
  return placed;
}

const COL_LABELS = "ABCDEFGHIJ".split("");

export function ShipPlacement({ onConfirm }: ShipPlacementProps) {
  const [placedShips, setPlacedShips] = useState<PlacedShip[]>([]);
  const [selectedShipId, setSelectedShipId] = useState<number | null>(
    SHIPS[0].id,
  );
  const [orientation, setOrientation] = useState<Orientation>("horizontal");

  // Build cell → shipId map for rendering
  const cellMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const ship of placedShips) {
      for (const cell of getShipCells(ship)) {
        map.set(`${cell.row},${cell.col}`, cell.shipId);
      }
    }
    return map;
  }, [placedShips]);

  const placedIds = useMemo(
    () => new Set(placedShips.map((s) => s.def.id)),
    [placedShips],
  );

  const selectedDef = SHIPS.find((s) => s.id === selectedShipId) ?? null;

  const allPlaced = placedShips.length === SHIPS.length;

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      // If clicking an already-placed ship, remove it
      const key = `${row},${col}`;
      const existing = placedShips.find((s) =>
        getShipCells(s).some((c) => `${c.row},${c.col}` === key),
      );
      if (existing) {
        setPlacedShips((prev) => prev.filter((s) => s !== existing));
        setSelectedShipId(existing.def.id);
        return;
      }

      if (!selectedDef || placedIds.has(selectedDef.id)) return;

      const ship: PlacedShip = { def: selectedDef, row, col, orientation };
      if (!isInBounds(ship) || overlaps(ship, placedShips)) return;

      setPlacedShips((prev) => [...prev, ship]);

      // Auto-select next unplaced ship
      const nextShip = SHIPS.find(
        (s) => s.id !== selectedDef.id && !placedIds.has(s.id),
      );
      setSelectedShipId(nextShip?.id ?? null);
    },
    [placedShips, selectedDef, placedIds, orientation],
  );

  const handleRandomize = useCallback(() => {
    setPlacedShips(randomLayout());
    setSelectedShipId(null);
  }, []);

  const handleClear = useCallback(() => {
    setPlacedShips([]);
    setSelectedShipId(SHIPS[0].id);
  }, []);

  const handleConfirm = useCallback(() => {
    if (!allPlaced) return;
    const cells = placedShips.flatMap(getShipCells);
    onConfirm(cells);
  }, [allPlaced, placedShips, onConfirm]);

  // Preview cells for hover (computed in render for simplicity)
  const [hoverCell, setHoverCell] = useState<{ row: number; col: number } | null>(null);
  const previewCells = useMemo(() => {
    if (!hoverCell || !selectedDef || placedIds.has(selectedDef.id)) return new Set<string>();
    const ship: PlacedShip = { def: selectedDef, ...hoverCell, orientation };
    if (!isInBounds(ship) || overlaps(ship, placedShips)) return new Set<string>();
    return new Set(getShipCells(ship).map((c) => `${c.row},${c.col}`));
  }, [hoverCell, selectedDef, placedIds, orientation, placedShips]);

  return (
    <div className="ship-placement">
      <h2>Place Your Ships</h2>

      <div className="placement-layout">
        <div className="placement-grid-wrapper">
          <div className="placement-grid">
            {/* Column labels */}
            <div className="placement-corner" />
            {COL_LABELS.map((l) => (
              <div key={l} className="placement-col-label">{l}</div>
            ))}

            {Array.from({ length: GRID_SIZE }, (_, row) => (
              <div key={row} className="placement-row">
                <div className="placement-row-label">{row + 1}</div>
                {Array.from({ length: GRID_SIZE }, (_, col) => {
                  const key = `${row},${col}`;
                  const shipId = cellMap.get(key);
                  const isPreview = previewCells.has(key);
                  return (
                    <button
                      key={key}
                      className={[
                        "placement-cell",
                        shipId ? `ship-${shipId}` : "",
                        isPreview ? "preview" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => handleCellClick(row, col)}
                      onMouseEnter={() => setHoverCell({ row, col })}
                      onMouseLeave={() => setHoverCell(null)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="ship-palette">
          <h3>Ships</h3>
          {SHIPS.map((ship) => {
            const isPlaced = placedIds.has(ship.id);
            const isSelected = selectedShipId === ship.id;
            return (
              <button
                key={ship.id}
                className={[
                  "ship-option",
                  isPlaced ? "placed" : "",
                  isSelected ? "selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => !isPlaced && setSelectedShipId(ship.id)}
                disabled={isPlaced}
              >
                <span className="ship-name">{ship.name}</span>
                <span className="ship-dots">
                  {"■".repeat(ship.size)}
                </span>
              </button>
            );
          })}

          <button
            className="orientation-btn"
            onClick={() =>
              setOrientation((o) =>
                o === "horizontal" ? "vertical" : "horizontal",
              )
            }
          >
            ↻ {orientation === "horizontal" ? "Horizontal" : "Vertical"}
          </button>

          <div className="placement-actions">
            <button className="action-btn" onClick={handleRandomize}>
              Randomize
            </button>
            <button
              className="action-btn"
              onClick={handleClear}
              disabled={placedShips.length === 0}
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      <button
        className="start-game-btn"
        onClick={handleConfirm}
        disabled={!allPlaced}
      >
        {allPlaced ? "Start Game" : `Place all ships (${placedShips.length}/${SHIPS.length})`}
      </button>
    </div>
  );
}
