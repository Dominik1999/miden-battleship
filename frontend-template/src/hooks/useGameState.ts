import { useMemo } from "react";
import { useAccount, useSyncState } from "@miden-sdk/react";
import { readGameState } from "@/lib/state";
import type { GameState } from "@/types/game";

export { readGameState } from "@/lib/state";
export type { GameStorageReader } from "@/lib/state";

/** Game state of a locally tracked game account (null for untracked accounts, e.g. the opponent). */
export function useGameState(accountId: string) {
  const { account, refetch } = useAccount(accountId || undefined);
  const { sync } = useSyncState();
  const gameState = useMemo<GameState | null>(() => (account ? readGameState(account.storage()) : null), [account]);
  return { gameState, isLoading: !account, refetch, sync };
}
