/**
 * Client-level game orchestration shared by the React hooks: funding, setup, handshake notes,
 * note discovery/classification, moves (consume the opponent's notes + fire), reclaims, stakes
 * and claims. Everything here takes the raw `WebClient` (as a narrow structural interface so
 * tests can mock it) and mirrors `project-template/integration/src/helpers.rs` step for step.
 *
 * All calls that touch the WASM client must run inside the provider's `runExclusive` lock; the
 * hooks are responsible for that.
 */
import {
  AccountId,
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
  type Felt,
  type InputNoteRecord,
  type Note,
  type NoteAssets,
  type NoteMetadata,
  type NoteRecipient,
  type TransactionProver,
  type TransactionRequest,
} from "@miden-sdk/miden-sdk";
import {
  DEADLINE_DELTA_SECONDS,
  DEADLINE_MARGIN_SECONDS,
  FAUCET_CLAIM_AMOUNT,
  SLOT_GAME_ID,
  SLOT_OPPONENT,
  FUNDING_NOTE_TIMEOUT_MS,
  HANDSHAKE_NOTE_ITEMS,
  MIDEN_FAUCET_URL,
  NETWORK_POLL_INTERVAL_MS,
  RESULT_NOTE_ITEMS,
  SHOT_NOTE_ITEMS,
  STAKE_NOTE_ITEMS,
  TOTAL_SHIP_CELLS,
  TX_COMMIT_TIMEOUT_MS,
  WALLET_NOTE_ITEMS,
} from "@/config";
import { getCellFromPacked, readBoardRow } from "@/lib/board";
import { type ContractCompiler, type NoteScriptKind, type ScriptRoots } from "@/lib/contracts";
import { claimFaucetTokens } from "@/lib/funding";
import { publishSyncHeight } from "@/lib/syncHeight";
import {
  addressOf,
  buildHandshakeStorage,
  buildNote,
  buildSetupPayload,
  buildSetupRequest,
  buildStakeNote,
  createGameAccount,
  createLocalWallet,
  decodeResult,
  expectedDefeatNote,
  expectedForfeitNote,
  expectedResultNote,
  expectedShotNote,
  feltValues,
  felts as feltsOf,
  fireArgs,
  randomValues,
  shotNoteArgs,
  submitNoteDirect,
  submitRequest,
  toWord,
  type FeltValues,
  type StakeParties,
  type TxClient,
} from "@/lib/notes";
import { readGameState } from "@/lib/state";
import { CELL_SHIP_1, CELL_SHIP_5, PHASE_CHALLENGED, ROLE_CHALLENGER, type GameState, type ShipCell } from "@/types/game";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[Game] ${msg}`, "color: #8cf; font-weight: bold", ...args);

/** Output note records as the game reads them (`getOutputNotes`). */
export interface OutputNoteLike {
  recipient(): NoteRecipient | undefined;
  metadata(): NoteMetadata;
  assets(): NoteAssets;
  isConsumed(): boolean;
}

/** The part of the WebClient the game flow needs (a strict subset of `WasmWebClient`). */
export interface GameClient extends TxClient {
  syncState(): Promise<{ blockNum(): number }>;
  getInputNotes(filter: NoteFilter): Promise<InputNoteRecord[]>;
  getOutputNotes(filter: NoteFilter): Promise<OutputNoteLike[]>;
  getAccount(accountId: AccountId): Promise<Account | undefined>;
  getTransactions(filter: TransactionFilter): Promise<{ id(): TransactionId; transactionStatus(): { isCommitted(): boolean; isDiscarded(): boolean } }[]>;
  feeFaucetId(): Promise<AccountId>;
  /** Optional: not on the react provider's client wrapper. */
  getSyncHeight?(): Promise<number>;
  getBlockHeaderByNumber?(blockNum?: number | null): Promise<{ timestamp(): number }>;
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
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new GameAbortedError());
      },
      { once: true },
    );
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

/**
 * Timestamp (seconds) of the reference block of the next transaction. The client wrapper of
 * the web SDK exposes no block header, so the wall clock stands in (testnet block timestamps
 * follow it within seconds); a client that does expose `getBlockHeaderByNumber` is used instead.
 */
export async function blockTimestamp(ctx: GameContext): Promise<number> {
  const client = ctx.client as Partial<GameClient>;
  if (typeof client.getBlockHeaderByNumber === "function" && typeof client.getSyncHeight === "function") {
    try {
      const header = await client.getBlockHeaderByNumber(await client.getSyncHeight());
      return header.timestamp();
    } catch {
      // fall back to the wall clock
    }
  }
  return Math.floor(Date.now() / 1000);
}

/** A deadline 12 hours after now, padded so the contract's check against the reference block holds. */
export async function deadlineFromNow(ctx: GameContext): Promise<number> {
  return (await blockTimestamp(ctx)) + DEADLINE_DELTA_SECONDS + DEADLINE_MARGIN_SECONDS;
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
export async function waitForNote(ctx: GameContext, predicate: (record: InputNoteRecord) => boolean, timeoutMs: number): Promise<InputNoteRecord> {
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
// Funding and accounts
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
  await consumeNotes(ctx, address, [record.toNote()]);
  const balance = await feeBalance(ctx, address);
  log(`Funded ${address}: balance ${balance}`);
  return balance;
}

/** Compiles the component, creates a private game account and funds it from the faucet. */
export async function createAndFundGameAccount(ctx: GameContext): Promise<{ address: string; seed: FeltValues }> {
  ctx.onStatus?.("Compiling the battleship contract...");
  const component = await ctx.compiler.component();
  ctx.onStatus?.("Creating your game account...");
  const created = await createGameAccount(ctx.client, component);
  log(`Game account created: ${created.address}`);
  await fundFromFaucet(ctx, created.address);
  return created;
}

/** Creates the local stand-in wallet and funds it from the faucet (it pays for stakes and claims). */
export async function createAndFundWallet(ctx: GameContext): Promise<string> {
  ctx.onStatus?.("Creating your wallet...");
  const address = await createLocalWallet(ctx.client);
  log(`Wallet created: ${address}`);
  await fundFromFaucet(ctx, address);
  return address;
}

// ---------------------------------------------------------------------------
// Setup and handshake
// ---------------------------------------------------------------------------

/** Runs the setup transaction script: stores the board, the wallet, the roots and names the opponent. */
export async function runSetup(ctx: GameContext, address: string, gameId: FeltValues, opponent: AccountId, wallet: AccountId, cells: ShipCell[]): Promise<string> {
  const roots = await ctx.compiler.scriptRoots();
  const payload = buildSetupPayload(gameId, opponent, wallet, cells, roots);
  const request = buildSetupRequest(new TransactionRequestBuilder(), await ctx.compiler.txScript("setup"), payload, randomValues());
  return submitAndWait(ctx, address, request);
}

export interface HandshakeIdentity {
  gameId: FeltValues;
  seed: FeltValues;
  wallet: string;
}

/** Publishes my challenge or accept note (game id, my seed, my wallet, the pinned roots). */
export async function publishHandshake(ctx: GameContext, kind: "challenge" | "accept", from: string, to: string, identity: HandshakeIdentity): Promise<{ noteId: string }> {
  const roots = await ctx.compiler.scriptRoots();
  const storage = buildHandshakeStorage(identity.gameId, AccountId.fromBech32(from), identity.seed, AccountId.fromBech32(identity.wallet), roots);
  const note = buildNote(await ctx.compiler.noteScript(kind), storage, AccountId.fromBech32(to), AccountId.fromBech32(from));
  const noteId = note.id().toString();
  const txId = await submitNoteDirect([note], from, ctx.client, ctx.prover);
  await waitForCommit(ctx, txId);
  return { noteId };
}

/** Plain consume of committed notes (funding, challenge). */
export async function consumeNotes(ctx: GameContext, address: string, notes: Note[]): Promise<string> {
  const request = new TransactionRequestBuilder().withInputNotes(new NoteAndArgsArray(notes.map((n) => new NoteAndArgs(n)))).build();
  return submitAndWait(ctx, address, request);
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

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
  const shipsHit = readGameState(storage)?.shipsHitCount ?? 0;
  return { isHit, gameOver: isHit && shipsHit + 1 >= TOTAL_SHIP_CELLS };
}

/** The turn `state` fires next; before the handshake completes only the challenger's turn 1 is legal. */
export function nextFireTurn(state: GameState): number {
  return state.phase === PHASE_CHALLENGED || state.role === ROLE_CHALLENGER ? 2 * state.shotsFired + 1 : 2 * state.shotsFired + 2;
}

async function trackedAccount(ctx: GameContext, address: string): Promise<Account> {
  const account = await ctx.client.getAccount(AccountId.fromBech32(address));
  if (!account) throw new Error("Game account not found in the local store");
  return account;
}

export interface PlannedShot {
  args: FeltValues;
  note: Note;
  turn: number;
  deadline: number;
}

/** Plans the shot `me` fires next at `opponent`: the fire args and the note the component creates. */
export async function planShot(ctx: GameContext, me: string, opponent: string, row: number, col: number): Promise<PlannedShot> {
  const state = readGameState((await trackedAccount(ctx, me)).storage());
  if (!state) throw new Error("Game account has no state yet");
  const turn = nextFireTurn(state);
  const deadline = await deadlineFromNow(ctx);
  const note = expectedShotNote(await ctx.compiler.noteScript("shot"), AccountId.fromBech32(me), AccountId.fromBech32(opponent), row, col, turn, deadline);
  return { args: fireArgs(row, col, deadline), note, turn, deadline };
}

export interface PlannedResolution {
  args: FeltValues;
  result: Note;
  defeat: Note | null;
  outcome: ShotOutcome;
  deadline: number;
}

/** Plans the resolution of an incoming shot on `me`: note args, the result note and the defeat note on the 17th hit. */
export async function planResolution(ctx: GameContext, me: string, shot: Note): Promise<PlannedResolution> {
  const parsed = parseShotStorage(shot);
  const account = await trackedAccount(ctx, me);
  const { isHit, gameOver } = predictShot(account, parsed.row, parsed.col);
  const deadline = await deadlineFromNow(ctx);
  const shooter = shot.metadata().sender();
  const myId = AccountId.fromBech32(me);
  const result = expectedResultNote(await ctx.compiler.noteScript("result"), myId, shooter, parsed.turn, isHit, gameOver, deadline);
  let defeat: Note | null = null;
  if (gameOver) {
    const state = readGameState(account.storage());
    if (!state?.opponentWallet) throw new Error("The opponent's wallet is unknown; the handshake has not completed");
    const wallet = AccountId.fromPrefixSuffix(...(toFelts(state.opponentWallet) as [Felt, Felt]));
    defeat = expectedDefeatNote(await ctx.compiler.noteScript("defeat"), myId, wallet);
  }
  return { args: shotNoteArgs(deadline), result, defeat, deadline, outcome: { row: parsed.row, col: parsed.col, turn: parsed.turn, isHit, gameOver } };
}

function toFelts(values: readonly bigint[]): Felt[] {
  return feltsOf([...values]);
}

export interface Move {
  inputs: { note: Note; args?: FeltValues }[];
  expected: Note[];
  fire?: FeltValues;
}

/** Submits a move as one transaction: the input notes are consumed first, then the fire script runs. */
export async function submitMove(ctx: GameContext, me: string, move: Move): Promise<string> {
  let builder = new TransactionRequestBuilder()
    .withInputNotes(new NoteAndArgsArray(move.inputs.map(({ note, args }) => new NoteAndArgs(note, args ? toWord(args) : undefined))))
    .withExpectedOutputRecipients(new NoteRecipientArray(move.expected.map((n) => n.recipient())));
  if (move.fire) builder = builder.withCustomScript(await ctx.compiler.txScript("fire")).withScriptArg(toWord(move.fire));
  return submitAndWait(ctx, me, builder.build());
}

/** Reclaims my own unanswered note after its deadline; returns the forfeit note sent to my wallet. */
export async function reclaimNote(ctx: GameContext, me: string, note: Note): Promise<Note> {
  const state = readGameState((await trackedAccount(ctx, me)).storage());
  if (!state?.ownerWallet) throw new Error("Owner wallet unknown; the account is not set up");
  const wallet = AccountId.fromPrefixSuffix(...(toFelts(state.ownerWallet) as [Felt, Felt]));
  const forfeit = expectedForfeitNote(await ctx.compiler.noteScript("forfeit"), AccountId.fromBech32(me), wallet);
  await submitMove(ctx, me, { inputs: [{ note }], expected: [forfeit] });
  return forfeit;
}

/** Rebuilds my own shot note (to reclaim it) from the turn it was fired on. */
export async function myShotNote(ctx: GameContext, me: string, opponent: string, row: number, col: number, turn: number, deadline: number): Promise<Note> {
  return expectedShotNote(await ctx.compiler.noteScript("shot"), AccountId.fromBech32(me), AccountId.fromBech32(opponent), row, col, turn, deadline);
}

/** Rebuilds the result note my account created for the opponent's shot (to reclaim it). */
export async function myResultNote(ctx: GameContext, me: string, shooter: string, outcome: ShotOutcome, deadline: number): Promise<Note> {
  return expectedResultNote(await ctx.compiler.noteScript("result"), AccountId.fromBech32(me), AccountId.fromBech32(shooter), outcome.turn, outcome.isHit, outcome.gameOver, deadline);
}

// ---------------------------------------------------------------------------
// Stakes (wallet transactions)
// ---------------------------------------------------------------------------

/** The wallet publishes a stake note of `amount` fee-asset units naming the opponent. */
export async function publishStake(ctx: GameContext, parties: StakeParties, amount: bigint, expiry: number): Promise<Note> {
  const feeFaucet = await ctx.client.feeFaucetId();
  const from = addressOf(parties.myWallet);
  const note = buildStakeNote(await ctx.compiler.noteScript("stake"), parties, expiry, feeFaucet, amount);
  const txId = await submitNoteDirect([note], from, ctx.client, ctx.prover);
  await waitForCommit(ctx, txId);
  return note;
}

/** The wallet consumes a defeat/forfeit note together with the stake notes it unlocks (or refunds). */
export async function claimNotes(ctx: GameContext, wallet: string, notes: Note[]): Promise<string> {
  return consumeNotes(ctx, wallet, notes);
}

// ---------------------------------------------------------------------------
// Note classification and parsing
// ---------------------------------------------------------------------------

export type ClassifiedNote = { kind: NoteScriptKind | "funding" | "unknown"; record: InputNoteRecord };

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
    if (roots[kind] === root) return { kind, record };
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

/**
 * Whether this client already created a note of the given kind for `target` in game `gameId`
 * (e.g. the accept note). The store may still hold notes of earlier games, so the target tag and
 * the game id carried in the handshake storage are both checked.
 */
export async function hasSentNote(ctx: GameContext, kind: "challenge" | "accept", target: string, gameId: FeltValues): Promise<boolean> {
  const roots = await ctx.compiler.noteScriptRoots();
  const targetTag = NoteTag.withAccountTarget(AccountId.fromBech32(target)).asU32();
  const records = await ctx.client.getOutputNotes(new NoteFilter(NoteFilterTypes.All));
  return records.some((r) => {
    try {
      const recipient = r.recipient();
      if (!recipient || recipient.script().root().toHex().toLowerCase() !== roots[kind]) return false;
      if (r.metadata().tag().asU32() !== targetTag) return false;
      const items = recipient.storage().items();
      return items.length === HANDSHAKE_NOTE_ITEMS && feltValues(items.slice(0, 4)).every((v, i) => v === gameId[i]);
    } catch {
      return false;
    }
  });
}

export interface HandshakeData {
  gameId: FeltValues;
  sender: AccountId;
  seed: FeltValues;
  wallet: AccountId;
  roots: ScriptRoots;
}

/** Parses challenge/accept note storage: [GAME_ID(4), sender(2), SEED(4), wallet(2), ROOTS(16)]. */
export function parseHandshakeStorage(note: Note): HandshakeData {
  const items = feltValues(note.recipient().storage().items());
  if (items.length !== HANDSHAKE_NOTE_ITEMS) throw new Error(`Handshake note has ${items.length} storage items, expected ${HANDSHAKE_NOTE_ITEMS}`);
  const id = (at: number) => AccountId.fromPrefixSuffix(...(feltsOf(items.slice(at, at + 2)) as [Felt, Felt]));
  return {
    gameId: items.slice(0, 4),
    sender: id(4),
    seed: items.slice(6, 10),
    wallet: id(10),
    roots: { shot: items.slice(12, 16), result: items.slice(16, 20), defeat: items.slice(20, 24), forfeit: items.slice(24, 28) },
  };
}

export interface ShotData {
  row: number;
  col: number;
  turn: number;
  deadline: number;
}

/** Parses shot note storage: [row, col, turn, deadline]. */
export function parseShotStorage(note: Note): ShotData {
  const items = feltValues(note.recipient().storage().items());
  if (items.length !== SHOT_NOTE_ITEMS) throw new Error(`Shot note has ${items.length} storage items, expected ${SHOT_NOTE_ITEMS}`);
  return { row: Number(items[0]), col: Number(items[1]), turn: Number(items[2]), deadline: Number(items[3]) };
}

export interface ResultData {
  shooter: AccountId;
  turn: number;
  isHit: boolean;
  isGameOver: boolean;
  deadline: number;
}

/** Parses result note storage: [shooter_prefix, shooter_suffix, turn, encoded_result, deadline]. */
export function parseResultStorage(note: Note): ResultData {
  const items = feltValues(note.recipient().storage().items());
  if (items.length !== RESULT_NOTE_ITEMS) throw new Error(`Result note has ${items.length} storage items, expected ${RESULT_NOTE_ITEMS}`);
  const { isHit, isGameOver } = decodeResult(items[3]);
  return { shooter: AccountId.fromPrefixSuffix(...(feltsOf(items.slice(0, 2)) as [Felt, Felt])), turn: Number(items[2]), isHit, isGameOver, deadline: Number(items[4]) };
}

/** Parses defeat/forfeit note storage: [wallet_prefix, wallet_suffix]. */
export function parseWalletNoteStorage(note: Note): AccountId {
  const items = note.recipient().storage().items();
  if (items.length !== WALLET_NOTE_ITEMS) throw new Error(`Wallet note has ${items.length} storage items, expected ${WALLET_NOTE_ITEMS}`);
  return AccountId.fromPrefixSuffix(items[0], items[1]);
}

export interface StakeData {
  myWallet: AccountId;
  myGame: AccountId;
  oppWallet: AccountId;
  oppGame: AccountId;
  expiry: number;
  amount: bigint;
}

/** Parses stake note storage and its fee-asset amount. */
export function parseStakeNote(note: Note): StakeData {
  const items = note.recipient().storage().items();
  if (items.length !== STAKE_NOTE_ITEMS) throw new Error(`Stake note has ${items.length} storage items, expected ${STAKE_NOTE_ITEMS}`);
  const id = (at: number) => AccountId.fromPrefixSuffix(items[at], items[at + 1]);
  const amount = note
    .assets()
    .fungibleAssets()
    .reduce((sum, a) => sum + a.amount(), 0n);
  return { myWallet: id(0), myGame: id(2), oppWallet: id(4), oppGame: id(6), expiry: Number(items[8].asInt()), amount };
}

/** The opponent and game id a game account stored during setup (null before setup). */
export function readGameIdentity(account: Account): { opponent: AccountId; gameId: FeltValues } | null {
  const storage = account.storage();
  const state = readGameState(storage);
  const gameId = storage.getItem(SLOT_GAME_ID)?.toFelts();
  if (!state || !gameId) return null;
  const opponent = storage.getItem(SLOT_OPPONENT)?.toFelts();
  if (!opponent || opponent[0].asInt() === 0n) return null;
  return { opponent: AccountId.fromPrefixSuffix(opponent[0], opponent[1]), gameId: feltValues(gameId) };
}
