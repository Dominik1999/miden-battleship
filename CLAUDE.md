# Miden Battleship

This monorepo contains the two halves of the Battleship dApp:

- `project-template/` -- Miden contracts written in Miden Assembly (`contracts/masm/`) plus a Rust integration crate (`integration/`) with MockChain tests, the testnet validation binary and the CLI. Uses `miden-client` 0.17.2, `miden-testing` 0.17.1, `miden-protocol` 0.17.1 and `miden-standards` 0.17.1 on Rust 1.98.1.
- `frontend-template/` -- Miden web frontend (React 19 + TypeScript + Vite 6 + `@miden-sdk/react` 0.17.0 / `@miden-sdk/miden-sdk` 0.17.1). It imports the same MASM sources and compiles them in the browser.

Each half has its own CLAUDE.md with detailed instructions, skills for domain-specific patterns, and hooks for automated verification. These load automatically when you start working in either directory.

## Agent Rules

### Git Commits
- Never amend commits. Create fixup commits or new commits instead.
- Use commit messages exactly as specified by the user, verbatim.
- Never add Co-Authored-By or "Generated with Claude Code" to commits, PRs, or any content.
- Never push without explicit request.

### Workflow
- Enter plan mode for any non-trivial task (3+ steps or architectural decisions). If something goes wrong, stop and re-plan.
- Use subagents for research, exploration, and parallel analysis. One task per subagent.
- After any correction from the user, update `tasks/lessons.md` with the pattern.
- Never mark a task complete without proving it works.
- For non-trivial changes, ask "is there a more elegant way?" Skip this for simple fixes.
- When given a bug report, fix it autonomously.

### Task Management
1. Write plan to `tasks/todo.md` with checkable items
2. Check in with the user before starting implementation
3. Mark items complete as you go
4. Summarize changes at each step
5. Document results in `tasks/todo.md`
6. Capture lessons in `tasks/lessons.md` after corrections

### Core Principles
- **Simplicity first**: Make every change as simple as possible. Minimal code impact.
- **No laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal impact**: Only touch what's necessary.

## Development Workflow

**Contracts first, validate on testnet, then frontend.** Frontend work is gated on the testnet validation binary passing.

1. Write or change the contracts in `project-template/contracts/masm/`
   - One account component (`battleship_account.masm`), five note scripts, three transaction scripts under `scripts/`
   - There is no build step: `BattleshipScripts::compile()` (Rust) and `ContractCompiler` (browser) assemble the sources at runtime with `CodeBuilder`
   - Quick assemble check: `cd project-template && cargo test -p integration --release --lib all_masm_compiles`

2. Validate with MockChain tests
   - Tests live in `project-template/integration/tests/`; the shared harness is `tests/common/mod.rs` (`Game`)
   - The chain charges fees (`verification_base_fee`), so the `NoAuth` fee-payment path is exercised like on testnet
   - Failure tests assert the exact MASM error message with `assert_masm_error`
   - Exit criteria: `cargo test -p integration --release` passes (31 tests)

3. Testnet validation **(GATE -- must pass before frontend)**
   - `cd project-template && cargo run --bin validate_testnet --release`
   - Plays a full game between two independent clients (own store + keystore each), funds both accounts from the public faucet and asserts storage after every step; ~8–9 minutes
   - There is no local-node step: `miden-node` 0.17 has no `bundled` mode. See the `local-node-validation` skill for the testnet checklist
   - Exit criteria: the binary prints `DONE: both accounts COMPLETE`

4. Build the frontend in `frontend-template/`
   - The MASM sources are imported with `?raw` through the `@masm` Vite alias (`../project-template/contracts/masm`); nothing is copied or deployed
   - `src/lib/game.ts` mirrors `validate_testnet.rs` step for step; hooks and components sit on top of it
   - TDD workflow: write tests first, then implement
   - Automated hooks verify type safety and affected tests on every edit

## Which Directory to Work In

