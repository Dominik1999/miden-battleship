import { useCallback, useMemo, useState } from "react";
import { clearSession, loadSession, saveSession, type GameSession } from "@/lib/session";

/**
 * The persisted session (see lib/session.ts) as React state: loaded once, every update written
 * through. The hooks keep the on-chain state authoritative; the session only carries what the
 * chain does not know (my seed, my ship cells, my shot log, the stake tier).
 */
export function useGameSession() {
  const [session, setSession] = useState<GameSession | null>(() => loadSession());

  const start = useCallback((next: GameSession) => {
    saveSession(next);
    setSession(next);
  }, []);

  const update = useCallback((patch: Partial<GameSession> | ((current: GameSession) => Partial<GameSession>)) => {
    setSession((current) => {
      if (!current) return current;
      const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
      saveSession(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  return useMemo(() => ({ session, start, update, clear }), [session, start, update, clear]);
}

export type SessionActions = ReturnType<typeof useGameSession>;
