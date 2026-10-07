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
- [ ] Frontend: tests updated (vitest green) + production build
- [ ] Browser test: two profiles, full game, fees paid
- [ ] Update docs (README/CLAUDE/skills refs), lessons, memory

## Session notes (for restarts)
- 2026-10-07 18:50: machine restarted mid-session; scratchpad research reports were lost. Keep research under tasks/research/ from now on.

## Review
(filled at the end)