| Task | Directory |
|------|-----------|
| Write or edit contracts (MASM) | `project-template/contracts/masm/` |
| Change storage layout, note layouts or compilation | `project-template/integration/src/battleship.rs` (and `frontend-template/src/config.ts`, `src/lib/contracts.ts`) |
| Write or edit MockChain tests | `project-template/integration/tests/` |
| Validate contracts on testnet / play from the terminal | `project-template/integration/src/bin/` |
| Write or edit frontend components | `frontend-template/src/` |
| Write or edit frontend tests | `frontend-template/src/**/__tests__/` |

## Automated Verification

Hooks run automatically on every file edit:
- Editing files in `frontend-template/src/` triggers TypeScript type checking and affected test runs
- `project-template/.claude/hooks/build-contracts.sh` predates the MASM migration (it looks for a `Cargo.toml` next to the edited file) and is a no-op for `.masm` edits; run the MockChain tests instead

On task completion, run the full verification yourself: `cargo test -p integration --release`, then `yarn test`, `yarn lint` and `yarn build` in `frontend-template/`.

## Quick Reference

**Assemble all MASM:**
```
cd project-template && cargo test -p integration --release --lib all_masm_compiles
```

**Run contract tests (MockChain):**
```
cd project-template && cargo test -p integration --release
```

**Cycle counts per transaction:**
```
cd project-template && cargo test -p integration --release --test cycle_benchmark_test -- --nocapture
```

**Testnet validation (full game, two clients):**
```
cd project-template && cargo run --bin validate_testnet --release
```

**Interactive CLI (one terminal per player):**
```
cd project-template && cargo run --bin battleship_cli --release -- --player <name> --role challenger|acceptor --game-id <id> [--opponent <bech32>]
```

**Frontend:**
```
cd frontend-template && yarn dev      # dev server on http://localhost:5173
cd frontend-template && yarn test     # vitest (54 tests)
cd frontend-template && yarn build    # tsc -b && vite build
cd frontend-template && yarn lint
```

## Fees and Funding

Testnet 0.17 charges every transaction a fee in USDCx (the chain's fee asset, 6 decimals). Game accounts are public `NoAuth` accounts with a `BasicWallet`; they are funded from the public faucet HTTP API (`https://faucet-api.testnet.miden.io`: `GET /pow`, solve a SHA-256 proof of work, `GET /get_tokens`; at most 10,000 base units per claim). The first transaction of a fresh account consumes the funding P2ID note and thereby deploys the account. A transaction costs ~105 base units; a full game ~4,200 per account. The Rust helpers top up below `MIN_FEE_BALANCE`, the frontend below `FEE_TOP_UP_THRESHOLD` (`src/config.ts`).

## Pitfalls

- **wasm-bindgen moves handles passed by value.** A `Felt`/`Word`/`Note`/component handle passed into a `FeltArray`, `Word.newFromFelts`, a builder or the client is consumed. Keep values as `bigint[]` and create fresh handles at the point of use (`felts()` in `src/lib/notes.ts`); read `note.id()` before handing the note over; `ContractCompiler` returns a fresh component/script per call.
- **No Poseidon2 hash in the web SDK.** The setup script therefore takes an arbitrary advice-map key as its argument (random word in the browser, the payload's sequential hash in Rust); the commitment is an opaque word.
- **One client per player.** A client tracking both game accounts never sees a component-created note (the result note) from one account as an input note of the other. The validation binary and the CLI use one store + keystore per player; two browser profiles for the frontend.
- **`MidenProvider` never initializes behind a disconnected signer provider.** The frontend uses no signer provider at all (`src/providers.tsx`).
- **Cycle counts** (MockChain, `cycle_benchmark_test`): setup ~31k, shot ~18k, publish ~11k, consume handshake ~14k; all 2^14–2^15 traces. Remote proving takes tens of seconds; the clients use a 120 s (browser) / 300 s (Rust) prover timeout.

## Post-Project Feedback

After completing a project (all tasks done, verification passed), generate a `feedback.md` file in the project root covering:
- What worked well with the agentic tooling (skills, hooks, CLAUDE.md guidance)
- What was missing, confusing, or incorrect
- Suggested improvements to skills, hooks, or documentation
- Patterns that should be captured as new skills or lessons
