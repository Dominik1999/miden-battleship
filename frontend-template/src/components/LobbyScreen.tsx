import { useState } from "react";
import { clearMidenStorage } from "@miden-sdk/react";
import "./LobbyScreen.css";

interface LobbyScreenProps {
  walletConnected: boolean;
  onStartGame: () => void;
  onJoinGame: (gameId: string) => void;
}

export function LobbyScreen({
  walletConnected,
  onStartGame,
  onJoinGame,
}: LobbyScreenProps) {
  const [showJoinInput, setShowJoinInput] = useState(false);
  const [gameId, setGameId] = useState("");

  const validGameId = gameId.startsWith("mtst1") && gameId.length > 10;

  return (
    <div className="lobby">
      <div className="lobby-buttons">
        <button
          className="lobby-btn"
          disabled={!walletConnected}
          onClick={onStartGame}
        >
          Start Game
        </button>

        <button
          className="lobby-btn"
          disabled={!walletConnected}
          onClick={() => setShowJoinInput((v) => !v)}
        >
          Join Game
        </button>
      </div>

      {!walletConnected && (
        <p className="lobby-hint">Connect your wallet to play</p>
      )}

      <button
        className="lobby-btn reset-btn"
        onClick={async () => {
          if (confirm("Clear all Miden client data? This will remove all local accounts and notes.")) {
            await clearMidenStorage();
            window.location.reload();
          }
        }}
      >
        Reset Client Data
      </button>

      {showJoinInput && walletConnected && (
        <div className="join-input-section">
          <label htmlFor="game-id-input">Enter Game ID</label>
          <input
            id="game-id-input"
            type="text"
            value={gameId}
            onChange={(e) => setGameId(e.target.value)}
            placeholder="mtst1..."
            className="game-id-input"
          />
          <button
            className="join-confirm-btn"
            disabled={!validGameId}
            onClick={() => onJoinGame(gameId)}
          >
            Join
          </button>
          {gameId && !validGameId && (
            <p className="lobby-error">
              Game ID must be a valid bech32 address starting with "mtst1"
            </p>
          )}
        </div>
      )}
    </div>
  );
}
