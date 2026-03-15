import { useState, useCallback, useEffect } from "react";
import { useMiden, useSyncState } from "@miden-sdk/react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter";
import type { ShipCell } from "@/types/game";
import { WalletButton } from "./WalletButton";
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
  const { connected } = useMidenFiWallet();

  const [screen, setScreen] = useState<Screen>("lobby");
  const [flowMode, setFlowMode] = useState<FlowMode>(null);
  const [joinTargetId, setJoinTargetId] = useState<string | null>(null);

  const {
    startGame,
    consumeNotes: startConsumeNotes,
    consumableNoteCount: startNoteCount,
    isConsuming: startIsConsuming,
    stage: startStage,
    error: startError,
    gameAccountAddress: startGameAddress,
    opponentAddress,
  } = useStartGame();

  const {
    joinGame,
    consumeNotes: joinConsumeNotes,
    consumableNoteCount: joinNoteCount,
    isConsuming: joinIsConsuming,
    stage: joinStage,
    error: joinError,
    gameAccountAddress: joinGameAddress,
    starterAddress,
  } = useJoinGame();

  // --- Lobby handlers ---
  const handleStartGame = useCallback(() => {
    setFlowMode("start");
    setScreen("placement");
  }, []);

  const handleJoinGame = useCallback((gameId: string) => {
    setFlowMode("join");
    setJoinTargetId(gameId);
    setScreen("placement");
  }, []);

  // --- Ship placement handler ---
  const handlePlacementConfirm = useCallback(
    async (cells: ShipCell[]) => {
      setScreen("waiting");

      if (flowMode === "start") {
        await startGame(cells);
      } else if (flowMode === "join" && joinTargetId) {
        await joinGame(joinTargetId, cells);
      }
    },
    [flowMode, joinTargetId, startGame, joinGame],
  );

  // --- Transition to play when ready ---
  useEffect(() => {
    if (flowMode === "start" && startStage === "ready") {
      setScreen("play");
    }
  }, [flowMode, startStage]);

  useEffect(() => {
    if (flowMode === "join" && joinStage === "ready") {
      setScreen("play");
    }
  }, [flowMode, joinStage]);

  // --- Derive game config for GamePlay ---
  const gameConfig = (() => {
    if (flowMode === "start" && startGameAddress && opponentAddress) {
      return {
        accountA: startGameAddress,
        accountB: opponentAddress,
        role: "challenger" as const,
      };
    }
    if (flowMode === "join" && joinGameAddress && starterAddress) {
      return {
        accountA: starterAddress,
        accountB: joinGameAddress,
        role: "acceptor" as const,
      };
    }
    return null;
  })();

  return (
    <>
      {screen === "lobby" && (
        <LobbyScreen
          walletConnected={connected}
          onStartGame={handleStartGame}
          onJoinGame={handleJoinGame}
        />
      )}

      {screen === "placement" && (
        <ShipPlacement onConfirm={handlePlacementConfirm} />
      )}

      {screen === "waiting" && (
        <WaitingScreen
          gameId={
            flowMode === "start"
              ? startGameAddress
              : joinTargetId
          }
          isStarter={flowMode === "start"}
          stage={flowMode === "start" ? startStage : joinStage}
          error={flowMode === "start" ? startError : joinError}
          consumableNoteCount={flowMode === "start" ? startNoteCount : joinNoteCount}
          isConsuming={flowMode === "start" ? startIsConsuming : joinIsConsuming}
          onConsumeNotes={flowMode === "start" ? startConsumeNotes : joinConsumeNotes}
        />
      )}

      {screen === "play" && gameConfig && (
        <GamePlay
          accountA={gameConfig.accountA}
          accountB={gameConfig.accountB}
          playerRole={gameConfig.role}
        />
      )}
    </>
  );
}

export function AppContent() {
  const { isReady, isInitializing, error } = useMiden();
  const { syncHeight } = useSyncState();

  const clientReady = isReady && !isInitializing;

  return (
    <>
      <h1 className="game-title">Miden Battleship</h1>
      <div className="wallet-section">
        <WalletButton />
      </div>

      {error && (
        <div className="loading">
          <p>Failed to initialize Miden client</p>
          <p className="error">{error.message}</p>
        </div>
      )}

      {!error && !clientReady && (
        <div className="loading">
          Initializing Miden client... Connect your wallet above.
        </div>
      )}

      {clientReady && <GameScreens />}

      <p className="footer-info">
        Block: {syncHeight ?? "syncing..."}
      </p>
    </>
  );
}
