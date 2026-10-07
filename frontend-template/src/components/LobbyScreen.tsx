import { useState } from "react";
import { clearMidenStorage } from "@miden-sdk/react";
import { STAKE_TIERS } from "@/config";
import { formatFeeBalance } from "@/lib/funding";
import type { GameSession } from "@/lib/session";
import "./LobbyScreen.css";

interface LobbyScreenProps {
  onStartGame: (stake: bigint) => void;
  onJoinGame: (gameId: string, stake: bigint) => void;
  /** A persisted, unfinished game that can be resumed. */
  session?: GameSession | null;
  onResume?: () => void;
  onDiscard?: () => void;
}

/**
 * Game accounts are self-funded from the faucet; the local wallet stakes and claims. Both
 * players pick the same stake tier (0 = friendly game); each pays its stake, the winner
 * takes both.
 */
export function LobbyScreen({ onStartGame, onJoinGame, session, onResume, onDiscard }: LobbyScreenProps) {
  const [showJoinInput, setShowJoinInput] = useState(false);
  const [gameId, setGameId] = useState("");
  const [stake, setStake] = useState<bigint>(0n);

  const validGameId = gameId.startsWith("mtst1") && gameId.length > 10;

  return (
    <div className="lobby">
      {session && (
        <div className="resume-banner">
          <p>
            You have an unfinished game as the {session.role === "challenger" ? "challenger" : "host"}
            {BigInt(session.stakeAmount) > 0n ? ` with a ${formatFeeBalance(BigInt(session.stakeAmount))} stake` : ""}.
          </p>
          <div className="lobby-buttons">
            <button className="lobby-btn" onClick={onResume}>
              Resume game
            </button>
            <button className="lobby-btn reset-btn" onClick={onDiscard}>
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="stake-picker">
        <label htmlFor="stake-select">Stake per player</label>
        <select id="stake-select" value={stake.toString()} onChange={(e) => setStake(BigInt(e.target.value))} className="stake-select">
          <option value="0">No stake</option>
          {STAKE_TIERS.map((tier) => (
            <option key={tier.toString()} value={tier.toString()}>
              {formatFeeBalance(tier)}
            </option>
          ))}
        </select>
      </div>

      <div className="lobby-buttons">
        <button className="lobby-btn" onClick={() => onStartGame(stake)}>
          Start Game
        </button>

        <button className="lobby-btn" onClick={() => setShowJoinInput((v) => !v)}>
          Join Game
        </button>
      </div>

      <p className="lobby-hint">Boards stay private: only shot results leave your browser. Both players must choose the same stake.</p>

      <button
        className="lobby-btn reset-btn"
        onClick={async () => {
          if (confirm("Clear all Miden client data? This will remove all local accounts, notes and the saved game.")) {
            onDiscard?.();
            await clearMidenStorage();
            window.location.reload();
          }
        }}
      >
        Reset Client Data
      </button>

      {showJoinInput && (
        <div className="join-input-section">
          <label htmlFor="game-id-input">Enter Game ID</label>
          <input id="game-id-input" type="text" value={gameId} onChange={(e) => setGameId(e.target.value)} placeholder="mtst1..." className="game-id-input" />
          <button className="join-confirm-btn" disabled={!validGameId} onClick={() => onJoinGame(gameId, stake)}>
            Join
          </button>
          {gameId && !validGameId && <p className="lobby-error">Game ID must be a valid bech32 address starting with "mtst1"</p>}
        </div>
      )}
    </div>
  );
}
