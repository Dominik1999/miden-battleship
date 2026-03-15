# WebClient `executeTransaction` fails with `NOTE_BEFORE_CREATED` when consuming notes that create output notes via `expected_output_recipients`

## Environment

| Component | Version |
|-----------|---------|
| `@miden-sdk/miden-sdk` | 0.13.2 |
| `@miden-sdk/react` | 0.13.3 |
| `@miden-sdk/miden-wallet-adapter` | 0.13.5 |
| `@miden-sdk/vite-plugin` | 0.13.4 |
| Browser | Chrome (latest, March 2026) |
| Native Rust `miden-client` | 0.13.x (same flow works) |

## Description

When consuming a note whose script calls `output_note::create()` (creating a public output note), the WebClient's `executeTransaction` fails with kernel event error `NOTE_BEFORE_CREATED` (event ID `1276704095326615571`).

The identical flow works perfectly with the native Rust client using `TransactionRequestBuilder::expected_output_recipients()`. The `expected_output_recipients` mechanism is supposed to pre-load the output note's script into the kernel's DataStore so the kernel can create the output note during execution.

**The WebClient version of `withExpectedOutputRecipients()` does not appear to make the script available to the kernel.**

## Working Rust Code

From `project-template/integration/src/bin/validate_local.rs` — this works against a local node:

```rust
/// Consume a shot-note that creates an output result-note.
async fn consume_shot_note(
    client: &mut miden_client::Client<miden_client::keystore::FilesystemKeyStore>,
    account_id: miden_client::account::AccountId,
    shot_note: miden_client::note::Note,
    result_recipient: NoteRecipient,
) -> Result<()> {
    let request = TransactionRequestBuilder::new()
        .input_notes([(shot_note, None)])
        .expected_output_recipients(vec![result_recipient])
        .build()
        .context("Failed to build shot consume request")?;
    client
        .submit_new_transaction(account_id, request)
        .await
        .context("Failed to submit shot consume transaction")?;
    client.sync_state().await?;
    Ok(())
}
```

The `result_recipient` is constructed with:
```rust
let result_script = NoteScript::from_parts(
    result_program.mast_forest().clone(),
    result_program.entrypoint(),
);
let result_inputs = NoteInputs::new(vec![a_prefix, a_suffix, Felt::new(turn), encoded_result])?;
let result_recipient = NoteRecipient::new(serial, result_script.clone(), result_inputs);
```

## Failing JavaScript Code

From `frontend-template/src/hooks/useGameplaySync.ts`:

```typescript
const consumeNoteWithInputs = async (noteIdStr: string) => {
  const accountIdObj = AccountId.fromBech32(myAccountId);
  const resultScript = await loadResultScript();

  await runExclusive(async () => {
    const noteRecord = await client.getInputNote(noteIdStr);
    const note = noteRecord.toNote();
    const noteAndArgs = new NoteAndArgs(note);
    const noteAndArgsArray = new NoteAndArgsArray([noteAndArgs]);

    // Build NoteRecipient with the result note script
    const dummyInputs = new NoteInputs(new FeltArray());
    const dummyRecipient = new NoteRecipient(
      randomWord(),
      resultScript,
      dummyInputs,
    );
    const recipientArray = new NoteRecipientArray([dummyRecipient]);

    const txRequest = new TransactionRequestBuilder()
      .withInputNotes(noteAndArgsArray)
      .withExpectedOutputRecipients(recipientArray)
      .build();

    // Even bypassing the worker and calling WASM directly fails
    const wasmClient = (client as any).wasmWebClient;
    const txResult = await wasmClient.executeTransaction(accountIdObj, txRequest);
    // ... prove and submit
  });
};
```

The `loadResultScript()` function loads `result_note.masp` and creates a fresh `NoteScript`:
```typescript
const pkg = Package.deserialize(resultMaspBytesRef.current);
const script = NoteScript.fromPackage(pkg);
```

## Diagnostic Output

Console logs confirm all script roots match perfectly — the correct script is being provided:

```
[GameplaySync] Fetching result_note.masp...
[GameplaySync] Result script root from .masp: [15171288892435243614, 10295758693372466955, 709059778587687919, 9826546822224790371]
[GameplaySync] RESULT_SCRIPT_ROOT from config: [15171288892435243614, 10295758693372466955, 709059778587687919, 9826546822224790371]
[GameplaySync] Roots match: true

[GameplaySync] Note metadata: tag=1063780352, type=1
[GameplaySync] Note has 14 inputs
[GameplaySync] Shot note's result_script_root (inputs[7..10]): [15171288892435243614, 10295758693372466955, 709059778587687919, 9826546822224790371]
[GameplaySync] Config RESULT_SCRIPT_ROOT: [15171288892435243614, 10295758693372466955, 709059778587687919, 9826546822224790371]
[GameplaySync] Shot inputs match config: true

[GameplaySync] Executing TX for note 0x0196db812e41dad7...  (direct executeTransaction)...
```

