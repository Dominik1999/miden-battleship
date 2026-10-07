import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PlayerRole } from "@/types/game";
import { PHASE_ACTIVE } from "@/types/game";
import { useBoardState } from "@/hooks/useBoardState";
import { useGameplaySync } from "@/hooks/useGameplaySync";
import type { SessionActions } from "@/hooks/useGameSession";
import { useSoundEffects } from "@/hooks/useSoundEffects";
import { buildEnemyBoard } from "@/lib/gameplay";
import { formatFeeBalance } from "@/lib/funding";
import type { StakeStatus } from "./GameStatus";
import { GameBoard } from "./GameBoard";
import { GameStatus } from "./GameStatus";
import "./GamePlay.css";

interface GamePlayProps {
  myAccount: string;
  opponentAccount: string;
  playerRole: PlayerRole;
  session: SessionActions;
  onNewGame: () => void;
}

export function GamePlay({ myAccount, opponentAccount, playerRole, session, onNewGame }: GamePlayProps) {
  const { board: myBoard } = useBoardState(myAccount, false);
  const game = useGameplaySync({ myAddress: myAccount, opponentAddress: opponentAccount, session, enabled: true });
  const shots = useMemo(() => session.session?.shots ?? [], [session.session?.shots]);
  const gameOver = game.outcome !== "open";

  const { playShot, playDefeat, startMusic, stopMusic, setMusicVolume, musicPlaying, musicVolume } = useSoundEffects();

  const musicStarted = useRef(false);
  useEffect(() => {
    if (game.myState?.phase === PHASE_ACTIVE && !musicStarted.current) {
      startMusic();
      musicStarted.current = true;
    }
  }, [game.myState?.phase, startMusic]);

  const defeatPlayed = useRef(false);
  useEffect(() => {
    if (game.outcome === "lost" && !defeatPlayed.current) {
      defeatPlayed.current = true;
      stopMusic();
      playDefeat();
    }
  }, [game.outcome, playDefeat, stopMusic]);

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (!game.myTurn || game.busy || gameOver) return;
      if (shots.some((s) => s.row === row && s.col === col)) return;
      playShot();
      void game.fire(row, col);
    },
    [game, gameOver, shots, playShot],
  );

  const enemyBoard = useMemo(() => buildEnemyBoard(shots), [shots]);
  const pendingShots = useMemo(() => new Set(shots.filter((s) => s.status === "pending").map((s) => `${s.row},${s.col}`)), [shots]);
  const enemyHits = useMemo(() => shots.filter((s) => s.status === "hit").length, [shots]);
  const interactive = game.myTurn && !game.busy && !gameOver;
  const stake: StakeStatus | undefined =
    game.stake.amount > 0n
      ? {
          amountLabel: formatFeeBalance(game.stake.amount),
          published: game.stake.published,
          opponentLocked: game.stake.opponentAmount !== null && game.stake.opponentAmount >= game.stake.amount,
          claimed: game.stake.claimed,
        }
      : undefined;

  if (!myBoard) {
    return <div className="game-loading">Loading boards...</div>;
  }

  return (
    <div className="game-play">
      <GameStatus
        myState={game.myState ? { phase: game.myState.phase, shipsHitCount: game.myState.shipsHitCount } : null}
        enemyHits={enemyHits}
        outcome={game.outcome}
        isMyTurn={game.myTurn}
        isSyncing={game.busy}
        feeBalance={game.feeBalance === null ? null : formatFeeBalance(game.feeBalance)}
        waitingDeadline={game.waitingDeadline}
        blockTime={game.blockTime}
        canClaimForfeit={game.canClaimForfeit}
        onClaimForfeit={() => void game.claimForfeit()}
        stake={stake}
        playerRole={playerRole}
      />

      <div className="boards-container">
        <GameBoard board={myBoard} label="Your Fleet" />
        <GameBoard board={enemyBoard} label="Enemy Waters" interactive={interactive} pendingShots={pendingShots} onCellClick={handleCellClick} />
      </div>

      {game.lastError && <p className="error">{game.lastError}</p>}

      {game.busy && <div className="busy-indicator">Submitting your move...</div>}

      {gameOver && (
        <button className="lobby-btn new-game-btn" onClick={onNewGame}>
          New game
        </button>
      )}

      <div className="music-controls">
        <button className="music-toggle" onClick={musicPlaying ? stopMusic : startMusic} title={musicPlaying ? "Mute music" : "Play music"}>
          {musicPlaying ? "♫" : "♪"}
        </button>
        {musicPlaying && (
          <input type="range" className="music-volume" min={0} max={1} step={0.05} value={musicVolume} onChange={(e) => setMusicVolume(Number(e.target.value))} />
        )}
      </div>
    </div>
  );
}
