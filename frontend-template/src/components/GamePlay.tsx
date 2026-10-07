import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlayerRole } from "@/types/game";
import { PHASE_ACTIVE } from "@/types/game";
import { TOTAL_SHIP_CELLS } from "@/config";
import { useGameState } from "@/hooks/useGameState";
import { useBoardState } from "@/hooks/useBoardState";
import { buildEnemyBoard, nextShotTurn, type FiredShot } from "@/lib/gameplay";
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
  /** My board commitment, revealed to the opponent once the game is decided. */
  commitment: bigint[] | null;
}

export function GamePlay({ accountA, accountB, playerRole, commitment }: GamePlayProps) {
  const myAccount = playerRole === "challenger" ? accountA : accountB;
  const opponentAccount = playerRole === "challenger" ? accountB : accountA;

  const { gameState: myState } = useGameState(myAccount);
  const { board: myBoard } = useBoardState(myAccount, false);
  const { fireShot, isSubmitting, error } = useFireShot(myAccount, opponentAccount);

  // My shots, keyed by turn; pending until the result note arrives.
  const [myShots, setMyShots] = useState<Map<number, FiredShot>>(new Map());
  const hasFiredRef = useRef(false);
  const prevShotsReceivedRef = useRef<number>(-1);

  const iLost = myState ? myState.shipsHitCount >= TOTAL_SHIP_CELLS : false;
  const gameOverRef = useRef(false);
  const sync = useGameplaySync(myAccount, !isSubmitting, {
    myState,
    opponentAddress: opponentAccount,
    commitment,
  });
  const iWon = sync.opponentGameOver;
  const gameOver = iLost || iWon;
  gameOverRef.current = gameOver;

  // Apply result notes to the shot log.
  useEffect(() => {
    setMyShots((prev) => {
      let next: Map<number, FiredShot> | null = null;
      for (const result of sync.results) {
        const shot = (next ?? prev).get(result.turn);
        if (!shot || shot.status !== "pending") continue;
        next ??= new Map(prev);
        next.set(result.turn, { ...shot, status: result.isHit ? "hit" : "miss" });
      }
      return next ?? prev;
    });
  }, [sync.results]);

  const { playShot, playDefeat, startMusic, stopMusic, setMusicVolume, musicPlaying, musicVolume } = useSoundEffects();

  const musicStarted = useRef(false);
  useEffect(() => {
    if (myState?.phase === PHASE_ACTIVE && !musicStarted.current) {
      startMusic();
      musicStarted.current = true;
    }
  }, [myState?.phase, startMusic]);

  // The opponent's shot landed on my account: my turn again.
  if (myState) {
    const currentShots = myState.totalShotsReceived;
    if (currentShots !== prevShotsReceivedRef.current) {
      if (prevShotsReceivedRef.current !== -1) hasFiredRef.current = false;
      prevShotsReceivedRef.current = currentShots;
    }
  }

  const isMyTurn = (() => {
    if (!myState || myState.phase !== PHASE_ACTIVE || hasFiredRef.current || gameOver) return false;
    if (playerRole === "challenger") return true;
    return myState.totalShotsReceived > 0;
  })();

  const prevMyHits = useRef<number | null>(null);
  useEffect(() => {
    if (!myState) return;
    if (prevMyHits.current !== null && myState.shipsHitCount > prevMyHits.current && myState.shipsHitCount >= TOTAL_SHIP_CELLS) {
      stopMusic();
      playDefeat();
    }
    prevMyHits.current = myState.shipsHitCount;
  }, [myState, playDefeat, stopMusic]);

  const shotTurnNumber = myState ? nextShotTurn(playerRole, myState.totalShotsReceived) : 1;

  useEffect(() => {
    if (error) {
      hasFiredRef.current = false;
      setMyShots((prev) => {
        const next = new Map(prev);
        for (const [turn, shot] of next) if (shot.status === "pending") next.delete(turn);
        return next;
      });
    }
  }, [error]);

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (!isMyTurn || isSubmitting || !myState) return;
      playShot();
      hasFiredRef.current = true;
      setMyShots((prev) => new Map(prev).set(shotTurnNumber, { row, col, status: "pending" }));
      void fireShot(row, col, shotTurnNumber);
    },
    [isMyTurn, isSubmitting, myState, shotTurnNumber, fireShot, playShot],
  );

  const enemyBoard = useMemo(() => buildEnemyBoard(myShots), [myShots]);
  const pendingShots = useMemo(() => {
    const set = new Set<string>();
    for (const shot of myShots.values()) if (shot.status === "pending") set.add(`${shot.row},${shot.col}`);
    return set;
  }, [myShots]);
  const enemyHits = useMemo(() => [...myShots.values()].filter((s) => s.status === "hit").length, [myShots]);

  if (!myBoard) {
    return <div className="game-loading">Loading boards...</div>;
  }

  return (
    <div className="game-play">
      <GameStatus
        myState={myState}
        enemyHits={enemyHits}
        opponentGameOver={iWon}
        isMyTurn={isMyTurn}
        isSyncing={isSubmitting}
        feeBalance={sync.feeBalance}
      />

      <div className="boards-container">
        <GameBoard board={myBoard} label="Your Fleet" />
        <GameBoard
          board={enemyBoard}
          label="Enemy Waters"
          interactive={isMyTurn && !isSubmitting && !gameOver}
          pendingShots={pendingShots}
          onCellClick={handleCellClick}
        />
      </div>

      {error && <p className="error">{error}</p>}
      {sync.lastError && <p className="error">{sync.lastError}</p>}

      {isSubmitting && <div className="busy-indicator">Submitting shot...</div>}

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
