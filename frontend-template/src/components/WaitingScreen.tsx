import { useCallback, useState } from "react";
import type { StartStage } from "@/hooks/useStartGame";
import type { JoinStage } from "@/hooks/useJoinGame";
import "./WaitingScreen.css";

type Stage = StartStage | JoinStage;

interface WaitingScreenProps {
  gameId: string | null;
  isStarter: boolean;
  stage: Stage;
  /** Progress line from the flow (faucet, setup, handshake...). */
  status: string;
  error: string | null;
}

const STARTER_LABELS: Partial<Record<StartStage, string>> = {
  preparing: "Preparing your game account...",
  "waiting-for-opponent": "Waiting for opponent to join...",
  completing: "Opponent found! Completing handshake...",
  ready: "Game ready!",
};

const JOINER_LABELS: Partial<Record<JoinStage, string>> = {
  preparing: "Preparing your game account...",
  "setting-up": "Setting up your board...",
  challenging: "Sending challenge to opponent...",
  waiting: "Waiting for opponent to accept...",
  accepting: "Opponent accepted! Activating the game...",
  ready: "Game ready!",
};

export function WaitingScreen({ gameId, isStarter, stage, status, error }: WaitingScreenProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!gameId) return;
    await navigator.clipboard.writeText(gameId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [gameId]);

  const labels = isStarter ? STARTER_LABELS : JOINER_LABELS;
  const statusMessage = labels[stage as keyof typeof labels] ?? "Preparing game...";
  const isWaiting = stage !== "ready" && stage !== "error";

  return (
    <div className="waiting-screen">
      <h2>{isStarter ? "Your Game" : "Joining Game"}</h2>

      {isStarter && gameId && (
        <div className="game-id-display">
          <label>Game ID — share with your opponent</label>
          <div className="game-id-row">
            <code className="game-id-value">{gameId}</code>
            <button className="copy-btn" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <p className="waiting-status">{statusMessage}</p>
      {status && <p className="waiting-detail">{status}</p>}

      {isWaiting && <div className="waiting-spinner" />}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
