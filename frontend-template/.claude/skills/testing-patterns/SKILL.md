---
name: testing-patterns
description: Testing conventions, mock factory, fixtures, and TDD workflow for Miden frontend development. Covers Vitest + testing-library setup, @miden-sdk/react module mocking, realistic fixture data, test patterns for query and mutation hooks, and the automated verification pipeline. Use when writing, running, or debugging tests for Miden React components.
---

# Miden Frontend Testing Patterns

## Test Stack

- **Vitest** — Test runner (extends Vite config for consistent behavior)
- **@testing-library/react** — Component rendering and queries
- **@testing-library/user-event** — User interaction simulation
- **@testing-library/jest-dom** — DOM assertion matchers (toBeInTheDocument, toBeDisabled, etc.)
- **jsdom** — Browser environment for tests

## Mock Factory: `@miden-sdk/react`

All Miden SDK hooks are mocked via `src/__tests__/mocks/miden-sdk-react.ts`. This module exports mock implementations of every hook with realistic default return values.

### Usage in test files

```tsx
// 1. Mock the entire module (hoisted to top by vitest)
vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));

// 2. Import hooks you want to override
import { useAccounts, useSend } from "@miden-sdk/react";

// 3. Override per-test
it("shows empty state", () => {
  vi.mocked(useAccounts).mockReturnValue({
    accounts: [],
    wallets: [],
    faucets: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  render(<MyComponent />);
});
```

### Default mock return values

**Query hooks** return populated data by default:
- `useAccounts()` — 2 wallets, 1 faucet
- `useAccount()` — account with 10.0 TEST token balance
- `useNotes()` — 1 input note, 1 consumable note
- `useSyncState()` — syncHeight: 12345, not syncing
- `useAssetMetadata()` — TEST token metadata (symbol, decimals: 8)
- `useMiden()` — isReady: true

**Mutation hooks** return idle state by default:
- `useSend()` — `{ send: vi.fn(), stage: "idle", isLoading: false }`
- `useMint()`, `useConsume()`, `useSwap()`, `useTransaction()` — similar pattern
- `useCreateWallet()` — `{ createWallet: vi.fn(), isCreating: false }`

### Simulating transaction stages

```tsx
// Show "proving" stage
vi.mocked(useSend).mockReturnValue({
  send: vi.fn(),
  result: null,
  isLoading: true,
  stage: "proving",
  error: null,
  reset: vi.fn(),
});

// Show completed transaction
vi.mocked(useSend).mockReturnValue({
  send: vi.fn(),
  result: { transactionId: "0xabc123" },
  isLoading: false,
  stage: "complete",
  error: null,
  reset: vi.fn(),
});
```

## Fixtures

Realistic test data in `src/__tests__/fixtures/`:

```tsx
import {
  WALLET_ID_1,           // "mtst1qy35qfqdvpjx2e5zf9hkp4vr"
  WALLET_ID_2,           // "mtst1qa7k9qjf8dp4x2e5zf9hkp5vr"
  FAUCET_ID,             // "mtst1qx9y8zjf2dp4x2e5zf9hkp3vr"
  MOCK_WALLET_HEADER,    // { id, nonce, storageCommitment }
  MOCK_FAUCET_HEADER,    // { id, nonce, storageCommitment }
  MOCK_ASSET_BALANCE,    // { assetId, amount: 1000000000n, symbol: "TEST", decimals: 8 }
  MOCK_ACCOUNT,          // { id, nonce, bech32id() }
  MOCK_TRANSACTION_RESULT, // { transactionId: "0x..." }
  MOCK_NOTE_SUMMARY,    // { id, assets, sender }
} from "@/__tests__/fixtures";
```

Battleship-specific fixtures (`GAME_ACCOUNT_A_ID`, `GAME_ACCOUNT_B_ID`, `createMockGameStorage`) live in `src/__tests__/fixtures/battleship.ts`.

Key characteristics:
- Account IDs use bech32 format (`mtst1...`)
- Amounts are `bigint` (e.g., `1000000000n` = 10.0 with 8 decimals)
- Asset metadata uses TEST token with 8 decimals

## Test Patterns (copy-adaptable)

Reference tests in this project:

