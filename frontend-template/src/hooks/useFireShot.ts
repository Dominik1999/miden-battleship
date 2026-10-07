import { useState, useCallback } from "react";
import { publishShot } from "@/lib/game";
import { useGameContext } from "@/hooks/useGameContext";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[FireShot] ${msg}`, "color: #f60; font-weight: bold", ...args);

/** Publishes a shot note from the player's game account to the defender's (no wallet popup). */
export function useFireShot(myAddress: string, defenderAddress: string) {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { runExclusive, context } = useGameContext();

  const fireShot = useCallback(
    async (row: number, col: number, turn: number): Promise<boolean> => {
      setError(null);
      setIsSubmitting(true);
      log(`Firing at (${row}, ${col}), turn ${turn} → ${defenderAddress}`);
      try {
        await runExclusive(() => publishShot(context(), myAddress, defenderAddress, row, col, turn));
        log("Shot committed");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Shot FAILED: ${msg}`);
        setError(msg);
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [myAddress, defenderAddress, runExclusive, context],
  );

  return { fireShot, isSubmitting, error };
}
