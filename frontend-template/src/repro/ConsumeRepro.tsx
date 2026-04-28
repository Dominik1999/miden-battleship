/**
 * Minimal reproduction for: consuming notes against a no-auth account
 * crashes with "null pointer passed to rust".
 *
 * Steps:
 *   1. Create an account with withBasicWalletComponent() + withNoAuthComponent()
 *   2. Submit a public note targeting that account (via wallet adapter)
 *   3. Sync until the note appears
 *   4. Try to consume the note → crashes with null pointer
 *
 * Bug context: miden-client#2121 fixed CustomTransaction null pointer,
 * but the consume path still fails for no-auth accounts.
 *
 * SDK version: @miden-sdk/miden-sdk 0.14.5
 */

import { useState, useCallback } from "react";
import {
  useConsume,
  useMiden,
  useMidenClient,
  useSyncState,
} from "@miden-sdk/react";
import {
  useMidenFiWallet,
  Transaction,
} from "@miden-sdk/miden-wallet-adapter";
import {
  TransactionRequestBuilder,
  Note,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteStorage,
  NoteTag,
  NoteType,
  NoteArray,
  AccountId,
  AccountBuilder,
  AccountStorageMode,
  AccountType,
  Address,
  NetworkId,
  Felt,
  FeltArray,
  Word,
} from "@miden-sdk/miden-sdk";

type LogEntry = { time: string; msg: string; error?: boolean };

function randomWord(): Word {
  const felts = Array.from({ length: 4 }, () =>
    new Felt(BigInt(Math.floor(Math.random() * 2 ** 32))),
  );
  return Word.newFromFelts(felts);
}

export function ConsumeRepro() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);

  const { address: walletAddress, requestTransaction } = useMidenFiWallet();
  const client = useMidenClient();
  const { runExclusive, isReady } = useMiden();
  const { sync } = useSyncState();
  const { consume } = useConsume();

  const log = useCallback((msg: string, error = false) => {
    const time = new Date().toLocaleTimeString();
    console.log(`[Repro] ${msg}`);
    setLogs((prev) => [...prev, { time, msg, error }]);
  }, []);

  const run = useCallback(async () => {
    if (!walletAddress || !requestTransaction || !client || !isReady) {
      log("Not ready — connect wallet first", true);
      return;
    }
    setRunning(true);
    setLogs([]);

    try {
      // --- Step 1: Create a minimal no-auth account ---
      log("Step 1: Creating account with withBasicWalletComponent() + withNoAuthComponent()...");
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const account = new AccountBuilder(seed)
        .accountType(AccountType.RegularAccountImmutableCode)
        .storageMode(AccountStorageMode.tryFromStr("public"))
        .withBasicWalletComponent()
        .withNoAuthComponent()
        .build()
        .account;

      await runExclusive(() => client.newAccount(account, false));
      const accountAddress = Address.fromAccountId(account.id()).toBech32(NetworkId.testnet());
      const accountId = AccountId.fromBech32(accountAddress);
      log(`Account created: ${accountAddress}`);

      // Register tag so sync discovers notes for this account
      const tag = NoteTag.withAccountTarget(accountId);
      await runExclusive(() => client.addTag(tag.asU32().toString()));
      log(`Tag registered: ${tag.asU32()}`);

      // --- Step 2: Build and submit a note targeting the account ---
      log("Step 2: Building note...");
      const walletId = AccountId.fromBech32(walletAddress);

      // Minimal note: empty script inputs, just needs to be consumable
      const noteInputs = new FeltArray();
      noteInputs.push(new Felt(42n)); // single dummy input

      // We need a note script. Use a trivial one — just "begin end" compiled.
      // Since we can't compile inline in the browser, build a P2ID-style note
      // using the SDK's built-in note creation.
      // Actually, for minimal repro we just need ANY note the account can receive.
      // Let's create a raw note with an empty script (NoteScript default).
      const serialNum = randomWord();
      const noteStorage = new NoteStorage(noteInputs);

      // Note: NoteScript requires compiled MASM. For a truly minimal repro,
      // we can use TransactionRequestBuilder to create a P2ID note instead.
      // But the bug is in consume, not in note creation. Let's use the
      // simplest path: create a note via the wallet's send mechanism.

      // Actually, let's just create any output note. The note script doesn't
      // matter for the repro — the crash happens during the CONSUME transaction
      // execution against the no-auth account, before the note script runs.
      // We'll build a transaction that just creates an output note with a
      // dummy script. If NoteScript requires a package, we'll load one.

      // Simplest approach: use the setup_note.masp we already have
      const buf = await fetch(`${import.meta.env.BASE_URL}packages/setup_note.masp`).then(
        (r) => r.arrayBuffer(),
      );
      const { Package, NoteScript: NS } = await import("@miden-sdk/miden-sdk");
      const pkg = Package.deserialize(new Uint8Array(buf));
      const noteScript = NS.fromPackage(pkg);

      const recipient = new NoteRecipient(serialNum, noteScript, noteStorage);
      const noteTag = NoteTag.withAccountTarget(accountId);
      const metadata = new NoteMetadata(walletId, NoteType.Public, noteTag);
      const note = new Note(new NoteAssets(), metadata, recipient);
      const noteId = note.id().toString();
      log(`Note built: ${noteId}`);

      log("Step 2b: Submitting note via wallet adapter...");
      const txRequest = new TransactionRequestBuilder()
        .withOwnOutputNotes(new NoteArray([note]))
        .build();
      const tx = Transaction.createCustomTransaction(
        walletAddress,
        accountAddress,
        txRequest,
      );
      await requestTransaction(tx);
      log("Note submitted successfully!");

      // --- Step 3: Wait for note to propagate, then sync ---
      log("Step 3: Waiting 15s for note to appear on-chain, then syncing...");
      await new Promise((r) => setTimeout(r, 15_000));
      await sync();
      log("Sync complete");

      // --- Step 4: Try to consume → expect null pointer ---
      log("Step 4: Calling consume({ accountId, notes: [noteId] })...");
      try {
        const result = await consume({ accountId: accountAddress, notes: [noteId] });
        log(`Consume succeeded (unexpected!): ${JSON.stringify(result)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Consume FAILED: ${msg}`, true);
        if (msg.includes("null pointer")) {
          log("BUG CONFIRMED: null pointer passed to rust during consume of note against no-auth account", true);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Unexpected error: ${msg}`, true);
    } finally {
      setRunning(false);
    }
  }, [walletAddress, requestTransaction, client, isReady, runExclusive, sync, consume, log]);

  return (
    <div style={{ padding: 20, fontFamily: "monospace", maxWidth: 800 }}>
      <h2>Consume Repro: No-Auth Account Bug</h2>
      <p>SDK: @miden-sdk/miden-sdk 0.14.5</p>
      <p>Wallet: {walletAddress ?? "not connected"}</p>
      <p>Client ready: {String(isReady)}</p>

      <button onClick={run} disabled={running || !isReady || !walletAddress}>
        {running ? "Running..." : "Run Repro"}
      </button>

      <div style={{ marginTop: 16, fontSize: 13, lineHeight: 1.6 }}>
        {logs.map((l, i) => (
          <div key={i} style={{ color: l.error ? "#f44" : "#ccc" }}>
            <span style={{ color: "#888" }}>[{l.time}]</span> {l.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
