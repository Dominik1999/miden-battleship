# Miden Frontend App

React 19 + TypeScript + Vite frontend for the Miden blockchain.

## Project Structure

- `src/` — React application source
- `src/components/` — UI components (Counter, AppContent)
- `src/hooks/` — Custom hooks (useIncrementCounter)
- `src/lib/` — Shared utilities
- `src/__tests__/` — Test infrastructure (mocks, fixtures, patterns)
- `src/components/__tests__/` — Component tests
- `vite.config.ts` — Vite config with midenVitePlugin() from @miden-sdk/vite-plugin
- `vitest.config.ts` — Vitest test runner config
- `package.json` — Dependencies: @miden-sdk/react, @miden-sdk/miden-sdk

## Build, Dev & Test

```
yarn dev             # Start dev server (Vite)
yarn build           # Type check + production build (tsc -b && vite build)
yarn lint            # ESLint
yarn test            # Run all tests once (vitest --run)
yarn test:watch      # Run tests in watch mode (vitest)
yarn test:coverage   # Run tests with coverage report
```

Type checking alone:
```
npx tsc -b --noEmit
```

## SDK Choice: React SDK over Raw WebClient

ALWAYS prefer `@miden-sdk/react` hooks over raw `@miden-sdk/miden-sdk` WebClient methods.
Only use WebClient directly via `useMidenClient()` for operations not covered by hooks.

### Setup (main.tsx or App.tsx)
```tsx
import { MidenProvider } from "@miden-sdk/react";
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter";

<MidenFiSignerProvider appName="My App" autoConnect>
  <MidenProvider config={{ rpcUrl: "testnet", prover: "testnet" }}>
    <App />
  </MidenProvider>
</MidenFiSignerProvider>
```

### Query Hooks
Each returns its own result shape plus `isLoading`, `error`, `refetch`:
```tsx
const { wallets, faucets } = useAccounts();
const { account, assets, getBalance } = useAccount(accountId);
const { notes, consumableNotes } = useNotes();
const { syncHeight, sync } = useSyncState();
const { assetMetadata } = useAssetMetadata(faucetId);
```

### Mutation Hooks
Each returns its own action function plus `isLoading`, `stage`, `error`, `reset`.
Transaction stages: `idle → executing → proving → submitting → complete`
```tsx
const { createWallet } = useCreateWallet();
const { send, stage } = useSend();
const { consume } = useConsume();
const { mint } = useMint();
const { swap } = useSwap();
const { execute } = useTransaction();  // arbitrary tx requests
```

### Token Amounts Are BigInt
```tsx
import { formatAssetAmount, parseAssetAmount } from "@miden-sdk/react";
const display = formatAssetAmount(balance, 8);  // bigint → string
const amount = parseAssetAmount("1.5", 8);       // string → bigint
```

For exhaustive hook API reference, read `node_modules/@miden-sdk/react/CLAUDE.md` and `node_modules/@miden-sdk/react/README.md`.

## TDD Workflow

When building features, follow this test-driven cycle:

1. **Write a failing test** for the feature/component
2. **Run tests** — confirm the test fails (red)
3. **Implement** the minimum code to make the test pass
4. **Run tests** — confirm all tests pass (green)
5. **Refactor** if needed, re-run tests
6. Type checking runs automatically after each edit (PostToolUse hook)
7. Affected tests run automatically after each edit (PostToolUse hook)

### Test file conventions
- Component tests: `src/components/__tests__/ComponentName.test.tsx`
- Hook tests: `src/hooks/__tests__/hookName.test.ts`
- Pattern references: `src/__tests__/patterns/` — copy and adapt these

### Writing tests for Miden components
```tsx
// 1. Mock the SDK at module level (always required)
vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));

// 2. Import hooks to override per-test
import { useAccounts } from "@miden-sdk/react";

// 3. Override in individual tests
vi.mocked(useAccounts).mockReturnValue({ wallets: [], ... });
```

See `testing-patterns` skill for full mock factory reference and fixture data.

## Verification Sequence

Automated verification runs in layers (each catches different failure classes):

1. **TypeScript type check** (auto, per-edit) — catches type errors immediately
2. **Affected tests** (auto, per-edit) — catches logic regressions from changes
3. **Full test suite + type check + build** (auto, on task completion via Stop hook) — catches integration issues
4. **Browser verification** (Playwright MCP / Claude in Chrome) — catches "compiles but doesn't work" failures

### Browser verification (when needed)

