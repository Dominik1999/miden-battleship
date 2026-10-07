import { useSyncExternalStore } from "react";

/**
 * Latest block height seen by any sync the game flow performs. The game libraries call the
 * raw client's `syncState()` (inside `runExclusive`), which bypasses the provider's own sync
 * state, so the height is published here for the UI.
 */
let height: number | null = null;
const listeners = new Set<() => void>();

export function publishSyncHeight(blockNum: number): void {
  if (blockNum === height) return;
  height = blockNum;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGameSyncHeight(): number | null {
  return useSyncExternalStore(subscribe, () => height, () => height);
}
