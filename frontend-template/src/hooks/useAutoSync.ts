import { useEffect, useRef } from "react";
import { useSyncState } from "@miden-sdk/react";
import { AUTO_SYNC_INTERVAL_MS } from "@/config";

/**
 * Polls sync on an interval when it's the opponent's turn.
 * Pauses during the player's own turn.
 */
export function useAutoSync(
  enabled: boolean,
  refetchState: () => void,
) {
  const { sync } = useSyncState();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(async () => {
      try {
        await sync();
        refetchState();
      } catch {
        // Silently ignore sync errors — will retry on next interval
      }
    }, AUTO_SYNC_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, sync, refetchState]);
}
