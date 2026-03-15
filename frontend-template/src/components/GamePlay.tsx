import { useCallback, useEffect, useRef } from "react";
import type { PlayerRole } from "@/types/game";
import { PHASE_ACTIVE } from "@/types/game";
import { TOTAL_SHIP_CELLS } from "@/config";
import { useGameState } from "@/hooks/useGameState";
import { useBoardState } from "@/hooks/useBoardState";
import { useFireShot } from "@/hooks/useFireShot";
import { useGameplaySync } from "@/hooks/useGameplaySync";
import { useSoundEffects } from "@/hooks/useSoundEffects";
import { GameBoard } from "./GameBoard";
import { GameStatus } from "./GameStatus";
import "./GamePlay.css";

interface GamePlayProps {
  accountA: string;
  accountB: string;
  playerRole: PlayerRole;
}

export function GamePlay({ accountA, accountB, playerRole }: GamePlayProps) {
  const myAccount = playerRole === "challenger" ? accountA : accountB;
  const opponentAccount = playerRole === "challenger" ? accountB : accountA;

  const {
    gameState: myState,
    refetch: refetchMy,
  } = useGameState(myAccount);
  // Skip importing opponent — their game account can't be imported from network
  const { gameState: opponentState, refetch: refetchOpponent } =
    useGameState(opponentAccount, true);
  const { board: myBoard } = useBoardState(myAccount, false);
  const { board: opponentBoard } = useBoardState(opponentAccount, true);

  const refetchAll = useCallback(() => {
    refetchMy();
    refetchOpponent();
  }, [refetchMy, refetchOpponent]);

  const { fireShot, isSubmitting, isWaiting, error, walletConnected } =
    useFireShot(opponentAccount, refetchAll);

  const {
    playShot, playHit, playMiss, playVictory, playDefeat,
    startMusic, stopMusic, setMusicVolume, musicPlaying, musicVolume,
  } = useSoundEffects();

  // Auto-start music when game is active
  const musicStarted = useRef(false);
  useEffect(() => {
    if (myState?.phase === PHASE_ACTIVE && !musicStarted.current) {
      startMusic();
      musicStarted.current = true;
    }
  }, [myState?.phase, startMusic]);

  // Local turn tracking: we can't rely on opponentState (always null).
  // Track whether we've fired and reset when totalShotsReceived changes
  // (meaning the opponent fired back and their shot was consumed).
  const hasFiredRef = useRef(false);
  const prevShotsReceivedRef = useRef<number>(-1);

  // Joiner ("acceptor" in frontend) fires first (odd turns: 1, 3, 5...)
  // Starter ("challenger" in frontend) fires second (even turns: 2, 4, 6...)
  const isJoiner = playerRole === "acceptor";

  if (myState) {
    const currentShots = myState.totalShotsReceived;
    if (currentShots !== prevShotsReceivedRef.current) {
      if (prevShotsReceivedRef.current !== -1) {
        // Received a new shot from opponent — it's our turn again
        hasFiredRef.current = false;
      }
      prevShotsReceivedRef.current = currentShots;
    }
  }

  const isMyTurn = (() => {
    if (!myState || myState.phase !== PHASE_ACTIVE || hasFiredRef.current) return false;
    if (isJoiner) {
      // Joiner fires first (with 0 shots received), then after each received shot
      return true;
    }
    // Starter must wait to receive shot 1 before firing shot 2
    return myState.totalShotsReceived > 0;
  })();

  const busy = isSubmitting || isWaiting;

  // We can only detect our own loss from myState. Win detection relies on
  // opponentState (if available) or phase transition.
  const iLost = myState ? myState.shipsHitCount >= TOTAL_SHIP_CELLS : false;
  const iWon = opponentState ? opponentState.shipsHitCount >= TOTAL_SHIP_CELLS : false;
  const gameOver = iLost || iWon;

  // Auto-sync and auto-consume incoming shot notes on our game account.
  useGameplaySync(myAccount, !busy && !gameOver, refetchAll);

  // Sound effects on own state changes
  const prevMyHits = useRef<number | null>(null);
  const prevMyShots = useRef<number | null>(null);

  useEffect(() => {
    if (!myState) return;

    // Detect we got hit (opponent's shot landed on our ship)
    if (
      prevMyHits.current !== null &&
      myState.shipsHitCount > prevMyHits.current
    ) {
      if (myState.shipsHitCount >= TOTAL_SHIP_CELLS) {
        stopMusic();
        playDefeat();
      }
    }

    // Detect opponent fired at us (shot consumed) but missed
    if (
      prevMyShots.current !== null &&
      myState.totalShotsReceived > prevMyShots.current &&
      myState.shipsHitCount === (prevMyHits.current ?? 0)
    ) {
      // Opponent missed us — no sound needed for that on our side
    }

    prevMyHits.current = myState.shipsHitCount;
    prevMyShots.current = myState.totalShotsReceived;
  }, [myState, playDefeat, stopMusic]);

  // Compute the turn number for our next shot
  const shotTurnNumber = (() => {
    if (!myState) return 1;
    if (isJoiner) {
      // Joiner fires turns 1, 3, 5... = 2 * totalShotsReceived + 1
      return 2 * myState.totalShotsReceived + 1;
    }
    // Starter fires turns 2, 4, 6... = 2 * totalShotsReceived
    return 2 * myState.totalShotsReceived;
  })();

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (!isMyTurn || busy || !myState) return;
      playShot();
      hasFiredRef.current = true;
      fireShot(row, col, shotTurnNumber);
    },
    [isMyTurn, busy, myState, shotTurnNumber, fireShot, playShot],
  );

  if (!myBoard || !opponentBoard) {
    return <div className="game-loading">Loading boards...</div>;
  }

  return (
    <div className="game-play">
      <GameStatus
        myState={myState}
        opponentState={opponentState}
        isMyTurn={isMyTurn}
        isSyncing={isWaiting}
      />

      <div className="boards-container">
        <GameBoard board={myBoard} label="Your Fleet" />
        <GameBoard
          board={opponentBoard}
          label="Enemy Waters"
          interactive={isMyTurn && !busy && !gameOver}
          onCellClick={handleCellClick}
        />
      </div>

      {!walletConnected && (
        <p className="warning">Connect your wallet to fire shots</p>
      )}

      {error && <p className="error">{error}</p>}

      {busy && (
        <div className="busy-indicator">
          {isSubmitting ? "Submitting shot..." : "Waiting for network..."}
        </div>
      )}

      <div className="music-controls">
        <button
          className="music-toggle"
          onClick={musicPlaying ? stopMusic : startMusic}
          title={musicPlaying ? "Mute music" : "Play music"}
        >
          {musicPlaying ? "♫" : "♪"}
        </button>
        {musicPlaying && (
          <input
            type="range"
            className="music-volume"
            min={0}
            max={1}
            step={0.05}
            value={musicVolume}
            onChange={(e) => setMusicVolume(Number(e.target.value))}
          />
        )}
      </div>
    </div>
  );
}
