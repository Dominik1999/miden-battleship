import type { GameState, PlayerRole } from "@/types/game";
import { PHASE_ACTIVE, PHASE_CHALLENGED } from "@/types/game";
import { TOTAL_SHIP_CELLS } from "@/config";
import { formatFeeBalance } from "@/lib/funding";
import { formatCountdown } from "@/lib/gameplay";
import type { Outcome, StakeView } from "@/hooks/useGameplaySync";
import "./GameStatus.css";

interface GameStatusProps {
  myState: GameState | null;
  /** Enemy ship cells I have hit so far (from result notes). */
  enemyHits: number;
  outcome: Outcome;
  isMyTurn: boolean;
  isSyncing: boolean;
  feeBalance?: bigint | null;
  /** Block timestamp after which the opponent forfeits, while I wait. */
  waitingDeadline?: number | null;
  blockTime?: number | null;
  canClaimForfeit?: boolean;
  onClaimForfeit?: () => void;
  stake?: StakeView;
  playerRole?: PlayerRole;
}

const OUTCOME_LABELS: Record<Exclude<Outcome, "open">, { text: string; className: string }> = {
  won: { text: "VICTORY! All enemy ships sunk", className: "victory" },
  "won-by-forfeit": { text: "VICTORY! The opponent forfeited", className: "victory" },
  lost: { text: "DEFEAT — your fleet is sunk", className: "defeat" },
};

export function GameStatus({
  myState,
  enemyHits,
  outcome,
  isMyTurn,
  isSyncing,
  feeBalance,
  waitingDeadline,
  blockTime,
  canClaimForfeit = false,
  onClaimForfeit,
  stake,
  playerRole,
}: GameStatusProps) {
  if (!myState) {
    return <div className="game-status">Loading game state...</div>;
  }

  const myShipsRemaining = TOTAL_SHIP_CELLS - myState.shipsHitCount;
  const opponentShipsRemaining = TOTAL_SHIP_CELLS - enemyHits;
  const stakesPending = stake && stake.amount > 0n && (!stake.published || stake.opponentAmount === null || stake.opponentAmount < stake.amount);
  const countdown = waitingDeadline && blockTime ? formatCountdown(waitingDeadline, blockTime) : null;

  let message: { text: string; className: string };
  if (outcome !== "open") {
    message = OUTCOME_LABELS[outcome];
  } else if (myState.phase === PHASE_CHALLENGED && playerRole === "challenger" && isMyTurn) {
    message = { text: "YOUR TURN — Fire the first shot!", className: "my-turn" };
  } else if (myState.phase === PHASE_ACTIVE || myState.phase === PHASE_CHALLENGED) {
    if (isMyTurn) message = { text: "YOUR TURN — Fire!", className: "my-turn" };
    else if (stakesPending) message = { text: "Waiting for both stakes to be locked...", className: "waiting" };
    else if (canClaimForfeit) message = { text: "The opponent did not move in time", className: "my-turn" };
    else message = { text: countdown ? `Opponent's turn... (forfeits in ${countdown})` : "Opponent's turn...", className: "waiting" };
  } else {
    message = { text: "Waiting for game to start...", className: "waiting" };
  }

  return (
    <div className="game-status">
      <div className={`status-message ${message.className}`}>{message.text}</div>

      {canClaimForfeit && outcome === "open" && (
        <button className="lobby-btn forfeit-btn" onClick={onClaimForfeit}>
          Claim the win by forfeit
        </button>
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
        {stake && stake.amount > 0n && (
          <span className="stat">
            Stake: <strong>{formatFeeBalance(stake.amount)}</strong> each
            {stake.claimed ? " — prize claimed" : stakesPending ? ` (yours ${stake.published ? "locked" : "pending"}, opponent's ${stake.opponentAmount === null ? "pending" : "locked"})` : " — both locked"}
          </span>
        )}
      </div>

      {isSyncing && <div className="sync-indicator">Syncing...</div>}
    </div>
  );
}
