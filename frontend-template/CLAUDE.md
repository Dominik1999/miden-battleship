# Miden Battleship Frontend

React 19 + TypeScript + Vite 6 frontend for Miden Battleship on testnet, built on `@miden-sdk/react` 0.17.0 and `@miden-sdk/miden-sdk` 0.17.1.

## Project Structure

- `src/lib/masmSources.ts` — `?raw` imports of the MASM contracts through the `@masm` alias (`../project-template/contracts/masm`, see `vite.config.ts` and `vitest.config.ts`); `substituteWord` fills the `{{ISCn}}` / `{{DEFEATn}}` / `{{FORFEITn}}` template placeholders
- `src/lib/contracts.ts` — `ContractCompiler`: computes the initial storage commitment from a throwaway account, compiles the component and scripts with the web SDK's `CodeBuilder`, caches the linked component, exposes the script roots
- `src/lib/game.ts` — client-level flow (fund, setup, handshake, note classification, moves, reclaims, stakes, claims); mirrors `project-template/integration/src/helpers.rs`
- `src/lib/notes.ts` — payload/storage builders, `expected*Note` predictors, note and account construction, direct submission
- `src/lib/session.ts` — the persisted `GameSession` in `localStorage` (seed, ship cells, shot log, stake tier, addresses)
- `src/lib/state.ts` — `readGameState` from account storage; `src/lib/board.ts`, `src/lib/gameplay.ts` — board packing, enemy board from the shot log, forfeit countdown
- `src/lib/funding.ts` — faucet HTTP API client (proof of work), top-up policy; `src/lib/syncHeight.ts` — latest synced block for the UI
- `src/hooks/` — `useGameSession`, `useStartGame`, `useJoinGame`, `useGameplaySync`, `useGameState`, `useBoardState`, `useGameContext`, `useSoundEffects`
- `src/components/` — `AppContent` (screen state machine), `LobbyScreen` (stake tier, resume/discard, reset), `ShipPlacement`, `WaitingScreen`, `GamePlay`, `GameBoard`, `Cell`, `GameStatus` (turn, countdown, forfeit claim, stake status)
- `src/config.ts` — storage slot names (must match `battleship_account.masm`), note sizes, note kinds, deadline and stake constants, timing, fee and faucet constants, `STAKE_TIERS`
- `src/providers.tsx` — `MidenProvider` only (no signer provider)
- `src/__tests__/mocks/` — `miden-sdk.ts` (WASM types as plain classes, `makeTestNote` / `makeTestRecord`) and `miden-sdk-react.ts` (hooks); `src/__tests__/fixtures/battleship.ts` — mock game account storage
- `vite.config.ts` — `midenVitePlugin()`, `@`/`@masm` aliases, `server.fs.allow` for the contracts directory, a Dexie duplicate-version suppressor

## Build, Dev & Test

```
yarn dev             # Start dev server (Vite)
yarn build           # Type check + production build (tsc -b && vite build)
yarn lint            # ESLint
yarn test            # Run all tests once (vitest --run, 76 tests)
yarn test:watch      # Watch mode
yarn test:coverage   # Coverage report
```

Type checking alone: `npx tsc -b --noEmit`

## No Wallet, No Signer

Game accounts are PRIVATE accounts with the battleship component, `BasicWallet` and `NoAuth` (`createGameAccount` in `src/lib/notes.ts`); the player's wallet is a local public `NoAuth` wallet (`createLocalWallet`) that receives defeat/forfeit notes, publishes the stake and claims the prize. Both are funded from the public faucet and pay their own fees, so every transaction is submitted directly (`submitNewTransaction` / `submitNewTransactionWithProver`) with no popup. Do not add a signer provider: `MidenProvider` never initializes behind a disconnected signer provider, and the accounts need none. Integrating the browser extension wallet as the player's wallet is a follow-up.

The client store (IndexedDB) is kept across page loads — it holds the private game account, whose state exists nowhere else — and the rest of the session lives in `localStorage` (`SESSION_STORAGE_KEY`), so a game survives a reload: the lobby offers *Resume game* / *Discard*, and *Reset Client Data* calls `clearMidenStorage()` on request.

## Protocol in the Browser

