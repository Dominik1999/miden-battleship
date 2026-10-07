// Storage slot names (must match project-template/contracts/masm/battleship_account.masm)
const SLOT = "miden_battleship_account::battleship_account";
export const SLOT_GAME_CONFIG = `${SLOT}::game_config`;
export const SLOT_OPPONENT = `${SLOT}::opponent`;
export const SLOT_GAME_ID = `${SLOT}::game_id`;
export const SLOT_OWNER_WALLET = `${SLOT}::owner_wallet`;
export const SLOT_OPPONENT_WALLET = `${SLOT}::opponent_wallet`;
export const SLOT_TURN_STATE = `${SLOT}::turn_state`;
export const SLOT_LAST_SHOT = `${SLOT}::last_shot`;
export const SLOT_OUTCOME = `${SLOT}::outcome`;
/** Map slot holding the board rows: key [0, 0, 0, row] -> [packed_row, 0, 0, 0]. */
export const SLOT_BOARD_MAP = `${SLOT}::my_board`;
/** Map slot holding my shots: key [0, 0, 0, row] -> [fired_bits, hit_bits, 0, 0]. */
export const SLOT_MY_SHOTS_MAP = `${SLOT}::my_shots`;
/** Map slot holding the pinned note script roots: key [0, 0, 0, kind] -> ROOT. */
export const SLOT_SCRIPT_ROOTS_MAP = `${SLOT}::script_roots`;

/** Module path the battleship component is compiled under (procedure identity). */
export const BATTLESHIP_COMPONENT_NAMESPACE = "battleship::account";

// Note storage sizes (felts)
export const SETUP_PAYLOAD_ITEMS = 36; // game_id(4) + opponent(2) + wallet(2) + rows(10) + roots(16) + pad(2)
export const HANDSHAKE_NOTE_ITEMS = 28; // game_id(4) + sender(2) + seed(4) + wallet(2) + roots(16)
export const SHOT_NOTE_ITEMS = 4; // row, col, turn, deadline
export const RESULT_NOTE_ITEMS = 5; // shooter(2), turn, encoded_result, deadline
export const WALLET_NOTE_ITEMS = 2; // wallet(2) — defeat and forfeit notes
export const STAKE_NOTE_ITEMS = 9; // my_wallet(2), my_game(2), opp_wallet(2), opp_game(2), expiry

// Note kinds: `script_roots` map keys and serial-number kinds (mirror battleship_account.masm)
export const ROOT_SHOT = 0;
export const ROOT_RESULT = 1;
export const ROOT_DEFEAT = 2;
export const ROOT_FORFEIT = 3;
export const SERIAL_KIND_SHOT = 1;
export const SERIAL_KIND_RESULT = 2;
export const SERIAL_KIND_DEFEAT = 3;
export const SERIAL_KIND_FORFEIT = 4;

// Game constants
export const GRID_SIZE = 10;
export const TOTAL_SHIP_CELLS = 17;
/** Seconds a note must stay consumable before its sender may reclaim it (12 hours). */
export const DEADLINE_DELTA_SECONDS = 43_200;
/** A stake note becomes refundable to its staker this long after it was created (60 days). */
export const STAKE_EXPIRY_DELTA_SECONDS = 60 * 24 * 3_600;

// Network timing
export const NETWORK_POLL_INTERVAL_MS = 3_000; // Interval between poll-until-confirmed retries
export const AUTO_SYNC_INTERVAL_MS = 3_000; // Gameplay sync polling interval
export const TX_COMMIT_TIMEOUT_MS = 180_000; // Max wait for a submitted transaction to commit

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

/**
 * Stake tiers in fee-asset base units. On testnet the faucet grants 10_000 base units per
 * claim, so the tiers are tiny; on mainnet set VITE_STAKE_TIERS to e.g. "1000000,5000000,10000000"
 * ($1, $5, $10 in USDCx).
 */
export const STAKE_TIERS: readonly bigint[] = (import.meta.env.VITE_STAKE_TIERS ?? "1000,2000,5000")
  .split(",")
  .map((s: string) => BigInt(s.trim()))
  .filter((v: bigint) => v > 0n);

// Block explorer base URL
export const EXPLORER_BASE_URL = "https://testnet.midenscan.com";

export const APP_NAME = "Miden Battleship";

// Miden SDK configuration — override via environment variables
export const MIDEN_RPC_URL = import.meta.env.VITE_MIDEN_RPC_URL ?? "testnet";
export const MIDEN_PROVER = (import.meta.env.VITE_MIDEN_PROVER as "testnet" | "local") ?? "testnet";
export const MIDEN_PROVER_TIMEOUT_MS = 120_000;
/** Public faucet HTTP API used to fund game accounts with the fee asset. */
export const MIDEN_FAUCET_URL: string = import.meta.env.VITE_MIDEN_FAUCET_URL ?? "https://faucet-api.testnet.miden.io";
/** localStorage key of the persisted game session. */
export const SESSION_STORAGE_KEY = "miden-battleship.session.v1";
