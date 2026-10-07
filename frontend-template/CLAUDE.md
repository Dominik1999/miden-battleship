# Miden Battleship Frontend

React 19 + TypeScript + Vite 6 frontend for Miden Battleship on testnet, built on `@miden-sdk/react` 0.17.0 and `@miden-sdk/miden-sdk` 0.17.1.

## Project Structure

- `src/lib/masmSources.ts` — `?raw` imports of the MASM contracts through the `@masm` alias (`../project-template/contracts/masm`, see `vite.config.ts` and `vitest.config.ts`)
- `src/lib/contracts.ts` — `ContractCompiler`: compiles the component and scripts with the web SDK's `CodeBuilder`, caches the linked component, exposes note script roots
- `src/lib/game.ts` — client-level flow (fund, setup, handshake, shots, results, reveal); mirrors `project-template/integration/src/bin/validate_testnet.rs`
- `src/lib/notes.ts` — payload/storage builders, note and account construction, direct submission
- `src/lib/funding.ts` — faucet HTTP API client (proof of work), top-up policy
- `src/lib/board.ts`, `src/lib/gameplay.ts` — board packing, enemy board, turn arithmetic
- `src/hooks/` — `useStartGame`, `useJoinGame`, `useGameplaySync`, `useFireShot`, `useGameState`, `useBoardState`, `useGameContext`
- `src/components/` — `AppContent` (screen state machine), `LobbyScreen`, `ShipPlacement`, `WaitingScreen`, `GamePlay`, `GameBoard`, `Cell`, `GameStatus`
- `src/config.ts` — storage slot names (must match `battleship_account.masm`), note sizes, timing, fee and faucet constants
- `src/providers.tsx` — `MidenProvider` only (no signer provider)
- `src/__tests__/mocks/` — `miden-sdk.ts` (WASM types as plain classes) and `miden-sdk-react.ts` (hooks); `src/__tests__/fixtures/battleship.ts` — mock game account storage
- `vite.config.ts` — `midenVitePlugin()`, `@`/`@masm` aliases, `server.fs.allow` for the contracts directory, a Dexie duplicate-version suppressor

## Build, Dev & Test

```
yarn dev             # Start dev server (Vite)
yarn build           # Type check + production build (tsc -b && vite build)
yarn lint            # ESLint
yarn test            # Run all tests once (vitest --run, 54 tests)
yarn test:watch      # Watch mode
yarn test:coverage   # Coverage report
```

Type checking alone: `npx tsc -b --noEmit`

## No Wallet, No Signer

Game accounts are public accounts with the battleship component, `BasicWallet` and `NoAuth` (`createGameAccount` in `src/lib/notes.ts`). They are funded from the public faucet and pay their own fees, so every transaction is submitted directly (`submitNewTransaction` / `submitNewTransactionWithProver`) with no popup. Do not add a signer provider: `MidenProvider` never initializes behind a disconnected signer provider, and the game accounts need none.

`main.tsx` calls `clearMidenStorage()` on every page load, so each session starts from an empty IndexedDB; a game does not survive a reload.

## SDK Usage

The React hooks cover reads: `useAccount(address)` for storage (`useGameState`, `useBoardState`), `useSyncState`. Everything that writes goes through the raw client inside `runExclusive`:

```tsx
const { runExclusive, context } = useGameContext();   // client + ContractCompiler + prover
await runExclusive(() => publishShot(context(), myAddress, defenderAddress, row, col, turn));
```

`src/lib/game.ts` functions take a `GameContext` (`client`, `compiler`, `prover`, `onStatus`, `signal`) and narrow structural client interfaces (`GameClient`, `TxClient`) so tests can pass plain objects.

Key SDK calls (all in `src/lib/`):
- `client.createCodeBuilder()` -> `compileAccountComponentCodeWithPath`, `linkDynamicAccountComponentCode`, `compileNoteScript`, `compileTxScript`
- `AccountComponent.compile(code, slots).withSupportsAllTypes()`; `new AccountBuilder(seed).accountType(Public).storageMode(public()).withComponent(c).withBasicWalletComponent().withNoAuthComponent().build()`
- `client.feeAwareTransactionRequestBuilder(id)` + `withOwnOutputNotes` to publish notes; `new TransactionRequestBuilder().withCustomScript(..).withScriptArg(..).extendAdviceMap(..)` for setup; `withInputNotes` + `withExpectedOutputRecipients` to consume a shot; `client.newConsumeTransactionRequest` for plain consumes
- `client.syncState()`, `client.getInputNotes(new NoteFilter(NoteFilterTypes.Committed))`, `client.getTransactions(TransactionFilter.ids([..]))`, `client.feeFaucetId()`
- `NoteTag.withAccountTarget(id)` — the recipient discovers the note during sync; no tag registration

