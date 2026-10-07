import type { GameState } from "@/types/game";
import { PHASE_ACTIVE, PHASE_REVEAL, PHASE_COMPLETE } from "@/types/game";
import { TOTAL_SHIP_CELLS } from "@/config";
import { formatFeeBalance } from "@/lib/funding";
import "./GameStatus.css";

interface GameStatusProps {
  myState: GameState | null;
  /** Enemy ship cells I have hit so far (from result notes). */
  enemyHits: number;
  opponentGameOver?: boolean;
  isMyTurn: boolean;
  isSyncing: boolean;
  feeBalance?: bigint | null;
}

export function GameStatus({ myState, enemyHits, opponentGameOver = false, isMyTurn, isSyncing, feeBalance }: GameStatusProps) {
  if (!myState) {
    return <div className="game-status">Loading game state...</div>;
  }

  const myShipsRemaining = TOTAL_SHIP_CELLS - myState.shipsHitCount;
  const opponentShipsRemaining = TOTAL_SHIP_CELLS - enemyHits;

  const iLost = myState.shipsHitCount >= TOTAL_SHIP_CELLS;
  const iWon = opponentGameOver || enemyHits >= TOTAL_SHIP_CELLS;
  const gameOver = myState.phase === PHASE_COMPLETE || myState.phase === PHASE_REVEAL || iLost || iWon;
  const revealDone = myState.phase === PHASE_COMPLETE;

  return (
    <div className="game-status">
      {gameOver ? (
        <div className={`status-message ${iWon ? "victory" : iLost ? "defeat" : "waiting"}`}>
          {iWon ? "VICTORY!" : iLost ? "DEFEAT" : "Game Over"}
          {revealDone ? " — boards revealed and verified" : " — revealing boards..."}
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
          Enemy ships: <strong>{opponentShipsRemaining}</strong>/{TOTAL_SHIP_CELLS}
        </span>
        {feeBalance !== undefined && (
          <span className="stat">
            Fees: <strong>{formatFeeBalance(feeBalance)}</strong>
          </span>
        )}
      </div>

      {isSyncing && <div className="sync-indicator">Syncing...</div>}
    </div>
  );
}
