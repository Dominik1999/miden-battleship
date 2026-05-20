# Lessons Learned

## Miden Wallet Accounts Must Exist On-Chain Before App Can Import Them

**Date:** 2025-05-08

**Problem:** The battleship app's `MidenProvider` initialization fails with `"failed to import public account: account with id ... not found on the network"` when using a freshly installed MidenFi wallet.

**Root Cause:** The React SDK's `initializeSignerAccount()` calls `client.importAccountById(walletAddress)` during initialization. This RPC call expects the account to already exist on the testnet. A brand-new wallet has a local keypair but no on-chain account — the account only appears on-chain after its first transaction (e.g., receiving tokens from a faucet).

**Chain of events:**
1. `main.tsx` calls `clearMidenStorage()` on every page load (fresh start each session)
2. `MidenFiSignerProvider` auto-connects and provides the wallet address
3. `MidenProvider` → `initializeSignerAccount()` → `client.importAccountById(address)` → RPC call fails because account doesn't exist on-chain yet

**Fix:** Before using the battleship app with a new wallet:
1. Open the wallet extension → Faucet
2. Click "Go to Faucet" → opens `https://faucet.testnet.miden.io/`
3. Click "Connect Wallet" to auto-fill address (approve wallet popup)
4. Click "Send Public Note" to mint 100 tokens
5. Wait for "Tokens Minted!" confirmation
6. Go back to wallet and sync/claim the tokens
7. Now reload the battleship app — the account exists on-chain and import will succeed

**Key insight:** On Miden, wallet accounts are not automatically deployed. They only materialize on-chain after their first transaction (similar to account abstraction on Ethereum where counterfactual addresses need a deployment tx).

## Testnet Remote Prover Can Time Out During Transaction Proving

**Date:** 2026-05-08

**Problem:** During the battleship game handshake (note consumption), Player 1 got `"failed to prove transaction: transaction proving failed: Request timed out"` (gRPC `DeadlineExceeded`). The UI stuck at "Consuming..." with the button disabled.

**Root Cause:** The app uses `prover: "testnet"` (config.ts:41) which sends transactions to the Miden testnet prover service for remote proving. The remote prover hit a gRPC deadline timeout — either overloaded, slow, or the transaction was too complex for the timeout window.

**Impact:** The note consumption transaction was never proved or submitted, leaving the game in a broken handshake state. Player 1 is stuck at "Opponent found! Completing handshake..." and Player 2 is stuck at "Waiting for opponent to accept..."