For the full hook API, read `node_modules/@miden-sdk/react/README.md`.

## TDD Workflow

1. **Write a failing test** for the feature/component
2. **Run tests** — confirm it fails (red)
3. **Implement** the minimum code to pass
4. **Run tests** — all green
5. **Refactor**, re-run
6. Type checking and affected tests run automatically after each edit (PostToolUse hooks)

### Test file conventions
- Component tests: `src/components/__tests__/ComponentName.test.tsx`
- Hook tests: `src/hooks/__tests__/hookName.test.ts`
- Library tests: `src/lib/__tests__/module.test.ts` (pure functions and the `game.ts` flow against a fake client)

### Writing tests for Miden components
```tsx
vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));
vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));
import { useAccount } from "@miden-sdk/react";
import { createMockGameStorage } from "@/__tests__/fixtures/battleship";

vi.mocked(useAccount).mockReturnValue({ account: { storage: () => createMockGameStorage({ phase: 2, expectedTurn: 1, shipsHitCount: 0, totalShotsReceived: 0 }) }, ... });
```
See the `testing-patterns` skill for the mock and fixture reference.

## Verification Sequence

1. **TypeScript type check** (auto, per edit)
2. **Affected tests** (auto, per edit)
3. **Full suite + lint + build** before declaring a task done: `yarn test && yarn lint && yarn build`
4. **Browser verification** — two browser profiles (Playwright MCP or Claude in Chrome) against `yarn dev`, playing a full game on testnet; watch the console for `[Game]`, `[GameplaySync]`, `[Funding]` logs

## Contract Sources

The frontend compiles the contracts from source at runtime; there is nothing to copy. When `project-template/contracts/masm/` changes:
- storage slot names -> `src/config.ts`
- note storage layouts -> `src/config.ts` sizes, builders/parsers in `src/lib/notes.ts` and `src/lib/game.ts`
- a new script -> `src/lib/masmSources.ts` and the kind maps in `src/lib/contracts.ts`

`.claude/hooks/check-artifacts.sh` predates the migration (it looks for `.masp` files) and is not used.

## Critical Pitfalls

**wasm-bindgen moves handles passed by value.** A `Felt`, `Word`, `Note`, `AccountComponent` or script handle passed into a `FeltArray`, `Word.newFromFelts`, a builder or the client is consumed and cannot be reused. Keep field elements as `bigint[]` (`FeltValues`) and create fresh handles at the point of use with `felts()`; read `note.id()` before passing the note on; `ContractCompiler` hands out a fresh component/script per call and only caches a private library component.

**Setup payload key.** The setup payload's advice-map key is a random word (`randomValues()`); commitments and game ids are random words too. The web SDK does expose `Poseidon2.hashElements` if a preimage check is ever wanted.

**One client per player.** A client that tracks both game accounts never sees the result note one account creates as an input note of the other. Test with two browser profiles.

**Serialize WASM access.** Every client call runs inside `runExclusive` from `useMiden()`; `useGameplaySync` handles one note per 3 s tick and skips a tick while busy.

**Remote prover timing.** Proving a battleship transaction takes tens of seconds (setup ~31k, shot ~18k cycles); `proverTimeoutMs` is 120 s and `autoSyncInterval` is 0 (the hooks sync explicitly).

**COOP/COEP headers are required** for the threaded WASM: `midenVitePlugin()` in dev, `coi-serviceworker` from `index.html` on static hosting.

**Token amounts are bigint**: fee balances, faucet amounts and all storage values are `bigint`; format with `formatFeeBalance`.

## Miden Skills

- `react-sdk-patterns` — React SDK hook API reference
- `testing-patterns` — Test mocks, fixtures, and TDD conventions
- `frontend-pitfalls` — Frontend/WASM/browser pitfalls
- `miden-concepts` — Miden architecture from a developer perspective
- `vite-wasm-setup` — Vite + WASM configuration, deployment headers, troubleshooting
- `signer-integration` — External signers (not used by this app; read before adding one)
- `frontend-source-guide` — Exploring the miden-client source for web-client methods

## Advanced Development

For questions beyond the skills (exact `WebClient` method signatures, `CodeBuilder` options, request builder methods):

1. Read `node_modules/@miden-sdk/miden-sdk/dist/st/index.d.ts` (and `api-types.d.ts`) first — the web-client API is typed
2. Clone `miden-client` at the matching version (see `frontend-source-guide`) for the Rust side of the bindings
3. Use Plan Mode and sub-agents for exploration; keep `src/lib/game.ts` in step with `validate_testnet.rs`
