import { useState, useCallback, useEffect } from "react";
import { useMiden, useSyncState } from "@miden-sdk/react";
import { useGameSyncHeight } from "@/lib/syncHeight";
import type { ShipCell } from "@/types/game";
import { ShipPlacement } from "./ShipPlacement";
import { LobbyScreen } from "./LobbyScreen";
import { WaitingScreen } from "./WaitingScreen";
import { GamePlay } from "./GamePlay";
import { useStartGame } from "@/hooks/useStartGame";
import { useJoinGame } from "@/hooks/useJoinGame";
import "./AppContent.css";

type Screen = "lobby" | "placement" | "waiting" | "play";
type FlowMode = "start" | "join" | null;

function GameScreens() {
  const [screen, setScreen] = useState<Screen>("lobby");
  const [flowMode, setFlowMode] = useState<FlowMode>(null);
  const [joinTargetId, setJoinTargetId] = useState<string | null>(null);

  const start = useStartGame();
  const join = useJoinGame();

  const handleStartGame = useCallback(() => {
    setFlowMode("start");
    setScreen("placement");
  }, []);

  const handleJoinGame = useCallback((gameId: string) => {
    setFlowMode("join");
    setJoinTargetId(gameId);
    setScreen("placement");
  }, []);

  const handlePlacementConfirm = useCallback(
    async (cells: ShipCell[]) => {
      setScreen("waiting");
      if (flowMode === "start") {
        await start.startGame(cells);
      } else if (flowMode === "join" && joinTargetId) {
        await join.joinGame(joinTargetId, cells);
      }
    },
    [flowMode, joinTargetId, start, join],
  );

  useEffect(() => {
    if (flowMode === "start" && start.stage === "ready") setScreen("play");
  }, [flowMode, start.stage]);

  useEffect(() => {
    if (flowMode === "join" && join.stage === "ready") setScreen("play");
  }, [flowMode, join.stage]);

  // The joiner is the challenger (fires first); the starter is the acceptor.
  const gameConfig = (() => {
    if (flowMode === "start" && start.gameAccountAddress && start.opponentAddress) {
      return { accountA: start.opponentAddress, accountB: start.gameAccountAddress, role: "acceptor" as const, commitment: start.commitment };
    }
    if (flowMode === "join" && join.gameAccountAddress && join.starterAddress) {
      return { accountA: join.gameAccountAddress, accountB: join.starterAddress, role: "challenger" as const, commitment: join.commitment };
    }
    return null;
  })();

  const flow = flowMode === "start" ? start : join;

  return (
    <>
      {screen === "lobby" && <LobbyScreen onStartGame={handleStartGame} onJoinGame={handleJoinGame} />}

      {screen === "placement" && <ShipPlacement onConfirm={handlePlacementConfirm} />}

      {screen === "waiting" && (
        <WaitingScreen
          gameId={flowMode === "start" ? start.gameAccountAddress : joinTargetId}
          isStarter={flowMode === "start"}
          stage={flow.stage}
          status={flow.status}
          error={flow.error}
        />
      )}

      {screen === "play" && gameConfig && (
        <GamePlay accountA={gameConfig.accountA} accountB={gameConfig.accountB} playerRole={gameConfig.role} commitment={gameConfig.commitment} />
      )}
    </>
  );
}

export function AppContent() {
  const { isReady, isInitializing, error } = useMiden();
  const { syncHeight: providerHeight } = useSyncState();
  const gameHeight = useGameSyncHeight();
  const syncHeight = gameHeight ?? providerHeight;

  const clientReady = isReady && !isInitializing;

  return (
    <>
      <h1 className="game-title">Miden Battleship</h1>

      {error && (
        <div className="loading">
          <p>Failed to initialize Miden client</p>
          <p className="error">{error.message}</p>
        </div>
      )}

      {!error && !clientReady && <div className="loading">Initializing Miden client...</div>}

      {clientReady && <GameScreens />}

      <p className="footer-info">Block: {syncHeight ?? "syncing..."}</p>
    </>
  );
}