Two tools are available for browser verification. Use whichever is appropriate:

#### Playwright MCP (visual verification, no wallet)
Configured in `.mcp.json`. Use for checking that the UI renders correctly, no console errors, layout looks right. Cannot interact with the MidenFi wallet extension.

1. Start dev server: `yarn dev`
2. Use Playwright MCP tools to navigate to `http://localhost:5173`
3. Take a screenshot, check for render errors
4. Check the browser console for errors

#### Claude in Chrome (full verification, with wallet)
Use for wallet-dependent features. Connects to the user's real browser where MidenFi is installed.

1. Start Claude Code with `claude --chrome` (or run `/chrome` in session)
2. Start dev server: `yarn dev`
3. Navigate to `http://localhost:5173`
4. Interact with wallet connect, transaction flows, etc.

## Contract Artifact Handoff

Frontend loads pre-compiled `.masp` packages from `public/packages/` at runtime.

### Artifact location
```
public/packages/
├── counter_account.masp    # Counter account component
└── increment_note.masp     # Increment note script
```

### Building artifacts
In the contract project (e.g., `project-template/`):
```bash
cargo miden build --release
# Copy .masp files from contracts/*/target/miden/release/ to public/packages/
```

### Validate artifacts
```bash
.claude/hooks/check-artifacts.sh
```

### Failure recovery
- **Missing artifacts**: Build contracts with `cargo miden build` or ask the PM to supply the `.masp` files
- **Stale artifacts**: Rebuild and re-copy after contract changes
- **Deserialization failure at runtime**: Version mismatch — rebuild contracts with the SDK version matching `@miden-sdk/miden-sdk` in `package.json`

## Critical Pitfalls

**WASM init must complete first**: Always use MidenProvider's `loadingComponent` or check `useMiden().isReady`. Components rendering before WASM init will crash.

**Recursive WASM access crashes**: Never call client methods concurrently. Use `runExclusive()` from `useMiden()` for sequential execution. Built-in hooks handle this automatically.

**COOP/COEP headers required**: WASM SharedArrayBuffer needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` in vite.config.ts AND production server.

**Token amounts are bigint, not number**: `send({ amount: 1000 })` will fail. Use `amount: 1000n` or `parseAssetAmount("10", 8)`.

## PM Workflow

For non-developer users building with this template:

1. Clone the repository and run `yarn install`
2. Start Claude Code in the project directory
3. Describe the app you want to build in natural language
4. Claude will implement features using TDD — tests are written first, then code
5. Automated hooks verify correctness at every step
6. When Claude says "done", the Stop hook runs full tests + build automatically
7. Review the app in the browser: `yarn dev` → open `http://localhost:5173`
8. If using wallet features, install the MidenFi browser extension to test

### Known limitations
- **Visual correctness**: Automated tests verify structure and behavior, not visual appearance. Review the app in the browser for styling issues.
- **Wallet extension**: Real wallet interactions require the MidenFi browser extension. Tests mock the wallet adapter.
- **Network-dependent features**: Some features (syncing, transaction submission) require testnet connectivity.

## Miden Skills

For Miden-specific guidance, Claude will auto-load these skills when relevant:
- `react-sdk-patterns` — Complete React SDK hook API reference
- `testing-patterns` — Test mock factory, fixtures, and TDD conventions
- `frontend-pitfalls` — All frontend/WASM/browser pitfalls with safe/unsafe examples
- `miden-concepts` — Miden architecture from a developer perspective
- `vite-wasm-setup` — Vite + WASM configuration, deployment headers, troubleshooting
- `signer-integration` — External signer setup (Para, Turnkey, MidenFi)

## General Frontend Skills (Recommended)

For general React, TypeScript, and design capabilities, install these official skills alongside our Miden-specific ones:

```bash
# Vercel's React/design skills
git clone https://github.com/vercel-labs/agent-skills.git
# Install: react-best-practices, web-design-guidelines, composition-patterns

# Anthropic's frontend design skill (Claude Code plugin)
# See: https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design
```

## Advanced Development

For complex applications beyond basic hook usage (custom signers, raw WebClient, advanced note flows):

1. Clone `miden-client` repo alongside this project (see `frontend-source-guide` skill)
2. Use Plan Mode first — Claude explores React SDK source + examples before coding
3. Claude uses sub-agents to explore repos efficiently without filling main context

The basic skills cover ~80% of patterns. Source repos provide the remaining 20% for advanced builders.
