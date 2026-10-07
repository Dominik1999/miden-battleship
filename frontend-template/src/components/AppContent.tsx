import { useState, useCallback, useEffect } from "react";
import { useMiden, useSyncState } from "@miden-sdk/react";
import { useGameSyncHeight } from "@/lib/syncHeight";
import type { ShipCell } from "@/types/game";
import { ShipPlacement } from "./ShipPlacement";
import { LobbyScreen } from "./LobbyScreen";
import { WaitingScreen } from "./WaitingScreen";
import { GamePlay } from "./GamePlay";
import { useGameSession } from "@/hooks/useGameSession";
import { useStartGame } from "@/hooks/useStartGame";
import { useJoinGame } from "@/hooks/useJoinGame";
import "./AppContent.css";

type Screen = "lobby" | "placement" | "waiting" | "play";
type FlowMode = "start" | "join" | null;

function GameScreens() {
  const session = useGameSession();
  const [screen, setScreen] = useState<Screen>("lobby");
  const [flowMode, setFlowMode] = useState<FlowMode>(null);
  const [joinTargetId, setJoinTargetId] = useState<string | null>(null);
  const [stakeAmount, setStakeAmount] = useState<bigint>(0n);

  const start = useStartGame(session);
  const join = useJoinGame(session);

  const handleStartGame = useCallback((stake: bigint) => {
    setStakeAmount(stake);
    setFlowMode("start");
    setScreen("placement");
  }, []);

  const handleJoinGame = useCallback((gameId: string, stake: bigint) => {
    setStakeAmount(stake);
    setFlowMode("join");
    setJoinTargetId(gameId);
    setScreen("placement");
  }, []);

  const handlePlacementConfirm = useCallback(
    async (cells: ShipCell[]) => {
      setScreen("waiting");
      if (flowMode === "start") {
        await start.startGame(cells, stakeAmount);
      } else if (flowMode === "join" && joinTargetId) {
        await join.joinGame(joinTargetId, cells, stakeAmount);
      }
    },
    [flowMode, joinTargetId, stakeAmount, start, join],
  );

  const handleResume = useCallback(() => {
    const s = session.session;
    if (!s) return;
    setScreen("waiting");
    if (s.role === "acceptor") {
      setFlowMode("start");
      start.resume(s);
    } else {
      setFlowMode("join");
      setJoinTargetId(s.opponentAddress);
      void join.resume(s);
    }
  }, [session.session, start, join]);

  const handleNewGame = useCallback(() => {
    session.clear();
    setFlowMode(null);
    setScreen("lobby");
  }, [session]);

  useEffect(() => {
    if (flowMode === "start" && start.stage === "ready") setScreen("play");
  }, [flowMode, start.stage]);

  useEffect(() => {
    if (flowMode === "join" && join.stage === "ready") setScreen("play");
  }, [flowMode, join.stage]);

  // The joiner is the challenger (fires first); the starter is the acceptor.
  const gameConfig = (() => {
    if (flowMode === "start" && start.gameAccountAddress && start.opponentAddress) {
      return { myAccount: start.gameAccountAddress, opponentAccount: start.opponentAddress, role: "acceptor" as const };
    }
    if (flowMode === "join" && join.gameAccountAddress && join.starterAddress) {
      return { myAccount: join.gameAccountAddress, opponentAccount: join.starterAddress, role: "challenger" as const };
    }
    return null;
  })();

  const flow = flowMode === "start" ? start : join;

  return (
    <>
      {screen === "lobby" && <LobbyScreen onStartGame={handleStartGame} onJoinGame={handleJoinGame} session={session.session} onResume={handleResume} onDiscard={handleNewGame} />}

      {screen === "placement" && <ShipPlacement onConfirm={handlePlacementConfirm} />}

      {screen === "waiting" && (
        <WaitingScreen gameId={flowMode === "start" ? start.gameAccountAddress : joinTargetId} isStarter={flowMode === "start"} stage={flow.stage} status={flow.status} error={flow.error} />
      )}

      {screen === "play" && gameConfig && (
        <GamePlay myAccount={gameConfig.myAccount} opponentAccount={gameConfig.opponentAccount} playerRole={gameConfig.role} session={session} onNewGame={handleNewGame} />
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
