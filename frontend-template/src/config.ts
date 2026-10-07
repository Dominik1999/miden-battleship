// Storage slot names (must match project-template/contracts/masm/battleship_account.masm)
export const SLOT_GAME_CONFIG =
  "miden_battleship_account::battleship_account::game_config";
export const SLOT_OPPONENT =
  "miden_battleship_account::battleship_account::opponent";
export const SLOT_BOARD_COMMITMENT =
  "miden_battleship_account::battleship_account::board_commitment";
export const SLOT_OPPONENT_COMMITMENT =
  "miden_battleship_account::battleship_account::opponent_commitment";
export const SLOT_GAME_ID =
  "miden_battleship_account::battleship_account::game_id";
export const SLOT_REVEAL_STATUS =
  "miden_battleship_account::battleship_account::reveal_status";
/** Map slot holding the board rows: key [0, 0, 0, row] -> [packed_row, 0, 0, 0]. */
export const SLOT_BOARD_MAP =
  "miden_battleship_account::battleship_account::my_board";

/** Module path the battleship component is compiled under (procedure identity). */
export const BATTLESHIP_COMPONENT_NAMESPACE = "battleship::account";

// Note storage sizes (felts) — used to classify incoming notes
export const SETUP_PAYLOAD_ITEMS = 20; // game_id(4) + opponent(2) + commitment(4) + rows(10)
export const HANDSHAKE_NOTE_ITEMS = 10; // game_id(4) + sender(2) + commitment(4)
export const SHOT_NOTE_ITEMS = 11; // row, col, turn, result_serial(4), result_script_root(4)
export const RESULT_NOTE_ITEMS = 4; // shooter_prefix, shooter_suffix, turn, encoded_result
export const REVEAL_NOTE_ITEMS = 4; // commitment(4)

// Game constants
export const GRID_SIZE = 10;
export const TOTAL_SHIP_CELLS = 17;

// Network timing
export const NETWORK_SYNC_DELAY_MS = 3_000; // Initial delay before first sync after submission
export const NETWORK_POLL_INTERVAL_MS = 3_000; // Interval between poll-until-confirmed retries
export const NETWORK_POLL_MAX_ATTEMPTS = 15; // Max poll attempts (45s total)
export const AUTO_SYNC_INTERVAL_MS = 3_000; // Gameplay sync polling interval
export const CONSUME_MAX_RETRIES = 10;
export const CONSUME_RETRY_DELAY_MS = 5_000;
export const TX_COMMIT_TIMEOUT_MS = 120_000; // Max wait for a submitted transaction to commit

// Fees: every transaction pays in the chain's native fee asset (USDCx, 6 decimals)
export const FEE_ASSET_SYMBOL = "USDCx";
export const FEE_ASSET_DECIMALS = 6;
/** Base units requested per faucet claim (the public faucet caps claims at 10_000). */
export const FAUCET_CLAIM_AMOUNT = 10_000n;
/** Top up the game account when its fee balance drops below this (≈15 transactions). */
export const FEE_TOP_UP_THRESHOLD = 3_000n;
/** Minimum spacing between faucet claims for one account (faucet rate-limits per account). */
export const FAUCET_CLAIM_COOLDOWN_MS = 35_000;
export const FAUCET_MAX_RETRIES = 4;
export const FAUCET_RETRY_DELAY_MS = 5_000;
export const FUNDING_NOTE_TIMEOUT_MS = 180_000; // Max wait for a faucet note to land on-chain

// Block explorer base URL
export const EXPLORER_BASE_URL = "https://testnet.midenscan.com";

export const APP_NAME = "Miden Battleship";

// Miden SDK configuration — override via environment variables
export const MIDEN_RPC_URL =
  import.meta.env.VITE_MIDEN_RPC_URL ?? "testnet";
export const MIDEN_PROVER =
  (import.meta.env.VITE_MIDEN_PROVER as "testnet" | "local") ?? "testnet";
export const MIDEN_PROVER_TIMEOUT_MS = 120_000;
/** Public faucet HTTP API used to fund game accounts with the fee asset. */
export const MIDEN_FAUCET_URL: string =
  import.meta.env.VITE_MIDEN_FAUCET_URL ?? "https://faucet-api.testnet.miden.io";
