/**
 * Client-level game orchestration shared by the React hooks: funding, setup, note publishing,
 * note discovery/classification and shot resolution. Everything here takes the raw
 * `WebClient` (as a narrow structural interface so tests can mock it) and mirrors
 * `project-template/integration/src/bin/validate_testnet.rs` step for step.
 *
 * All calls that touch the WASM client must run inside the provider's `runExclusive` lock; the
 * hooks are responsible for that.
 */
import {
  AccountId,
  type Felt,
  NoteAndArgs,
  NoteAndArgsArray,
  NoteFilter,
  NoteFilterTypes,
  NoteRecipientArray,
  NoteTag,
  TransactionFilter,
  TransactionId,
  TransactionRequestBuilder,
  type Account,
  type InputNoteRecord,
  type Note,
  type TransactionProver,
  type TransactionRequest,
} from "@miden-sdk/miden-sdk";
import {
  FAUCET_CLAIM_AMOUNT,
  FUNDING_NOTE_TIMEOUT_MS,
  MIDEN_FAUCET_URL,
  NETWORK_POLL_INTERVAL_MS,
  SLOT_GAME_ID,
  SLOT_OPPONENT,
  TOTAL_SHIP_CELLS,
  TX_COMMIT_TIMEOUT_MS,
} from "@/config";
import { getCellFromPacked, readBoardRow } from "@/lib/board";
import { type ContractCompiler, type NoteScriptKind } from "@/lib/contracts";
import { claimFaucetTokens } from "@/lib/funding";
import { randomWord } from "@/lib/miden";
import { publishSyncHeight } from "@/lib/syncHeight";
import {
  buildHandshakeStorage,
  buildNote,
  createGameAccount,
  buildResultRecipient,
  buildRevealStorage,
  buildSetupPayload,
  buildSetupRequest,
  buildShotStorage,
  decodeResult,
  encodeResult,
  feltValues,
  submitNoteDirect,
  submitRequest,
  type FeltValues,
  type TxClient,
} from "@/lib/notes";
import { CELL_SHIP_1, CELL_SHIP_5, type ShipCell } from "@/types/game";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[Game] ${msg}`, "color: #8cf; font-weight: bold", ...args);

/** The part of the WebClient the game flow needs (a strict subset of `WasmWebClient`). */
export interface GameClient extends TxClient {
  syncState(): Promise<{ blockNum(): number }>;
  getInputNotes(filter: NoteFilter): Promise<InputNoteRecord[]>;
  getAccount(accountId: AccountId): Promise<Account | undefined>;
  getTransactions(filter: TransactionFilter): Promise<{ id(): TransactionId; transactionStatus(): { isCommitted(): boolean; isDiscarded(): boolean } }[]>;
  feeFaucetId(): Promise<AccountId>;
  getOutputNotes(filter: NoteFilter): Promise<
    {
      recipient(): { script(): { root(): { toHex(): string } }; storage(): { items(): Felt[] } } | undefined;
      metadata(): { tag(): { asU32(): number } };
    }[]
  >;
  newConsumeTransactionRequest(notes: Note[], consumingAccountId: AccountId): Promise<TransactionRequest>;
  newAccount(account: unknown, overwrite: boolean): Promise<void>;
}

export interface GameContext {
  client: GameClient;
  compiler: ContractCompiler;
  prover?: TransactionProver | null;
  /** Called with human-readable progress. */
  onStatus?: (status: string) => void;
  /** Cancellation: throw when set. */
  signal?: AbortSignal;
}

export type { FeltValues };

export class GameAbortedError extends Error {
  constructor() {
    super("Game flow aborted");
    this.name = "GameAbortedError";
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new GameAbortedError());
    }, { once: true });
  });

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new GameAbortedError();
}

/** Syncs the client and publishes the new block height for the UI. */
export async function sync(ctx: GameContext): Promise<void> {
  const summary = await ctx.client.syncState();
  try {
    publishSyncHeight(summary.blockNum());
  } catch {
    // mock clients may not return a summary
  }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** Syncs until the transaction is committed; throws if the node discarded it. */
export async function waitForCommit(ctx: GameContext, txIdHex: string, timeoutMs = TX_COMMIT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const filter = () => TransactionFilter.ids([TransactionId.fromHex(txIdHex)]);
  for (;;) {
    checkAborted(ctx.signal);
    await sync(ctx);
    const [record] = await ctx.client.getTransactions(filter());
    const status = record?.transactionStatus();
    if (status?.isCommitted()) return;
    if (status?.isDiscarded()) throw new Error(`Transaction ${txIdHex} was discarded by the network`);
    if (Date.now() > deadline) throw new Error(`Timed out waiting for transaction ${txIdHex} to commit`);
    await sleep(NETWORK_POLL_INTERVAL_MS, ctx.signal);
  }
}

/** Submits a request from `address` and waits for it to commit. Returns the tx id. */
export async function submitAndWait(ctx: GameContext, address: string, request: TransactionRequest): Promise<string> {
  const txId = await submitRequest(ctx.client, address, request, ctx.prover);
  log(`Submitted tx ${txId}, waiting for commit...`);
  await waitForCommit(ctx, txId);
  log(`Tx ${txId} committed`);
  return txId;
}

/** Syncs until a committed, unconsumed note matching `predicate` is in the local store. */
export async function waitForNote(
  ctx: GameContext,
  predicate: (record: InputNoteRecord) => boolean,
  timeoutMs: number,
): Promise<InputNoteRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    checkAborted(ctx.signal);
    await sync(ctx);
    const records = await ctx.client.getInputNotes(new NoteFilter(NoteFilterTypes.Committed));
    const match = records.find((r) => !r.isConsumed() && !r.isProcessing() && predicate(r));
    if (match) return match;
    if (Date.now() > deadline) throw new Error("Timed out waiting for a note from the network");
    await sleep(NETWORK_POLL_INTERVAL_MS, ctx.signal);
  }
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

/** Fee-asset balance of a tracked account (0 when unknown). */
export async function feeBalance(ctx: GameContext, address: string): Promise<bigint> {
  const account = await ctx.client.getAccount(AccountId.fromBech32(address));
  if (!account) return 0n;
  const feeFaucet = await ctx.client.feeFaucetId();
  return account.vault().getBalance(feeFaucet);
}

/**
 * Claims fee tokens from the faucet for `address`, waits for the funding note and consumes it.
 * For a fresh account this first transaction also deploys it on-chain.
 */
export async function fundFromFaucet(ctx: GameContext, address: string): Promise<bigint> {
  const noteId = await claimFaucetTokens(MIDEN_FAUCET_URL, address, FAUCET_CLAIM_AMOUNT, { onStatus: ctx.onStatus });
  ctx.onStatus?.("Waiting for the funding note...");
  const record = await waitForNote(ctx, (r) => r.id()?.toString() === noteId, FUNDING_NOTE_TIMEOUT_MS);
  ctx.onStatus?.("Consuming the funding note (deploys the account)...");
  await consumeNote(ctx, address, record.toNote());
  const balance = await feeBalance(ctx, address);
  log(`Funded ${address}: balance ${balance}`);
  return balance;
}

/** Compiles the component, creates a game account and funds it from the faucet. */
export async function createAndFundGameAccount(ctx: GameContext): Promise<string> {
  ctx.onStatus?.("Compiling the battleship contract...");
  const component = await ctx.compiler.component();
  ctx.onStatus?.("Creating your game account...");
  const address = await createGameAccount(ctx.client, component);
  log(`Game account created: ${address}`);
  await fundFromFaucet(ctx, address);
  return address;
}

// ---------------------------------------------------------------------------
// Game transactions
// ---------------------------------------------------------------------------

/** Runs the setup transaction script: stores the board and names the opponent (CREATED → CHALLENGED). */
export async function runSetup(
  ctx: GameContext,
  address: string,
  gameId: FeltValues,
  opponent: AccountId,
  commitment: FeltValues,
  cells: ShipCell[],
): Promise<string> {
  const payload = buildSetupPayload(gameId, opponent.prefix(), opponent.suffix(), commitment, cells);
  const key = randomValues();
  const request = buildSetupRequest(new TransactionRequestBuilder(), await ctx.compiler.txScript("setup"), payload, key);
  return submitAndWait(ctx, address, request);
}

/** Runs one of the argument-less transaction scripts (enter_reveal, mark_my_reveal). */
export async function runTxScript(ctx: GameContext, address: string, kind: "enterReveal" | "markMyReveal"): Promise<string> {
  const request = new TransactionRequestBuilder().withCustomScript(await ctx.compiler.txScript(kind)).build();
  return submitAndWait(ctx, address, request);
}

/** Builds and publishes a game note from `from` to `to`; resolves once it is committed. */
export async function publishGameNote(
  ctx: GameContext,
  kind: NoteScriptKind,
  from: string,
  to: string,
  storage: ReturnType<typeof buildHandshakeStorage>,
): Promise<{ noteId: string }> {
  const script = await ctx.compiler.noteScript(kind);
  const { note, noteId } = buildNote(script, storage, AccountId.fromBech32(to), AccountId.fromBech32(from));
  const txId = await submitNoteDirect([note], from, ctx.client, ctx.prover);
  await waitForCommit(ctx, txId);
  return { noteId };
}

export function handshakeStorageFor(gameId: FeltValues, sender: AccountId, commitment: FeltValues) {
  return buildHandshakeStorage(gameId, sender.prefix(), sender.suffix(), commitment);
}

export function revealStorageFor(commitment: FeltValues) {
  return buildRevealStorage(commitment);
}

/** Four random field elements as plain values (game ids, commitments, serial numbers). */
export function randomValues(): FeltValues {
  return feltValues(randomWord().toFelts());
}

/** Publishes a shot note; returns the result serial the defender's result note will carry. */
export async function publishShot(
  ctx: GameContext,
  from: string,
  to: string,
  row: number,
  col: number,
  turn: number,
): Promise<{ noteId: string; resultSerial: FeltValues }> {
  const resultSerial = randomValues();
  const storage = buildShotStorage(row, col, turn, resultSerial, await ctx.compiler.resultScriptRoot());
  const { noteId } = await publishGameNote(ctx, "shot", from, to, storage);
  return { noteId, resultSerial };
}

/** Plain consume of a committed game note (challenge, accept, reveal, funding). */
export async function consumeNote(ctx: GameContext, address: string, note: Note): Promise<string> {
  const request = await ctx.client.newConsumeTransactionRequest([note], AccountId.fromBech32(address));
  return submitAndWait(ctx, address, request);
}

export interface ShotOutcome {
  row: number;
  col: number;
  turn: number;
  isHit: boolean;
  gameOver: boolean;
}

/** Predicts the outcome of an incoming shot from the defender's own board (mirrors the contract). */
export function predictShot(account: Account, row: number, col: number): { isHit: boolean; gameOver: boolean } {
  const storage = account.storage();
  const cell = getCellFromPacked(readBoardRow(storage, row), col);
  const isHit = cell >= CELL_SHIP_1 && cell <= CELL_SHIP_5;
  const opponent = storage.getItem(SLOT_OPPONENT);
  const shipsHit = opponent ? Number(opponent.toU64s()[2] ?? 0n) : 0;
  const gameOver = isHit && shipsHit + 1 >= TOTAL_SHIP_CELLS;
  return { isHit, gameOver };
}

/**
 * Consumes an incoming shot note on the defender's account. The component creates the public
 * result note for the shooter; the request must declare its exact recipient, which the defender
 * can compute because it knows its own board.
 */
export async function consumeShot(ctx: GameContext, address: string, record: InputNoteRecord): Promise<ShotOutcome> {
  const note = record.toNote();
  const shot = parseShotStorage(note);
  const accountId = AccountId.fromBech32(address);
  const account = await ctx.client.getAccount(accountId);
  if (!account) throw new Error("Game account not found in the local store");
  const { isHit, gameOver } = predictShot(account, shot.row, shot.col);
  const shooter = note.metadata().sender();
  const recipient = buildResultRecipient(
    shot.resultSerial,
    await ctx.compiler.noteScript("result"),
    shooter.prefix(),
    shooter.suffix(),
    shot.turn,
    encodeResult(isHit, gameOver),
  );
  const request = new TransactionRequestBuilder()
    .withInputNotes(new NoteAndArgsArray([new NoteAndArgs(note)]))
    .withExpectedOutputRecipients(new NoteRecipientArray([recipient]))
    .build();
  log(`Resolving shot at (${shot.row}, ${shot.col}) turn ${shot.turn}: ${isHit ? "HIT" : "MISS"}${gameOver ? " (game over)" : ""}`);
  await submitAndWait(ctx, address, request);
  return { row: shot.row, col: shot.col, turn: shot.turn, isHit, gameOver };
}

/** The opponent and game id a game account stored during setup (null before setup). */
export function readGameIdentity(account: Account): { opponent: AccountId; gameId: FeltValues } | null {
  const storage = account.storage();
  const opponent = storage.getItem(SLOT_OPPONENT)?.toFelts();
  const gameId = storage.getItem(SLOT_GAME_ID)?.toFelts();
  if (!opponent || !gameId || opponent[0].asInt() === 0n) return null;
  return { opponent: AccountId.fromPrefixSuffix(opponent[0], opponent[1]), gameId: feltValues(gameId) };
}

/**
 * Whether this client already created a note of the given kind for `target` in game `gameId`
 * (e.g. the accept note). The store may still hold notes of earlier games, so the target tag and
 * the game id carried in the handshake storage are both checked.
 */
export async function hasSentNote(ctx: GameContext, kind: "challenge" | "accept", target: string, gameId: FeltValues): Promise<boolean> {
  const roots = await ctx.compiler.noteScriptRoots();
  const root = roots[kind].toLowerCase();
  const targetTag = NoteTag.withAccountTarget(AccountId.fromBech32(target)).asU32();
  const records = await ctx.client.getOutputNotes(new NoteFilter(NoteFilterTypes.All));
  return records.some((r) => {
    try {
      const recipient = r.recipient();
      if (!recipient || recipient.script().root().toHex().toLowerCase() !== root) return false;
      if (r.metadata().tag().asU32() !== targetTag) return false;
      const items = recipient.storage().items();
      return items.length === 10 && feltValues(items.slice(0, 4)).every((v, i) => v === gameId[i]);
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Note classification and parsing
// ---------------------------------------------------------------------------

export type ClassifiedNote =
  | { kind: NoteScriptKind; record: InputNoteRecord }
  | { kind: "funding"; record: InputNoteRecord }
  | { kind: "unknown"; record: InputNoteRecord };

function scriptRootHex(record: InputNoteRecord): string | null {
  try {
    return record.details().recipient().script().root().toHex().toLowerCase();
  } catch {
    return null;
  }
}

/** Classifies a note by its script root; funding notes are recognised by their fee asset. */
export async function classifyNote(ctx: GameContext, record: InputNoteRecord, feeFaucet: AccountId): Promise<ClassifiedNote> {
  const roots = await ctx.compiler.noteScriptRoots();
  const root = scriptRootHex(record);
  for (const kind of Object.keys(roots) as NoteScriptKind[]) {
    if (roots[kind].toLowerCase() === root) return { kind, record };
  }
  try {
    const carriesFee = record
      .details()
      .assets()
      .fungibleAssets()
      .some((a) => a.faucetId().toString() === feeFaucet.toString() && a.amount() > 0n);
    if (carriesFee) return { kind: "funding", record };
  } catch {
    // not a funding note
  }
  return { kind: "unknown", record };
}

/** Committed, unconsumed notes in the local store that were sent to `address`. */
export async function pendingNotesFor(ctx: GameContext, address: string): Promise<InputNoteRecord[]> {
  const records = await ctx.client.getInputNotes(new NoteFilter(NoteFilterTypes.Committed));
  const targetTag = NoteTag.withAccountTarget(AccountId.fromBech32(address)).asU32();
  return records.filter((r) => {
    if (r.isConsumed() || r.isProcessing()) return false;
    try {
      return r.metadata()?.tag().asU32() === targetTag;
    } catch {
      return false;
    }
  });
}

export interface HandshakeData {
  gameId: FeltValues;
  sender: AccountId;
  commitment: FeltValues;
}

/** Parses challenge/accept note storage: [GAME_ID(4), sender_prefix, sender_suffix, COMMITMENT(4)]. */
export function parseHandshakeStorage(note: Note): HandshakeData {
  const items = note.recipient().storage().items();
  if (items.length !== 10) throw new Error(`Handshake note has ${items.length} storage items, expected 10`);
  return {
    gameId: feltValues(items.slice(0, 4)),
    sender: AccountId.fromPrefixSuffix(items[4], items[5]),
    commitment: feltValues(items.slice(6, 10)),
  };
}

export interface ShotData {
  row: number;
  col: number;
  turn: number;
  resultSerial: FeltValues;
  resultScriptRoot: FeltValues;
}

/** Parses shot note storage: [row, col, turn, RESULT_SERIAL(4), RESULT_SCRIPT_ROOT(4)]. */
export function parseShotStorage(note: Note): ShotData {
  const items = note.recipient().storage().items();
  if (items.length !== 11) throw new Error(`Shot note has ${items.length} storage items, expected 11`);
  return {
    row: Number(items[0].asInt()),
    col: Number(items[1].asInt()),
    turn: Number(items[2].asInt()),
    resultSerial: feltValues(items.slice(3, 7)),
    resultScriptRoot: feltValues(items.slice(7, 11)),
  };
}

export interface ResultData {
  shooter: AccountId;
  turn: number;
  isHit: boolean;
  isGameOver: boolean;
}

/** Parses result note storage: [shooter_prefix, shooter_suffix, turn, encoded_result]. */
export function parseResultStorage(note: Note): ResultData {
  const items = note.recipient().storage().items();
  if (items.length !== 4) throw new Error(`Result note has ${items.length} storage items, expected 4`);
  const { isHit, isGameOver } = decodeResult(items[3].asInt());
  return {
    shooter: AccountId.fromPrefixSuffix(items[0], items[1]),
    turn: Number(items[2].asInt()),
    isHit,
    isGameOver,
  };
}

/** Parses reveal note storage: [COMMITMENT(4)]. */
export function parseRevealStorage(note: Note): FeltValues {
  const items = note.recipient().storage().items();
  if (items.length !== 4) throw new Error(`Reveal note has ${items.length} storage items, expected 4`);
  return feltValues(items.slice(0, 4));
}

