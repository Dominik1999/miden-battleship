import { useMemo } from "react";
import { useAccount, useSyncState } from "@miden-sdk/react";
import { SLOT_GAME_CONFIG, SLOT_OPPONENT, SLOT_REVEAL_STATUS } from "@/config";
import type { GamePhase, GameState } from "@/types/game";

/** Minimal storage shape read by `readGameState` (matches `account.storage()`). */
export interface GameStorageReader {
  getItem(slotName: string): { toU64s(): ArrayLike<bigint> } | undefined;
}

/** Parses the game state from a game account's storage; null until the slots exist. */
export function readGameState(storage: GameStorageReader): GameState | null {
  const config = storage.getItem(SLOT_GAME_CONFIG);
  const opponent = storage.getItem(SLOT_OPPONENT);
  if (!config || !opponent) return null;
  const configValues = config.toU64s();
  const opponentValues = opponent.toU64s();
  const reveal = storage.getItem(SLOT_REVEAL_STATUS)?.toU64s();
  return {
    phase: Number(configValues[2]) as GamePhase,
    expectedTurn: Number(configValues[3]),
    shipsHitCount: Number(opponentValues[2]),
    totalShotsReceived: Number(opponentValues[3]),
    myRevealed: reveal ? Number(reveal[0]) : 0,
    opponentVerified: reveal ? Number(reveal[1]) : 0,
  };
}

/** Game state of a locally tracked game account (null for untracked accounts, e.g. the opponent). */
export function useGameState(accountId: string) {
  const { account, refetch } = useAccount(accountId || undefined);
  const { sync } = useSyncState();
  const gameState = useMemo<GameState | null>(() => (account ? readGameState(account.storage()) : null), [account]);
  return { gameState, isLoading: !account, refetch, sync };
}