## Full Error Trace

The error surfaces at three levels:

### 1. WASM Worker
```
WORKER: Error occurred - failed to execute transaction: transaction execution failed:
failed to execute transaction kernel program:
Diagnostic { message: "error during processing of event with ID: 1276704095326615571",
labels: "[LabeledSpan { label: None, span: SourceSpan { offset: SourceOffset(0), length: 0 },
primary: false }]" }
NOTE: If you're looking for the fancy error reports, install miette with the `fancy` feature,
or write your own and hook it up with miette::set_hook().
```

### 2. WebClient wrapper
```
WebClient: Error from worker in executeTransaction: [same error]
```

### 3. Application code
```
[GameplaySync] Consume failed for 0x0196db812e41dad7037e78a007913e133ff8ce76ba83e23895eedf70bce42ece
(marked as handled): failed to execute transaction: transaction execution failed:
failed to execute transaction kernel program:
Diagnostic { message: "error during processing of event with ID: 1276704095326615571", ... }
```

### Stack trace (from WASM)
```
at imports.wbg.__wbg_Error_e83987f665cf5504 (Cargo-e77f9a02-e77f9a02.js:22193:21)
at miden_client_web.wasm.wasm_bindgen::__wbindgen_error_new::... (miden_client_web.wasm:0xbb915a)
at miden_client_web.wasm.miden_client_web::js_error_with_context::... (miden_client_web.wasm:0xa546fa)
at miden_client_web.wasm.miden_client_web::new_transactions::<impl ...>::execute_transaction::... (miden_client_web.wasm:0xaaa7f8)
at miden_client_web.wasm.wasm_bindgen_futures::future_to_promise::... (miden_client_web.wasm:0x9509b6)
```

### Event ID mapping
Event ID `1276704095326615571` maps to `NOTE_BEFORE_CREATED` (`miden::note::before_created`) in the Miden kernel's `transaction_events.rs`. This event fires when `output_note::create()` is called inside a note script. The kernel host's event handler cannot fulfill the note creation request.

## What We've Ruled Out

| Hypothesis | Status | Evidence |
|------------|--------|----------|
| Script root mismatch | **Ruled out** | Diagnostic logs show all three sources match: `.masp` file, config constant, and shot note inputs |
| Worker serialization losing `expected_output_recipients` | **Ruled out** | Tested by bypassing worker entirely and calling `wasmWebClient.executeTransaction()` directly on the main thread — same error |
| WASM object reuse / consumed pointer | **Ruled out** | Fresh `Package.deserialize()` + `NoteScript.fromPackage()` on each call; no object reuse |
| Timing / async issues | **Not relevant** | Error is a synchronous kernel execution failure, not a race condition |
| Note inputs mismatch | **Ruled out** | Shot note has 14 inputs as expected; inputs[7..10] match the result script root |

## Hypothesis: WebClient's `TransactionRequestBuilder.withExpectedOutputRecipients()` is not wiring the script into the DataStore

The Rust native client's `TransactionRequestBuilder::expected_output_recipients()` stores the `NoteRecipient` (containing the full `NoteScript` with its MAST forest) such that the `DataStore` makes it available to the kernel when `NOTE_BEFORE_CREATED` fires. The kernel then looks up the script by its root hash.

The WebClient's WASM-bindgen equivalent `withExpectedOutputRecipients()` either:
1. Does not correctly serialize the `NoteRecipient` across the JS/WASM boundary
2. Does not store the script in the `DataStore` correctly
3. Does not make the script findable by its root hash during kernel execution

Since the script root matches everywhere and the same flow works in native Rust, the bug is in the WebClient's handling of `expected_output_recipients`, not in our usage.

## Minimal Reproduction

Any note script that calls `output_note::create()` consumed via WebClient with `withExpectedOutputRecipients()` will fail. See `tasks/minimal-repro/` for a stripped-down example.

The simplest reproduction:
1. Deploy any note script that calls `output_note::create()` with a known output script root
2. Create a `NoteScript` from the output note's `.masp` package
3. Build a `TransactionRequestBuilder` with `.withInputNotes()` and `.withExpectedOutputRecipients()`
4. Call `executeTransaction()` — fails with `NOTE_BEFORE_CREATED` event error

The same steps using the Rust `miden-client` succeed.

## Contract Sources

- **Shot note** (calls `output_note::create()`): `project-template/contracts/shot-note/src/lib.rs`
- **Result note** (the output note script): `project-template/contracts/result-note/src/lib.rs`
- **Failing JS code**: `frontend-template/src/hooks/useGameplaySync.ts`
- **Working Rust code**: `project-template/integration/src/bin/validate_local.rs`
