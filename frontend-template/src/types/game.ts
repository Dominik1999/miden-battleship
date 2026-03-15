/** Cell states matching the contract's storage values */
export const CELL_WATER = 0;
export const CELL_SHIP_1 = 1; // Carrier
export const CELL_SHIP_2 = 2; // Battleship
export const CELL_SHIP_3 = 3; // Cruiser
export const CELL_SHIP_4 = 4; // Submarine
export const CELL_SHIP_5 = 5; // Destroyer
export const CELL_HIT = 6;
export const CELL_MISS = 7;

export type CellState = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Game phases matching contract constants */
export const PHASE_CREATED = 0;
export const PHASE_CHALLENGED = 1;
export const PHASE_ACTIVE = 2;
export const PHASE_REVEAL = 3;
export const PHASE_COMPLETE = 4;

export type GamePhase = 0 | 1 | 2 | 3 | 4;

export interface GameState {
  phase: GamePhase;
  expectedTurn: number;
  shipsHitCount: number;
  totalShotsReceived: number;
}

export interface BoardCell {
  row: number;
  col: number;
  state: CellState;
}

export type Board = BoardCell[][];

/** Which player role this client represents */
export type PlayerRole = "challenger" | "acceptor";

/** A placed ship cell: row, col, and which ship it belongs to */
export interface ShipCell {
  row: number;
  col: number;
  shipId: number; // 1–5 matching CELL_SHIP_1–CELL_SHIP_5
}

/** Ship definition for placement UI */
export interface ShipDef {
  id: number;
  name: string;
  size: number;
}

export const SHIPS: ShipDef[] = [
  { id: 1, name: "Carrier", size: 5 },
  { id: 2, name: "Battleship", size: 4 },
  { id: 3, name: "Cruiser", size: 3 },
  { id: 4, name: "Submarine", size: 3 },
  { id: 5, name: "Destroyer", size: 2 },
];
