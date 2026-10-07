# Private boards, forfeits and stakes (spec: docs/superpowers/specs/2026-10-07-private-boards-and-stakes-design.md, plan: docs/superpowers/plans/2026-10-07-private-boards-and-stakes.md)

Decisions (user, 2026-10-07): private game accounts with a seed-anchored handshake; a player who does not move for
12 h loses by forfeit (reclaimable notes, no second signature); delegated proving with NoAuth game accounts (the prover
is trusted); stakes as conditional notes claimed by the winner's wallet; sessions persist across reloads.

## Plan
- [x] Task 1: storage layout, setup and handshake with seed, wallet and roots (MASM + Rust bindings)
- [x] Task 2: component-created shots and results (fire_shot / process_shot / process_result)
- [x] Task 3: remove the reveal protocol
- [x] Task 4: forfeits, defeat and forfeit notes (12-hour deadlines on shot and result notes)
- [x] Task 5: stake note (claimed with a defeat or forfeit note, refundable after 60 days)
- [x] Task 6: Rust clients — helpers, `validate_testnet` (passes on testnet in ~344 s: stakes, early reclaim rejected, 33 moves, claim), `battleship_cli` (--stake, forfeit claim)
- [x] Task 7: frontend libraries (contracts with the throwaway-account storage commitment, notes, game, state, session persistence)
- [x] Task 8: hooks and screens (one-transaction moves, forced resolutions, forfeit countdown and claim, resume from the lobby)
- [~] Task 9: stakes via the local NoAuth wallet (publish, match, claim) — done; the browser-extension wallet adapter is NOT wired (see follow-ups)
- [x] Task 10: two-browser staked game on testnet (Playwright, code frozen after the fixes), Rust CLI vs browser game on testnet, docs, feedback

## Verification log
- `cargo test -p integration --release`: 30 MockChain tests + 4 lib tests green; clippy --all-targets and nightly fmt clean.
- `cargo run --bin validate_testnet --release`: DONE in 344 s (log: tasks/research/validate-testnet-private-stakes.log).
- Frontend: tsc, eslint, 76 vitest tests, vite build green.
- Browser e2e (two Playwright profiles, stake 1000 base units each): handshake, stakes locked, 17 hits / 16 misses, DEFEAT / VICTORY, winner's wallet consumed the defeat note + both stakes in one transaction; three resumes from the persisted session during the run.
- Interop: `battleship_cli --role challenger --stake 0` (Rust) vs the browser as host: handshake verified the seed/roots across implementations, 17 hits, CLI "YOU WIN", browser "DEFEAT". Requires `buildWithoutSchemaCommitment()` in the browser (the initial storage commitment now matches Rust's).

## Follow-ups
- Wallet-extension custody (mainnet): wire `@miden-sdk/miden-wallet-adapter-{base,react}` outside the Miden provider for the stake/claim transactions (`publishStake`/`claimNotes` already take any wallet address) and a P2ID fee top-up of the game account from the wallet; the local NoAuth wallet stays the testnet path. Blocked on testing with the extension installed.
- Stake tier agreement is out of band: the challenge note cannot carry the tier (fixed 28-item storage); the UI gates the first shot on a matching opponent stake note.
- Testnet left eight extra 1000-unit stake notes from the first e2e attempt (a consumed handle threw after each submit); they refund to their wallet after 60 days.
- `GameStatus` strings are formatted outside the component because React 19's dev-mode render logging cannot serialize bigint props.
