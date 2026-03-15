/**
 * Realistic account fixtures for Miden frontend tests.
 * Uses bech32 IDs and BigInt amounts matching real SDK shapes.
 */

export const WALLET_ID_1 = "mtst1qy35qfqdvpjx2e5zf9hkp4vr";
export const WALLET_ID_2 = "mtst1qa7k9qjf8dp4x2e5zf9hkp5vr";
export const FAUCET_ID = "mtst1qx9y8zjf2dp4x2e5zf9hkp3vr";
export const COUNTER_ID = "mtst1aru8adnrqspgcsr3drk2n990lyc070ll";

export const MOCK_WALLET_HEADER = {
  id: WALLET_ID_1,
  nonce: 1n,
  storageCommitment: "0x0000000000000000000000000000000000000000000000000000000000000001",
};

export const MOCK_WALLET_HEADER_2 = {
  id: WALLET_ID_2,
  nonce: 0n,
  storageCommitment: "0x0000000000000000000000000000000000000000000000000000000000000000",
};

export const MOCK_FAUCET_HEADER = {
  id: FAUCET_ID,
  nonce: 5n,
  storageCommitment: "0x0000000000000000000000000000000000000000000000000000000000000005",
};

export const MOCK_ASSET_BALANCE = {
  assetId: FAUCET_ID,
  amount: 1000000000n, // 10.0 tokens with 8 decimals
  symbol: "TEST",
  decimals: 8,
};

export const MOCK_ASSET_BALANCE_EMPTY = {
  assetId: FAUCET_ID,
  amount: 0n,
  symbol: "TEST",
  decimals: 8,
};

export const MOCK_ACCOUNT = {
  id: WALLET_ID_1,
  nonce: 1n,
  bech32id: () => WALLET_ID_1,
};

export const MOCK_ASSET_METADATA = {
  assetId: FAUCET_ID,
  symbol: "TEST",
  decimals: 8,
};

export const MOCK_TRANSACTION_RESULT = {
  transactionId: "0xabc123def456789012345678901234567890123456789012345678901234abcd",
};
