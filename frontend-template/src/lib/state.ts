import {
  SLOT_GAME_CONFIG,
  SLOT_LAST_SHOT,
  SLOT_OPPONENT,
  SLOT_OPPONENT_WALLET,
  SLOT_OUTCOME,
  SLOT_OWNER_WALLET,
  SLOT_TURN_STATE,
} from "@/config";
import type { GamePhase, GameState, Outcome } from "@/types/game";

/** Minimal storage shape read by `readGameState` (matches `account.storage()`). */
export interface GameStorageReader {
  getItem(slotName: string): { toU64s(): ArrayLike<bigint> } | undefined;
}

function wallet(values: ArrayLike<bigint> | undefined): [bigint, bigint] | null {
  if (!values || values[0] === 0n) return null;
  return [values[0], values[1]];
}

/** Parses the game state from a game account's storage; null until the slots exist. */
export function readGameState(storage: GameStorageReader): GameState | null {
  const config = storage.getItem(SLOT_GAME_CONFIG);
  const opponent = storage.getItem(SLOT_OPPONENT);
  if (!config || !opponent) return null;
  const configValues = config.toU64s();
  const opponentValues = opponent.toU64s();
  const turn = storage.getItem(SLOT_TURN_STATE)?.toU64s();
  const lastShot = storage.getItem(SLOT_LAST_SHOT)?.toU64s();
  const outcome = storage.getItem(SLOT_OUTCOME)?.toU64s();
  return {
    phase: Number(configValues[2]) as GamePhase,
    expectedTurn: Number(configValues[3]),
    shipsHitCount: Number(opponentValues[2]),
    totalShotsReceived: Number(opponentValues[3]),
    shotsFired: turn ? Number(turn[0]) : 0,
    resultsProcessed: turn ? Number(turn[1]) : 0,
    role: turn ? Number(turn[2]) : 0,
    lastShot: lastShot ? { row: Number(lastShot[0]), col: Number(lastShot[1]), turn: Number(lastShot[2]) } : { row: 0, col: 0, turn: 0 },
    outcome: (outcome ? Number(outcome[0]) : 0) as Outcome,
    ownerWallet: wallet(storage.getItem(SLOT_OWNER_WALLET)?.toU64s()),
    opponentWallet: wallet(storage.getItem(SLOT_OPPONENT_WALLET)?.toU64s()),
  };
}