- **Starter = acceptor, joiner = challenger.** `useStartGame` creates and funds the accounts, waits for the challenge note (it carries the game id), runs setup, consumes the challenge (which verifies the challenger's seed and roots on-chain) and sends the accept note. `useJoinGame` runs setup with a fresh game id, sends the challenge and waits for the accept note; the challenger's first move consumes it and fires turn 1.
- **One transaction per move.** `useGameplaySync` ticks every 3 s: it syncs, classifies pending notes by script root (`classifyNote`), tops up fees, publishes the stake once the handshake is done, and drives the protocol — a shot that sinks my last ship is resolved at once (the component emits the result and the defeat note), a final result is processed at once, otherwise `myTurn` is exposed and `fire()` consumes every pending note and fires (`submitMove`: `withInputNotes` + `withExpectedOutputRecipients` + `fire` script). Once complete, the winner's wallet claims the defeat/forfeit note with both stake notes (`claimNotes`).
- **Deadlines from the wall clock.** The SDK's client wrapper exposes no block header, so `blockTimestamp` uses `Date.now()`; deadlines add `DEADLINE_DELTA_SECONDS + DEADLINE_MARGIN_SECONDS`, and `claimForfeit()` is offered only `CLAIM_MARGIN_SECONDS` past the opponent's deadline (`reclaimNote`).
- **Stakes.** `STAKE_TIERS` (env `VITE_STAKE_TIERS`, default `1000,2000,5000` base units) is picked in the lobby; both players must choose the same amount. `publishStake` sends a stake note from the wallet; the stake expires (becomes refundable) after `STAKE_EXPIRY_DELTA_SECONDS`.

## SDK Usage

The React hooks cover reads: `useAccount(address)` for storage (`useGameState`, `useBoardState`), `useSyncState`. Everything that writes goes through the raw client inside `runExclusive`:

```tsx
const { runExclusive, context } = useGameContext();   // client + ContractCompiler + prover
await runExclusive(() => submitMove(context(), myAddress, move));
```

`src/lib/game.ts` functions take a `GameContext` (`client`, `compiler`, `prover`, `onStatus`, `signal`) and narrow structural client interfaces (`GameClient`, `TxClient`, `AccountClient`) so tests can pass plain objects.

Key SDK calls (all in `src/lib/`):
- `client.createCodeBuilder()` -> `compileAccountComponentCodeWithPath`, `linkDynamicAccountComponentCode`, `compileNoteScript`, `compileTxScript`
- `AccountComponent.compile(code, slots).withSupportsAllTypes()`; `new AccountBuilder(seed).accountType(Private).storageMode(private()).withComponent(c).withBasicWalletComponent().withNoAuthComponent().buildWithoutSchemaCommitment()` — not `build()`, which merges a storage-schema component the Rust builder does not and would change the initial storage commitment the handshake pins; the returned `seed` is carried in the handshake notes
- `client.feeAwareTransactionRequestBuilder(id)` + `withOwnOutputNotes` to publish handshake and stake notes; `new TransactionRequestBuilder().withCustomScript(..).withScriptArg(..).extendAdviceMap(..)` for setup; `withInputNotes(new NoteAndArgsArray(..))` + `withExpectedOutputRecipients` (+ `withCustomScript(fire)`) for a move; `withInputNotes` alone for plain consumes (`consumeNotes`: funding notes, the challenge, wallet claims)
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

vi.mocked(useAccount).mockReturnValue({ account: { storage: () => createMockGameStorage({ phase: 2, expectedTurn: 1, shipsHitCount: 0, totalShotsReceived: 0, role: 2 }) }, ... });
```
See the `testing-patterns` skill for the mock and fixture reference.

## Verification Sequence

1. **TypeScript type check** (auto, per edit)
2. **Affected tests** (auto, per edit)
3. **Full suite + lint + build** before declaring a task done: `yarn test && yarn lint && yarn build`
4. **Browser verification** — two browser profiles (Playwright MCP or Claude in Chrome) against `yarn dev`, playing a full game on testnet; watch the console for `[Contracts]`, `[Notes]`, `[Game]`, `[StartGame]`, `[JoinGame]`, `[GameplaySync]`, `[Funding]` logs. A browser can also play against the Rust CLI (`battleship_cli`)

## Contract Sources

The frontend compiles the contracts from source at runtime; there is nothing to copy. When `project-template/contracts/masm/` changes:
- storage slot names or order -> `src/config.ts` and `battleshipStorageSlots()` in `src/lib/contracts.ts` (the order determines the initial storage commitment; compare with `cargo test -p integration --release --lib print_init_storage_commitment -- --nocapture`)
- note storage layouts -> `src/config.ts` sizes, builders/parsers in `src/lib/notes.ts` and `src/lib/game.ts`
- a new script -> `src/lib/masmSources.ts` and the kind maps in `src/lib/contracts.ts`

`.claude/hooks/check-artifacts.sh` predates the migration (it looks for `.masp` files) and is not used.

## Critical Pitfalls

**wasm-bindgen moves handles passed by value.** A `Felt`, `Word`, `Note`, `AccountId`, `AccountComponent` or script handle passed into a `FeltArray`, `Word.newFromFelts`, `NoteTag` / `NoteMetadata`, a builder or the client is consumed and cannot be reused. Keep field elements as `bigint[]` (`FeltValues`) and create fresh handles at the point of use with `felts()`; clone ids with `cloneId` before `NoteTag.withAccountTarget` / `new NoteMetadata`; fill `NoteArray` / `NoteAssets` with `push`; read `note.id()` and `account.id()` before passing the handle on; `ContractCompiler` hands out a fresh component/script per call and only caches a private library component.

**Setup payload key.** The setup payload's advice-map key is a random word (`randomValues()`); game ids are random words too. The web SDK does expose `Poseidon2.hashElements` if a preimage check is ever wanted.

**One client per player.** A client that tracks both game accounts never sees the note one account creates as an input note of the other. Test with two browser profiles.

**Serialize WASM access.** Every client call runs inside `runExclusive` from `useMiden()`; `useGameplaySync` submits at most one transaction per 3 s tick and skips a tick while busy.

**Remote prover timing.** Proving a battleship transaction takes tens of seconds; `proverTimeoutMs` is 120 s and `autoSyncInterval` is 0 (the hooks sync explicitly).

**COOP/COEP headers are required** for the threaded WASM: `midenVitePlugin()` in dev, `coi-serviceworker` from `index.html` on static hosting.

**Token amounts are bigint**: fee balances, faucet amounts, stakes and all storage values are `bigint`; format with `formatFeeBalance`. React dev tooling cannot serialize bigint props, so components receive pre-formatted labels.

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
3. Use Plan Mode and sub-agents for exploration; keep `src/lib/game.ts` in step with `integration/src/helpers.rs`