| Pattern | File | Tests |
|---------|------|-------|
| Pure helpers | `src/lib/__tests__/board.test.ts`, `notes.test.ts` | packing, storage builders, result encoding |
| Flow against a fake client | `src/lib/__tests__/game.test.ts` | note parsing, classification and discovery, commit polling, setup request, shot publishing, result recipient |
| Faucet HTTP client | `src/lib/__tests__/funding.test.ts` | PoW, retries, top-up policy |
| Hooks reading storage | `src/hooks/__tests__/useGameState.test.ts`, `useBoardState.test.ts` | phase/turn parsing, board rendering |
| Hook with a mutation | `src/hooks/__tests__/useFireShot.test.ts` | success, error, busy state |
| Components | `src/components/__tests__/*.test.tsx` | rendering, interactions |

### Minimum test coverage per component

Every component test should cover:
1. **Success state** — renders correctly with data
2. **Loading state** — shows loading indicator
3. **Error state** — shows error message, recovery action
4. **User interactions** — buttons, forms trigger correct handler calls

## Mocking the WASM SDK (`@miden-sdk/miden-sdk`)

The app builds notes, accounts and transaction requests with the raw SDK types, so tests mock that module too, with `src/__tests__/mocks/miden-sdk.ts`: plain-object stand-ins for `Felt`, `Word`, `FeltArray`, `AccountId`, `Address`, `NoteTag`, `Note`, `NoteRecipient`, `NoteStorage`, `TransactionRequestBuilder`, `AccountBuilder`, `AccountComponent`, filters and so on, plus two factories:

```tsx
vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));
import { makeTestNote, makeTestRecord } from "@/__tests__/mocks/miden-sdk";

const shot = makeTestNote({ sender: OPPONENT, target: ME, root: SHOT_ROOT, storage: [0n, 0n, 1n, ...serial, ...resultRoot] });
const record = makeTestRecord(shot);                       // InputNoteRecord-like, unconsumed
```

The flow functions in `src/lib/game.ts` take narrow structural client interfaces (`GameClient`, `TxClient`) and a `ContractCompiler`, so `src/lib/__tests__/game.test.ts` drives a whole handshake or shot against a hand-written fake client — no WASM, no network. The faucet client in `src/lib/funding.ts` takes a `fetchImpl` and a `sleep` for the same reason.

There is no wallet adapter and no signer provider to mock: game accounts are `NoAuth` accounts that submit transactions directly.

### Game account storage fixtures

`src/__tests__/fixtures/battleship.ts` builds the `account.storage()` shape the hooks read:

```tsx
import { createMockGameStorage, GAME_ACCOUNT_A_ID, GAME_ACCOUNT_B_ID } from "@/__tests__/fixtures/battleship";

vi.mocked(useAccount).mockReturnValue({
  account: { storage: () => createMockGameStorage({ phase: 2, expectedTurn: 1, shipsHitCount: 3, totalShotsReceived: 5 }) },
  ...
});
```

`game_config = [grid_size, num_placed, phase, expected_turn]`, `opponent = [prefix, suffix, ships_hit_count, total_shots_received]`, `reveal_status = [my_revealed, opponent_verified, 0, 0]`, and the `my_board` map answers `getMapItem(slot, [0,0,0,row])` with a packed row.

## Automated Verification Pipeline

Hooks in `.claude/settings.json` enforce quality automatically:

1. **PostToolUse: typecheck** — `npx tsc -b --noEmit` on every `.ts`/`.tsx` edit in `src/`
2. **PostToolUse: affected tests** — `npx vitest --changed --run` on every `.ts`/`.tsx` edit in `src/`
3. **Before declaring a task done** — run `yarn test && yarn lint && yarn build` yourself (the `Stop` hook list in `.claude/settings.json` is empty)

If a PostToolUse hook fails (exit code 2), the agent is blocked from proceeding until the issue is fixed.

## TDD Flow

```
1. Write test (describe expected behavior)
   ↓
2. yarn test           → RED (test fails)
   ↓
3. Implement code
   ↓
4. Auto hooks fire     → typecheck + affected tests
   ↓
5. yarn test           → GREEN (all pass)
   ↓
6. Refactor if needed
   ↓
7. Task complete       → yarn test && yarn lint && yarn build
```

## Common Mistakes

**Forgetting vi.clearAllMocks()**: Always call in `beforeEach` to prevent mock state leaking between tests.

**Not mocking the SDK**: Components importing from `@miden-sdk/react` will fail without `vi.mock()` because the real SDK requires WASM initialization.

**Using number instead of bigint**: Mock amounts must use `bigint` (`1000n`, not `1000`). The SDK enforces this at the type level.

**Testing implementation details**: Test what the user sees (text, buttons, states), not internal hook calls. Use `screen.getByRole`, `screen.getByText`, not internal component state.
