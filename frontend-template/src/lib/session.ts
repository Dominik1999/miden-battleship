/**
 * The persisted game session: everything the UI needs to resume a game after a reload that
 * is not derivable from the client's own store (the client keeps the accounts and notes in
 * IndexedDB; see boot.tsx, which no longer wipes it).
 */
import { SESSION_STORAGE_KEY } from "@/config";
import type { PlayerRole, ShipCell } from "@/types/game";

export type ShotStatus = "pending" | "hit" | "miss";

export interface SessionShot {
  turn: number;
  row: number;
  col: number;
  status: ShotStatus;
}

export interface GameSession {
  version: 1;
  role: PlayerRole;
  /** My private game account. */
  myAddress: string;
  /** Seed of my game account (four felt values as decimal strings), carried in the handshake. */
  mySeed: string[];
  /** My wallet (local NoAuth wallet or the connected wallet). */
  myWallet: string;
  /** The opponent's game account; the starter learns it from the challenge note. */
  opponentAddress: string | null;
  /** The game id (four felt values as decimal strings); the joiner chooses it. */
  gameId: string[] | null;
  cells: ShipCell[];
  /** Stake in fee-asset base units as a decimal string ("0" = no stake). */
  stakeAmount: string;
  /** Shots I fired, in turn order. */
  shots: SessionShot[];
  /** Block timestamp after which my latest unanswered note can be reclaimed. */
  pendingDeadline: number | null;
  /** Id of the stake note my wallet published (null until published / no stake). */
  myStakeNoteId: string | null;
  /** The winner's wallet consumed the defeat/forfeit note (and the stakes). */
  claimed: boolean;
  createdAt: number;
}

export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): SessionStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSession(store: SessionStore | null = storage()): GameSession | null {
  try {
    const raw = store?.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GameSession>;
    if (parsed.version !== 1 || typeof parsed.myAddress !== "string" || !Array.isArray(parsed.cells)) return null;
    return parsed as GameSession;
  } catch {
    return null;
  }
}

export function saveSession(session: GameSession, store: SessionStore | null = storage()): void {
  try {
    store?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // storage unavailable (private mode, quota): the game still runs, it just does not resume
  }
}

export function clearSession(store: SessionStore | null = storage()): void {
  try {
    store?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export const valuesToStrings = (values: bigint[]): string[] => values.map((v) => v.toString());
export const stringsToValues = (strings: string[]): bigint[] => strings.map((s) => BigInt(s));
