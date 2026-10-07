# Migrate miden-battleship to testnet 0.17 (USDCx fees)

Target stack (status.testnet.miden.io, 2026-10-07): node/RPC/prover 0.17.1, fee token USDCx
(mtst1ap8xldq06tm2252qmuky9ha4kunjzkhn), faucet max 10 USDCX.
Current: Rust-SDK contracts (miden 0.12 / cargo-miden 0.8), miden-client 0.14, web SDK 0.14.10.
Target (per user, 2026-10-07): contracts rewritten in MASM (no Rust SDK / cargo-miden / .masp),
compiled at runtime by miden-client 0.17.2 (MockChain tests + local-node gate stay in Rust) and by
web SDK 0.17.1 / react 0.17.0 in the browser. Base docs/workflow on 0xMiden/agentic-template (at 0.16).

## Plan
- [x] Research (3 subagents: MASM, rust client, web sdk) → reports in scratchpad/reports
- [x] Install toolchain: miden-node 0.17.2 (no `bundled` mode any more; validate against testnet instead)
- [x] Contracts: account component + 5 note scripts + 3 tx scripts in MASM under project-template/contracts/masm/ (all assemble: `cargo test -p integration --lib all_masm_compiles`)
- [ ] Contracts: remove the old Rust SDK crates under project-template/contracts/<name>/ and public/packages/*.masp (after tests pass)
- [x] Integration crate: bump to 0.17, lib (battleship.rs, helpers.rs) compiles
- [x] Integration crate: tests rewritten (tests/common harness + battleship_test, battleship_failure_test, cycle_benchmark_test); 31 pass with fees on
- [x] Integration crate: old bins removed; validate_testnet.rs written (deploy_testnet obsolete: accounts are created at runtime)
- [x] Integration crate: battleship_cli.rs rewritten (builds, clippy clean; not yet played on testnet)
- [x] Testnet validation: `cargo run --bin validate_testnet --release` passes (full game, 2 clients, 510 s, ~105 base units fee per tx; log in tasks/research/validate-testnet-run.log)
- [x] Frontend loads MASM sources via `@masm/*.masm?raw` (vite alias to project-template/contracts/masm) and compiles at runtime; result script root computed at runtime
- [x] Frontend: packages bumped to 0.17, libs rewritten (board, contracts, funding, masmSources, notes, config)
- [x] Frontend: hooks/components rewritten on lib/game.ts (typecheck clean)
- [x] Frontend: tests updated (54 vitest tests), tsc, eslint and production build green; wallet adapter removed (MidenProvider never initializes behind a disconnected signer; game accounts need no wallet)
- [x] Browser test: two Playwright profiles (.mcp.json player1/player2), full game to COMPLETE on both sides (VICTORY/DEFEAT, boards revealed and verified), ~4,300 base units fees per account; screenshots in tasks/research/e2e-player{1,2}-final.png
- [x] Update docs (README, ARCHITECTURE, CLAUDE.md x3, skills), lessons, memory, feedback.md

## Session notes (for restarts)
- 2026-10-07 18:50: machine restarted mid-session; scratchpad research reports were lost. Keep research under tasks/research/ from now on.

## Review
- Contracts: 845-line MASM account component + 5 note scripts + 3 tx scripts; shot tx ~18k cycles (2^15), down from ~169k.
- Rust: 31 MockChain tests on a fee-charging chain; `validate_testnet` full game between two clients (510 s); CLI rewritten.
- Frontend: runtime MASM compilation, faucet-funded NoAuth accounts, no wallet adapter, state-derived handshake, auto reveal protocol; 54 vitest tests, tsc/eslint/build green.
- Gates passed: MockChain, testnet validator, two-browser game on testnet.
- Bugs found and fixed on the way: shared-client output notes never become input notes (kb note), wasm-bindgen Felt handle reuse (kb note), MidenProvider stuck behind a disconnected signer (kb note), handshake effect cancellation on stage change, accept-note dedupe across games.
- Left as follow-ups: `.claude/hooks/build-contracts.sh` and `check-artifacts.sh` are pre-migration no-ops; `frontend-template/.claude/skills/{miden-concepts,frontend-pitfalls,vite-wasm-setup}` still mention the Rust SDK / SDK 0.13; game sessions live only in React state (a reload starts over).