**Possible fixes:**
1. **Retry** — Reload the page and try consuming again (if the prover timeout was transient)
2. **Switch to local proving** — Set `VITE_MIDEN_PROVER=local` in `.env.local` to prove in-browser via WASM (slower but doesn't depend on remote service)
3. **Increase timeout** — If configurable in the SDK, increase the gRPC deadline for prover requests

**Key insight:** Remote proving is faster when it works but introduces a network dependency. For development/testing, local proving may be more reliable despite being slower.

## Local Prover Crashes With "capacity overflow" on Complex Transactions

**Date:** 2026-05-08

**Problem:** When Player 1 (starter) tries to consume the challenge note during the battleship handshake with `VITE_MIDEN_PROVER=local`, the WASM local prover panics with `capacity overflow` inside `miden_prover::prove` → `alloc::raw_vec::capacity_overflow`.

**Root Cause:** The WASM heap runs out of allocatable memory when trying to prove a complex transaction (consuming setup + challenge notes during the game handshake). The `LocalTransactionProver` in `miden_tx::prover` attempts to allocate a vector that exceeds WASM's 4GB address space limit, triggering a Rust panic.

**Impact:** Neither proving strategy works for the handshake transaction:
- **Remote prover** (`testnet`): gRPC `DeadlineExceeded` timeout
- **Local prover** (`local`): WASM `capacity overflow` panic

**Possible causes:**
1. The battleship handshake transaction may consume multiple notes in a single transaction, making the proof too large
2. The game account component (with board storage, commitments, etc.) may make the transaction kernel too complex
3. SDK version 0.14.5 may have a regression in prover memory usage

**Resolution:** Root cause identified — see next lesson.

## Battleship TX Proving Takes ~32s — Remote Prover Default Timeout is 10s

**Date:** 2026-05-08

**Problem:** Both local and remote proving fail for battleship note consumption transactions:
- Remote (testnet): `DeadlineExceeded` at exactly 10s — the `RemoteTransactionProver` has a hardcoded 10s default timeout (`miden-remote-prover-client-0.14.9/src/remote_prover/tx_prover.rs:45`)
- Local (WASM): `capacity overflow` — needs ~4.6GB RAM, exceeds WASM's ~4GB memory limit

**Verified:** When the remote prover timeout is increased to 120s (via Rust test binary), the battleship TX proves successfully in ~31.76s.

**Fix:** Add `proverTimeoutMs: 120_000` to MidenProvider config and use `testnet` prover (not `local`):
```tsx
<MidenProvider config={{
  rpcUrl: "testnet",
  prover: "testnet",
  proverTimeoutMs: 120_000,  // 2 minutes — battleship TXs take ~32s
  ...
}}>
```

**Additional finding:** The SDK's `useConsume()` hook uses `submitNewTransactionWithProver()` which combines execution + proving + submission in one call (unlike `useSend()` which separates stages). It also does NOT use `proveWithFallback()`, so there's no automatic fallback to local prover if the remote one fails.

**Key insight:** Local WASM proving is infeasible for complex transactions (battleship). Always use the remote testnet prover with a generous timeout. Simple transactions (like P2ID transfers) prove in ~2.5s, but battleship state transitions need ~32s.

## Gameplay Auto-Sync Hits Concurrent WASM Access Bug (wasm_bindgen::borrow_fail)

**Date:** 2026-05-08

**Problem:** During gameplay, Player 1 (starter) receives Player 2's shot note but can't process it. The auto-sync in `useGameplaySync` triggers a concurrent WASM access error: `"recursive use of an object detected which would lead to unsafe aliasing in rust"` (`wasm_bindgen::borrow_fail`). Player 1 gets stuck at "Opponent's turn..." even though the shot was submitted.

**Root Cause:** This is the known wasm-bindgen ownership bug (miden-client#2121 / web-sdk#138). The auto-sync and auto-consume operations fire concurrently — both try to access the WebClient WASM object at the same time, causing an aliasing violation. The `runExclusive()` guard may not fully prevent concurrent access during gameplay sync cycles.

**Impact:** Turn-based gameplay is broken — the receiving player can't process incoming shots, so turns never advance.

**Status:** Known SDK bug. Filed as 0xMiden/web-sdk#139 with full repro steps. Also related to web-sdk#138 (merged but possibly not fully fixed in 0.14.5). This is the sole remaining blocker for end-to-end gameplay.

**Verified 2026-05-09:** After the packed board optimization (720K→169K cycles), the handshake completes without prover timeouts. But gameplay still breaks on the first shot due to this borrow_fail bug. A full game cannot complete until this SDK bug is fixed.

## Always Verify Reproduction Cases Before Presenting Them

**Date:** 2026-05-20

**Problem:** Created and published a standalone repro repo (miden-sync-repro) for web-sdk#148 without actually running it to confirm it reproduces the bug. The repro was invalid — it didn't include the periodic poll sync loop that causes the race condition, so it would have succeeded every time. This wasted time and credibility.

**Root Cause:** Rushed to create the repro based on an incorrect hypothesis (SDK sync bug) without verifying the hypothesis first. The real bug was an app-level sync race between polling sync and consume-flow sync. A repro without the polling loop can't reproduce the race.

**Compounding mistake:** Also misattributed the bug to the pagination logic in miden-client (sync_notes_with_details early termination), filed a PR (#2180) based on this wrong hypothesis, and closed it when told #2170 superseded it — but #2170 didn't fix our bug either.

**Rule:** Before presenting any reproduction case, bug report, or fix:
1. **Run the repro** and confirm it actually fails
2. **Verify the hypothesis** — does the proposed root cause explain ALL observations?
3. **Check your fix** — does disabling the fix re-introduce the bug?
4. If you can't run the repro (e.g., needs testnet), say so explicitly instead of presenting unverified work as confirmed

**Key insight:** An unverified repro is worse than no repro — it sends investigators down the wrong path. Time spent verifying is always less than time wasted on wrong hypotheses.

## Poll Sync Race: sync_height Advances Past Wallet-Submitted Notes

**Date:** 2026-05-20

**Problem:** ~50% of handshake attempts failed with "Some notes could not be found for provided IDs" — the setup note submitted via wallet adapter was never discovered by the local client's syncState().

**Root Cause:** App-level sync race, NOT an SDK bug. The periodic poll sync loop (checking for opponent) could fire between wallet adapter note submission and the explicit consume sync. If the poll sync runs before the note's block is committed, it advances sync_height past that block. Since sync only moves forward (block_from = sync_height + 1), the note is permanently invisible.

**Fix:** Added `pollSuppressedRef` guard that immediately prevents in-flight poll sync() calls from completing when entering the consume flow. Set the guard BEFORE clearing the interval, since clearInterval can't cancel an already-running async sync.

**Key insight:** `sync_height` is a one-way ratchet — it never goes backward. Any sync() call that advances it past a not-yet-committed note permanently hides that note. When submitting notes via wallet adapter and waiting for them to appear, ALL other sync sources must be suppressed.
