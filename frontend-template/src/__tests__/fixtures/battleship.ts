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
export function createMockGameStorage(opts: {
  phase: number;
  expectedTurn: number;
  shipsHitCount: number;
  totalShotsReceived: number;
  boardCells?: Map<string, number>;
}) {
  const gameConfig = mockWord([10n, 17n, BigInt(opts.phase), BigInt(opts.expectedTurn)]);
  const opponent = mockWord([0n, 0n, BigInt(opts.shipsHitCount), BigInt(opts.totalShotsReceived)]);

  const slotMap: Record<string, ReturnType<typeof mockWord>> = {
    "miden_battleship_account::battleship_account::game_config": gameConfig,
    "miden_battleship_account::battleship_account::opponent": opponent,
  };

  // Build board cells for StorageMap
  const boardMap = new Map<string, ReturnType<typeof mockWord>>();
  if (opts.boardCells) {
    for (const [key, value] of opts.boardCells) {
      boardMap.set(key, mockWord([0n, 0n, 0n, BigInt(value)]));
    }
  }

  return {
    getItem: vi.fn((slotName: string) => slotMap[slotName] ?? null),
    getMapItem: vi.fn((_slotName: string, key: { toU64s: () => bigint[] }) => {
      const k = key.toU64s();
      const mapKey = `${k[2]},${k[3]}`;
      return boardMap.get(mapKey) ?? null;
    }),
  };
}

/** Mock account with game storage in ACTIVE phase */
export function createMockGameAccount(opts: {
  id: string;
  phase?: number;
  expectedTurn?: number;
  shipsHitCount?: number;
  totalShotsReceived?: number;
  boardCells?: Map<string, number>;
}) {
  const storage = createMockGameStorage({
    phase: opts.phase ?? 2,
    expectedTurn: opts.expectedTurn ?? 1,
    shipsHitCount: opts.shipsHitCount ?? 0,
    totalShotsReceived: opts.totalShotsReceived ?? 0,
    boardCells: opts.boardCells,
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
