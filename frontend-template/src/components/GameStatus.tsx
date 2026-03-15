import type { GameState } from "@/types/game";
import { PHASE_ACTIVE, PHASE_REVEAL, PHASE_COMPLETE } from "@/types/game";
import { TOTAL_SHIP_CELLS } from "@/config";
import "./GameStatus.css";

interface GameStatusProps {
  myState: GameState | null;
  opponentState: GameState | null;
  isMyTurn: boolean;
  isSyncing: boolean;
}

export function GameStatus({
  myState,
  opponentState,
  isMyTurn,
  isSyncing,
}: GameStatusProps) {
  if (!myState) {
    return <div className="game-status">Loading game state...</div>;
  }

  const myShipsRemaining = TOTAL_SHIP_CELLS - myState.shipsHitCount;
  const opponentShipsRemaining = opponentState
    ? TOTAL_SHIP_CELLS - opponentState.shipsHitCount
    : null;

  const iLost = myState.shipsHitCount >= TOTAL_SHIP_CELLS;
  const iWon = opponentState
    ? opponentState.shipsHitCount >= TOTAL_SHIP_CELLS
    : false;
  const gameOver =
    myState.phase === PHASE_COMPLETE ||
    myState.phase === PHASE_REVEAL ||
    iLost ||
    iWon;

  return (
    <div className="game-status">
      {gameOver ? (
        <div className={`status-message ${iWon ? "victory" : iLost ? "defeat" : "waiting"}`}>
          {iWon ? "VICTORY!" : iLost ? "DEFEAT" : "Game Over"}
        </div>
      ) : myState.phase === PHASE_ACTIVE ? (
        <div className={`status-message ${isMyTurn ? "my-turn" : "waiting"}`}>
          {isMyTurn ? "YOUR TURN — Fire!" : "Opponent's turn..."}
        </div>
      ) : (
        <div className="status-message waiting">Waiting for game to start...</div>
      )}

      <div className="status-stats">
        <span className="stat">
          Your ships: <strong>{myShipsRemaining}</strong>/{TOTAL_SHIP_CELLS}
        </span>
        <span className="stat">
          Enemy ships: <strong>{opponentShipsRemaining ?? "?"}</strong>/{TOTAL_SHIP_CELLS}
        </span>
      </div>

      {isSyncing && <div className="sync-indicator">Syncing...</div>}
    </div>
  );
}
