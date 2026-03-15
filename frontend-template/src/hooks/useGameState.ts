import { useMemo, useEffect, useRef } from "react";
import { useAccount, useImportAccount, useSyncState } from "@miden-sdk/react";
// SDK types used at runtime via account.storage() — no direct constructor usage needed here
import { SLOT_GAME_CONFIG, SLOT_OPPONENT } from "@/config";
import type { GamePhase, GameState } from "@/types/game";

export function useGameState(accountId: string, skipImport = false) {
  const { importAccount } = useImportAccount();
  const { account, refetch } = useAccount(accountId);
  const { sync } = useSyncState();

  // Import the game account so the local client tracks it.
  // Guard with a ref to only attempt once per accountId, preventing
  // concurrent WASM access when two useGameState hooks mount together.
  // skipImport=true for opponent accounts that can't be imported from network.
  const importedRef = useRef<string | null>(null);
  useEffect(() => {
    if (skipImport) return;
    if (!accountId || importedRef.current === accountId) return;
    importedRef.current = accountId;
    // Small delay to avoid racing with the other useGameState instance
    const timer = setTimeout(() => {
      importAccount({ type: "id", accountId }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [importAccount, accountId, skipImport]);

  const gameState = useMemo<GameState | null>(() => {
    if (!account) return null;

    const config = account.storage().getItem(SLOT_GAME_CONFIG);
    const opponent = account.storage().getItem(SLOT_OPPONENT);

    if (!config || !opponent) return null;

    const configValues = config.toU64s();
    const opponentValues = opponent.toU64s();

    return {
      phase: Number(configValues[2]) as GamePhase,
      expectedTurn: Number(configValues[3]),
      shipsHitCount: Number(opponentValues[2]),
      totalShotsReceived: Number(opponentValues[3]),
    };
  }, [account]);

  return { gameState, isLoading: !account, refetch, sync };
}
