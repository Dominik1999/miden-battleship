import { useMemo } from "react";
import { useMiden, useMidenClient } from "@miden-sdk/react";
import { getContractCompiler } from "@/lib/contracts";
import type { GameClient, GameContext } from "@/lib/game";

/**
 * The raw client, the (cached) MASM compiler and the prover, bundled for the game
 * flow helpers in `@/lib/game`. `runExclusive` serializes WASM access.
 */
export function useGameContext() {
  const client = useMidenClient();
  const { runExclusive, prover } = useMiden();
  return useMemo(() => {
    const gameClient = client as unknown as GameClient;
    const base: GameContext = { client: gameClient, compiler: getContractCompiler(client), prover };
    return {
      client,
      runExclusive,
      /** A context reporting progress through `onStatus`, cancellable through `signal`. */
      context: (onStatus?: (status: string) => void, signal?: AbortSignal): GameContext => ({ ...base, onStatus, signal }),
    };
  }, [client, runExclusive, prover]);
}
