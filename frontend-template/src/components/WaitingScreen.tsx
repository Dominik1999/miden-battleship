import { useCallback, useState } from "react";
import type { StartStage } from "@/hooks/useStartGame";
import type { JoinStage } from "@/hooks/useJoinGame";
import "./WaitingScreen.css";

type Stage = StartStage | JoinStage;

interface WaitingScreenProps {
  gameId: string | null;
  isStarter: boolean;
  stage: Stage;
  error: string | null;
  consumableNoteCount: number;
  isConsuming: boolean;
  onConsumeNotes: () => void;
}

const STARTER_LABELS: Partial<Record<StartStage, string>> = {
  loading: "Loading contract packages...",
  "creating-account": "Creating game account...",
  "waiting-for-opponent": "Waiting for opponent to join...",
  completing: "Opponent found! Completing handshake...",
  syncing: "Waiting for network sync...",
  ready: "Game ready!",
};

const JOINER_LABELS: Partial<Record<JoinStage, string>> = {
  loading: "Loading contract packages...",
  "creating-account": "Creating game account...",
  "setting-up": "Setting up your board...",
  challenging: "Sending challenge to opponent...",
  syncing: "Waiting for network sync...",
  waiting: "Waiting for opponent to accept...",
  ready: "Game ready!",
};

export function WaitingScreen({
  gameId,
  isStarter,
  stage,
  error,
  consumableNoteCount,
  isConsuming,
  onConsumeNotes,
}: WaitingScreenProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!gameId) return;
    await navigator.clipboard.writeText(gameId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [gameId]);

  const labels = isStarter ? STARTER_LABELS : JOINER_LABELS;
  const statusMessage =
    labels[stage as keyof typeof labels] ?? "Preparing game...";

  const isWaiting =
    stage === "waiting-for-opponent" ||
    stage === "waiting" ||
    stage === "syncing";

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

      {isWaiting && <div className="waiting-spinner" />}

      {consumableNoteCount > 0 && (
        <div className="consume-section">
          <p className="consume-info">
            {consumableNoteCount} incoming note{consumableNoteCount !== 1 ? "s" : ""} found
          </p>
          <button
            className="consume-btn"
            onClick={onConsumeNotes}
            disabled={isConsuming}
          >
            {isConsuming ? "Consuming..." : `Consume ${consumableNoteCount} note${consumableNoteCount !== 1 ? "s" : ""}`}
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
