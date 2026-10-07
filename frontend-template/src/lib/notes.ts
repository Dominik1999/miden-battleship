import {
  AdviceMap,
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
  FungibleAsset,
  NetworkId,
  Felt,
  FeltArray,
  Word,
  type AccountComponent,
  type NoteScript,
  TransactionRequestBuilder,
  type TransactionProver,
  type TransactionRequest,
  type TransactionScript,
} from "@miden-sdk/miden-sdk";
import { packBoard } from "@/lib/board";
import { scriptRootFelts, type ScriptRoots } from "@/lib/contracts";
import {
  HANDSHAKE_NOTE_ITEMS,
  SERIAL_KIND_DEFEAT,
  SERIAL_KIND_FORFEIT,
  SERIAL_KIND_RESULT,
  SERIAL_KIND_SHOT,
  SETUP_PAYLOAD_ITEMS,
} from "@/config";
import type { ShipCell } from "@/types/game";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[Notes] ${msg}`, "color: #6af; font-weight: bold", ...args);

/**
 * wasm-bindgen consumes `Felt`/`Word` handles passed by value (into a `FeltArray`, a
 * `Word`, a builder...), so app code keeps field elements as plain `bigint`s and every
 * builder below creates FRESH handles at the point of use.
 */
export type FeltValues = bigint[];

export const felts = (values: FeltValues): Felt[] => values.map((v) => new Felt(v));
export const feltValues = (handles: Felt[]): FeltValues => handles.map((f) => f.asInt());
export const toWord = (values: FeltValues): Word => Word.newFromFelts(felts(values.slice(0, 4)));

/** The part of the WebClient needed to build and submit transactions. */
export interface TxClient {
  feeAwareTransactionRequestBuilder(accountId: AccountId): Promise<TransactionRequestBuilder>;
  submitNewTransaction(accountId: AccountId, request: TransactionRequest): Promise<{ toHex(): string }>;
  submitNewTransactionWithProver(
    accountId: AccountId,
    request: TransactionRequest,
    prover: TransactionProver,
  ): Promise<{ toHex(): string }>;
}

/** [prefix, suffix] of an account id as plain values. */
export function idValues(id: AccountId): [bigint, bigint] {
  return [id.prefix().asInt(), id.suffix().asInt()];
}

/** bech32 address of an account given its (prefix, suffix) as stored in notes/slots. */
export function addressFromValues(prefix: bigint, suffix: bigint): string {
  return Address.fromAccountId(AccountId.fromPrefixSuffix(new Felt(prefix), new Felt(suffix))).toBech32(NetworkId.testnet());
}

export function addressOf(id: AccountId): string {
  return Address.fromAccountId(id).toBech32(NetworkId.testnet());
}

/** A fresh handle for the same account id (wasm-bindgen consumes handles passed by value). */
export function cloneId(id: AccountId): AccountId {
  return AccountId.fromHex(id.toString());
}

// ---------------------------------------------------------------------------
// Payload / storage builders (pure values; mirror battleship.rs)
// ---------------------------------------------------------------------------

/** Setup payload: game_id(4) + opponent(2) + owner_wallet(2) + packed rows(10) + roots(16) + pad(2) = 36. */
export function buildSetupPayload(
  gameId: FeltValues,
  opponent: AccountId,
  ownerWallet: AccountId,
  shipCells: ShipCell[],
  roots: ScriptRoots,
): FeltValues {
  const payload = [...gameId.slice(0, 4), ...idValues(opponent), ...idValues(ownerWallet), ...packBoard(shipCells), ...scriptRootFelts(roots), 0n, 0n];
  if (payload.length !== SETUP_PAYLOAD_ITEMS) throw new Error(`setup payload has ${payload.length} items`);
  return payload;
}

/** Challenge/accept note storage: game_id(4) + sender(2) + seed(4) + wallet(2) + roots(16) = 28. */
export function buildHandshakeStorage(gameId: FeltValues, sender: AccountId, seed: FeltValues, wallet: AccountId, roots: ScriptRoots): FeltValues {
  const items = [...gameId.slice(0, 4), ...idValues(sender), ...seed.slice(0, 4), ...idValues(wallet), ...scriptRootFelts(roots)];
  if (items.length !== HANDSHAKE_NOTE_ITEMS) throw new Error(`handshake storage has ${items.length} items`);
  return items;
}

/** Shot note storage: [row, col, turn, deadline]. */
export function shotStorage(row: number, col: number, turn: number, deadline: number): FeltValues {
  return [BigInt(row), BigInt(col), BigInt(turn), BigInt(deadline)];
}

/** Result note storage: [shooter_prefix, shooter_suffix, turn, encoded_result, deadline]. */
export function resultStorage(shooter: AccountId, turn: number, isHit: boolean, gameOver: boolean, deadline: number): FeltValues {
  return [...idValues(shooter), BigInt(turn), encodeResult(isHit, gameOver), BigInt(deadline)];
}

/** Defeat / forfeit note storage: the target wallet. */
export function walletNoteStorage(wallet: AccountId): FeltValues {
  return [...idValues(wallet)];
}

/** Stake note storage: my wallet, my game, opponent wallet, opponent game, expiry. */
export function stakeStorage(parties: StakeParties, expiry: number): FeltValues {
  return [...idValues(parties.myWallet), ...idValues(parties.myGame), ...idValues(parties.oppWallet), ...idValues(parties.oppGame), BigInt(expiry)];
}

export interface StakeParties {
  myWallet: AccountId;
  myGame: AccountId;
  oppWallet: AccountId;
  oppGame: AccountId;
}

/** Serial number of a note a game account creates itself: [prefix, suffix, turn, kind]. */
export function ownSerial(account: AccountId, turn: number, kind: number): FeltValues {
  return [...idValues(account), BigInt(turn), BigInt(kind)];
}

/** Transaction script argument of `scripts/fire_tx.masm`. */
export function fireArgs(row: number, col: number, deadline: number): FeltValues {
  return [BigInt(row), BigInt(col), BigInt(deadline), 0n];
}

/** Note argument the defender passes when consuming a shot note: the result note's deadline. */
export function shotNoteArgs(resultDeadline: number): FeltValues {
  const d = BigInt(resultDeadline);
  return [d, d, d, d];
}

/** Encode a shot result the way the contract does: is_hit * 2 + game_over. */
export function encodeResult(isHit: boolean, gameOver: boolean): bigint {
  return (isHit ? 2n : 0n) + (gameOver ? 1n : 0n);
}

/** Decode the result-note `encoded_result` felt. */
export function decodeResult(encoded: bigint): { isHit: boolean; isGameOver: boolean } {
  return { isHit: encoded / 2n === 1n, isGameOver: encoded % 2n === 1n };
}

/** Random felt values (each < 2^32): game ids, note serials. */
export function randomValues(): FeltValues {
  const words = crypto.getRandomValues(new Uint32Array(4));
  return Array.from(words, (v) => BigInt(v));
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/** Build a public note targeting `target`, sent by `sender`, with the given serial and assets. */
export function buildNote(
  noteScript: NoteScript,
  storage: FeltValues,
  target: AccountId,
  sender: AccountId,
  serial: FeltValues = randomValues(),
  assets: NoteAssets = new NoteAssets(),
): Note {
  const recipient = new NoteRecipient(toWord(serial), noteScript, new NoteStorage(new FeltArray(felts(storage))));
  // NoteTag/NoteMetadata consume the id handles they receive: hand them copies so callers keep theirs.
  const metadata = new NoteMetadata(cloneId(sender), NoteType.Public, NoteTag.withAccountTarget(cloneId(target)));
  return new Note(assets, metadata, recipient);
}

/** The shot note `fire_shot` creates on `shooter` for `defender`. */
export function expectedShotNote(script: NoteScript, shooter: AccountId, defender: AccountId, row: number, col: number, turn: number, deadline: number): Note {
  return buildNote(script, shotStorage(row, col, turn, deadline), defender, shooter, ownSerial(shooter, turn, SERIAL_KIND_SHOT));
}

/** The result note `process_shot` creates on `defender` for `shooter`. */
export function expectedResultNote(
  script: NoteScript,
  defender: AccountId,
  shooter: AccountId,
  turn: number,
  isHit: boolean,
  gameOver: boolean,
  deadline: number,
): Note {
  return buildNote(script, resultStorage(shooter, turn, isHit, gameOver, deadline), shooter, defender, ownSerial(defender, turn, SERIAL_KIND_RESULT));
}

/** The defeat note `process_shot` creates on `loser` for `winnerWallet` on the 17th hit. */
export function expectedDefeatNote(script: NoteScript, loser: AccountId, winnerWallet: AccountId): Note {
  return buildNote(script, walletNoteStorage(winnerWallet), winnerWallet, loser, ownSerial(loser, 0, SERIAL_KIND_DEFEAT));
}

/** The forfeit note `claim_forfeit` creates on `claimant` for its `ownerWallet`. */
export function expectedForfeitNote(script: NoteScript, claimant: AccountId, ownerWallet: AccountId): Note {
  return buildNote(script, walletNoteStorage(ownerWallet), ownerWallet, claimant, ownSerial(claimant, 0, SERIAL_KIND_FORFEIT));
}

/** A stake note from `myWallet` holding `amount` of the fee asset, tagged for the opponent's wallet. */
export function buildStakeNote(script: NoteScript, parties: StakeParties, expiry: number, feeFaucet: AccountId, amount: bigint): Note {
  // Push rather than pass an array: wasm-bindgen reads array handles unreliably (see the agentic-kb note on reused Felt handles).
  const assets = new NoteAssets();
  assets.push(new FungibleAsset(feeFaucet, amount));
  const note = buildNote(script, stakeStorage(parties, expiry), parties.oppWallet, parties.myWallet, randomValues(), assets);
  const carried = note.assets().fungibleAssets();
  log(`Stake note carries ${carried.map((a) => `${a.amount()} of ${a.faucetId().toString()}`).join(", ")}`);
  return note;
}

/**
 * Build the setup transaction request: the 36-felt payload is placed in the advice map under
 * `key`, and the same key is passed as the transaction script argument so the script can
 * `adv.push_mapvaln` it. Two `Word`s are built from fresh felts because wasm-bindgen moves
 * each one into the SDK.
 */
export function buildSetupRequest(builder: TransactionRequestBuilder, setupScript: TransactionScript, payload: FeltValues, key: FeltValues): TransactionRequest {
  const adviceMap = new AdviceMap();
  adviceMap.insert(toWord(key), new FeltArray(felts(payload)));
  return builder.withCustomScript(setupScript).withScriptArg(toWord(key)).extendAdviceMap(adviceMap).build();
}

/** Submit a built request from an account, with the remote prover when available. */
export async function submitRequest(client: TxClient, address: string, request: TransactionRequest, prover?: TransactionProver | null): Promise<string> {
  const accountId = AccountId.fromBech32(address);
  const txId = prover ? await client.submitNewTransactionWithProver(accountId, request, prover) : await client.submitNewTransaction(accountId, request);
  return txId.toHex();
}

/**
 * Submit note(s) directly from a no-auth account (a game account or the local wallet). The fee
 * is paid from the account's vault (fee-aware request builder).
 */
export async function submitNoteDirect(notes: Note[], address: string, client: TxClient, prover?: TransactionProver | null): Promise<string> {
  // The plain builder, as in the Rust helpers: the client adds the fee conversion itself. The
  // NoteArray is filled with push so the callers keep valid note handles.
  const ownOutputs = new NoteArray();
  for (const note of notes) ownOutputs.push(note);
  const request = new TransactionRequestBuilder().withOwnOutputNotes(ownOutputs).build();
  log(`Submitting ${notes.length} note(s) from ${address}...`);
  const txId = await submitRequest(client, address, request, prover);
  log(`${notes.length} note(s) submitted — tx ${txId}`);
  return txId;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface AccountClient {
  newAccount(account: unknown, overwrite: boolean): Promise<void>;
}

/**
 * Create a PRIVATE game account: battleship component + BasicWallet (to receive the fee
 * asset) + NoAuth (pays fees itself; no keys, no popups). The account is only deployed
 * on-chain by its first transaction. The seed is carried in the handshake notes so the
 * opponent's account can verify that this account runs the same code.
 */
export async function createGameAccount(client: AccountClient, component: AccountComponent): Promise<{ address: string; seed: FeltValues }> {
  const initSeed = crypto.getRandomValues(new Uint8Array(32));
  const { account, seed } = new AccountBuilder(initSeed)
    .accountType(AccountType.Private)
    .storageMode(AccountStorageMode.private())
    .withComponent(component)
    .withBasicWalletComponent()
    .withNoAuthComponent()
    .buildWithoutSchemaCommitment();
  // Read the address and seed before handing the account handle to the client.
  const address = addressOf(account.id());
  const seedValues = feltValues(seed.toFelts());
  await client.newAccount(account, false);
  return { address, seed: seedValues };
}

/**
 * Create a public NoAuth wallet in the local client: the testnet stand-in for the player's
 * wallet. It receives defeat/forfeit notes, publishes stake notes and claims the stakes.
 */
export async function createLocalWallet(client: AccountClient): Promise<string> {
  const initSeed = crypto.getRandomValues(new Uint8Array(32));
  const { account } = new AccountBuilder(initSeed)
    .accountType(AccountType.Public)
    .storageMode(AccountStorageMode.public())
    .withBasicWalletComponent()
    .withNoAuthComponent()
    .buildWithoutSchemaCommitment();
  const address = addressOf(account.id());
  await client.newAccount(account, false);
  return address;
}
