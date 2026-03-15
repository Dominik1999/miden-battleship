# Phase 3: Battleship Frontend

## Implementation Steps

- [x] 1. Create `deploy_testnet.rs` — deploy game accounts on testnet
- [x] 2. Copy `shot_note.masp`, remove old counter artifacts
- [x] 3. Types (`src/types/game.ts`) + config (`src/config.ts`)
- [x] 4. Test fixtures (`src/__tests__/fixtures/battleship.ts`)
- [x] 5. `useGameState` hook + test
- [x] 6. `useBoardState` hook + test
- [x] 7. `useSoundEffects` hook (Web Audio API)
- [x] 8. `Cell` + `GameBoard` components + tests
- [x] 9. `GameStatus` component
- [x] 10. `useFireShot` hook + test
- [x] 11. `useAutoSync` hook
- [x] 12. `GamePlay` component + test
- [x] 13. `GameSelect` component + test
- [x] 14. `AppContent` rewrite + `App.tsx` update
- [x] 15. CSS styling (index.css + component CSS)
- [x] 16. Verification (typecheck + tests + browser)

## Results

- TypeScript: compiles clean (`npx tsc -b --noEmit`)
- Tests: 38 passed, 10 test files (`npx vitest --run`)
- Old counter code removed, shot_note.masp copied

## Pending (requires testnet deployment)

- Run `deploy_testnet.rs` to get real game account addresses
- Update `config.ts` with deployed addresses and result_script_root
- Browser verification with Playwright MCP
