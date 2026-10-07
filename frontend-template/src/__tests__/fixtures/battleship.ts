/**
 * Realistic battleship game account fixtures for tests.
 * Mock storage objects that mirror what the SDK returns from account.storage().
 */

import { vi } from "vitest";

export const GAME_ACCOUNT_A_ID = "mtst1qy35qfqdvpjx2e5zf9hkp4vr";
export const GAME_ACCOUNT_B_ID = "mtst1qa7k9qjf8dp4x2e5zf9hkp5vr";

/** Mock Word (4-element array with toU64s()) */
function mockWord(values: [bigint, bigint, bigint, bigint]) {
  return {
    toU64s: () => values,
    0: values[0],
    1: values[1],
    2: values[2],
    3: values[3],
  };
}

/**
 * Creates a mock account.storage() for a game account.
 * game_config = [grid_size, num_placed, phase, expected_turn]
 * opponent = [opp_prefix, opp_suffix, ships_hit_count, total_shots_received]
 */
export interface MockGameStorageOptions {
  phase: number;
  expectedTurn: number;
  shipsHitCount: number;
  totalShotsReceived: number;
  shotsFired?: number;
  resultsProcessed?: number;
  role?: number;
  outcome?: number;
  lastShot?: [number, number, number];
  /** [prefix, suffix] of the opponent game account. */
  opponent?: [bigint, bigint];
  ownerWallet?: [bigint, bigint];
  opponentWallet?: [bigint, bigint];
  boardCells?: Map<string, number>;
}

export function createMockGameStorage(opts: MockGameStorageOptions) {
  const SLOT = "miden_battleship_account::battleship_account";
  const gameConfig = mockWord([10n, 17n, BigInt(opts.phase), BigInt(opts.expectedTurn)]);
  const [op, os] = opts.opponent ?? [0n, 0n];
  const opponent = mockWord([op, os, BigInt(opts.shipsHitCount), BigInt(opts.totalShotsReceived)]);
  const last = opts.lastShot ?? [0, 0, 0];

  const slotMap: Record<string, ReturnType<typeof mockWord>> = {
    [`${SLOT}::game_config`]: gameConfig,
    [`${SLOT}::opponent`]: opponent,
    [`${SLOT}::turn_state`]: mockWord([BigInt(opts.shotsFired ?? 0), BigInt(opts.resultsProcessed ?? 0), BigInt(opts.role ?? 0), 0n]),
    [`${SLOT}::last_shot`]: mockWord([BigInt(last[0]), BigInt(last[1]), BigInt(last[2]), 0n]),
    [`${SLOT}::outcome`]: mockWord([BigInt(opts.outcome ?? 0), 0n, 0n, 0n]),
    [`${SLOT}::owner_wallet`]: mockWord([...(opts.ownerWallet ?? [0n, 0n]), 0n, 0n] as [bigint, bigint, bigint, bigint]),
    [`${SLOT}::opponent_wallet`]: mockWord([...(opts.opponentWallet ?? [0n, 0n]), 0n, 0n] as [bigint, bigint, bigint, bigint]),
  };

  // Pack board cells into per-row map entries matching how board.ts reads them:
  // key [0, 0, 0, row] -> [packed_row, 0, 0, 0], packed |= (cellState << (col * 3)).
  const rowPacked = new Map<number, bigint>();
  for (const [key, value] of opts.boardCells ?? []) {
    const [rowStr, colStr] = key.split(",");
    const row = parseInt(rowStr);
    const col = parseInt(colStr);
    const current = rowPacked.get(row) ?? 0n;
    rowPacked.set(row, current | (BigInt(value) << (BigInt(col) * 3n)));
  }

  return {
    getItem: vi.fn((slotName: string) => {
      const word = slotMap[slotName];
      return word ? { ...word, toFelts: () => word.toU64s().map((v) => ({ asInt: () => v })) } : undefined;
    }),
    getMapItem: vi.fn((slotName: string, key: { toU64s(): ArrayLike<bigint> }) => {
      if (slotName !== "miden_battleship_account::battleship_account::my_board") return undefined;
      const packed = rowPacked.get(Number(key.toU64s()[3]));
      return packed === undefined ? undefined : mockWord([packed, 0n, 0n, 0n]);
    }),
  };
}

/** Mock account with game storage in ACTIVE phase */
export function createMockGameAccount(opts: Partial<MockGameStorageOptions> & { id: string }) {
  const storage = createMockGameStorage({
    ...opts,
    phase: opts.phase ?? 2,
    expectedTurn: opts.expectedTurn ?? 1,
    shipsHitCount: opts.shipsHitCount ?? 0,
    totalShotsReceived: opts.totalShotsReceived ?? 0,
  });

  return {
    id: opts.id,
    nonce: 1n,
    bech32id: () => opts.id,
    storage: () => storage,
  };
}

/** Default mock game accounts for tests */
export const MOCK_GAME_ACCOUNT_A = createMockGameAccount({
  id: GAME_ACCOUNT_A_ID,
  phase: 2,
  expectedTurn: 3,
  shipsHitCount: 1,
  totalShotsReceived: 1,
});

export const MOCK_GAME_ACCOUNT_B = createMockGameAccount({
  id: GAME_ACCOUNT_B_ID,
  phase: 2,
  expectedTurn: 4,
  shipsHitCount: 0,
  totalShotsReceived: 1,
});
