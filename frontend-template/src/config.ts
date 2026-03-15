// Result note script root (from deploy_testnet.rs output)
// Replace with actual values after deployment
export const RESULT_SCRIPT_ROOT: [bigint, bigint, bigint, bigint] = [15171288892435243614n, 10295758693372466955n, 709059778587687919n, 9826546822224790371n];

// Storage slot names (must match contract)
export const SLOT_GAME_CONFIG =
  "miden::component::miden_battleship_account::game_config";
export const SLOT_OPPONENT =
  "miden::component::miden_battleship_account::opponent";
export const SLOT_BOARD =
  "miden::component::miden_battleship_account::my_board";
export const SLOT_BOARD_COMMITMENT =
  "miden::component::miden_battleship_account::board_commitment";
export const SLOT_OPPONENT_COMMITMENT =
  "miden::component::miden_battleship_account::opponent_commitment";
export const SLOT_GAME_ID =
  "miden::component::miden_battleship_account::game_id";
export const SLOT_REVEAL_STATUS =
  "miden::component::miden_battleship_account::reveal_status";

// Game constants
export const GRID_SIZE = 10;
export const TOTAL_SHIP_CELLS = 17;

// Network timing
export const NETWORK_SYNC_DELAY_MS = 10_000;
export const AUTO_SYNC_INTERVAL_MS = 8_000;

// Block explorer base URL
export const EXPLORER_BASE_URL = "https://testnet.midenscan.com";

// Application display name (used by wallet adapter)
export const APP_NAME = "Miden Battleship";

// Miden SDK configuration — override via environment variables
export const MIDEN_RPC_URL =
  import.meta.env.VITE_MIDEN_RPC_URL ?? "testnet";
export const MIDEN_PROVER =
  (import.meta.env.VITE_MIDEN_PROVER as "testnet" | "local") ?? "testnet";
