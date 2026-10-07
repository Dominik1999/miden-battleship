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
  NetworkId,
  Felt,
  FeltArray,
  Word,
  type AccountComponent,
  type NoteScript,
  type TransactionProver,
  type TransactionRequest,
  type TransactionRequestBuilder,
  type TransactionScript,
} from "@miden-sdk/miden-sdk";
import { randomWord } from "@/lib/miden";
import { packBoard } from "@/lib/board";
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

// ---------------------------------------------------------------------------
// Payload / storage builders (pure)
// ---------------------------------------------------------------------------

/** Setup payload: game_id(4) + opponent(prefix, suffix) + commitment(4) + packed_rows(10) = 20 felts */
export function buildSetupPayload(
  gameId: FeltValues,
  oppPrefix: Felt,
  oppSuffix: Felt,
  commitment: FeltValues,
  shipCells: ShipCell[],
): Felt[] {
  return [
    ...felts(gameId.slice(0, 4)),
    oppPrefix,
    oppSuffix,
    ...felts(commitment.slice(0, 4)),
    ...felts(packBoard(shipCells)),
  ];
}

/**
 * Build the setup transaction request: the 20-felt payload is placed in the advice
 * map under `key`, and the same key is passed as the transaction script argument so
 * the script can `adv.push_mapvaln` it. Two `Word`s are built from fresh felts because
 * wasm-bindgen moves each one into the SDK.
 */
export function buildSetupRequest(
  builder: TransactionRequestBuilder,
  setupScript: TransactionScript,
  payload: Felt[],
  key: FeltValues,
): TransactionRequest {
  const adviceMap = new AdviceMap();
  adviceMap.insert(Word.newFromFelts(felts(key)), new FeltArray(payload));
  return builder
    .withCustomScript(setupScript)
    .withScriptArg(Word.newFromFelts(felts(key)))
    .extendAdviceMap(adviceMap)
    .build();
}

/** Challenge/accept note storage: game_id(4) + sender(prefix, suffix) + commitment(4) = 10 felts */
export function buildHandshakeStorage(
  gameId: FeltValues,
  senderPrefix: Felt,
  senderSuffix: Felt,
  commitment: FeltValues,
): FeltArray {
  return new FeltArray([...felts(gameId.slice(0, 4)), senderPrefix, senderSuffix, ...felts(commitment.slice(0, 4))]);
}

/** Shot note storage: row, col, turn, result_serial_num(4), result_script_root(4) = 11 felts */
export function buildShotStorage(
  row: number,
  col: number,
  turn: number,
  resultSerial: FeltValues,
  resultScriptRoot: FeltValues,
): FeltArray {
  return new FeltArray([
    new Felt(BigInt(row)),
    new Felt(BigInt(col)),
    new Felt(BigInt(turn)),
    ...felts(resultSerial.slice(0, 4)),
    ...felts(resultScriptRoot.slice(0, 4)),
  ]);
}

/** Reveal note storage: commitment(4) */
export function buildRevealStorage(commitment: FeltValues): FeltArray {
  return new FeltArray(felts(commitment.slice(0, 4)));
}

/** Encode a shot result the way the contract does: is_hit * 2 + game_over. */
export function encodeResult(isHit: boolean, gameOver: boolean): bigint {
  return (isHit ? 2n : 0n) + (gameOver ? 1n : 0n);
}

/** Decode the result-note `encoded_result` felt. */
export function decodeResult(encoded: bigint): { isHit: boolean; isGameOver: boolean } {
  return { isHit: encoded / 2n === 1n, isGameOver: encoded % 2n === 1n };
}

/**
 * Recipient of the result note the defender's component creates when it consumes
 * a shot note: storage [shooter_prefix, shooter_suffix, turn, encoded_result],
 * the serial number from the shot note and the result note script.
 */
export function buildResultRecipient(
  serialNum: FeltValues,
  resultScript: NoteScript,
  shooterPrefix: Felt,
  shooterSuffix: Felt,
  turn: number,
  encodedResult: bigint,
): NoteRecipient {
  const storage = new NoteStorage(
    new FeltArray([shooterPrefix, shooterSuffix, new Felt(BigInt(turn)), new Felt(encodedResult)]),
  );
  return new NoteRecipient(Word.newFromFelts(felts(serialNum)), resultScript, storage);
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/** Build a public note (no assets) targeting `targetAccount`, sent by `senderId`. */
export function buildNote(
  noteScript: NoteScript,
  storage: FeltArray,
  targetAccount: AccountId,
  senderId: AccountId,
): { note: Note; noteId: string; tag: number } {
  const recipient = new NoteRecipient(randomWord(), noteScript, new NoteStorage(storage));
  const noteTag = NoteTag.withAccountTarget(targetAccount);
  const tag = noteTag.asU32();
  const metadata = new NoteMetadata(senderId, NoteType.Public, noteTag);
  const note = new Note(new NoteAssets(), metadata, recipient);
  // Read the id BEFORE the note is moved into a NoteArray (wasm-bindgen moves by-value args).
  const noteId = note.id().toString();
  log(`Built note — ID: ${noteId}, tag: ${tag}`);
  return { note, noteId, tag };
}

/** Submit a built request from a game account, with the remote prover when available. */
export async function submitRequest(
  client: TxClient,
  gameAccountAddress: string,
  request: TransactionRequest,
  prover?: TransactionProver | null,
): Promise<string> {
  const accountId = AccountId.fromBech32(gameAccountAddress);
  const txId = prover
    ? await client.submitNewTransactionWithProver(accountId, request, prover)
    : await client.submitNewTransaction(accountId, request);
  return txId.toHex();
}

/**
 * Submit note(s) directly from a no-auth game account — no wallet popup needed.
 * The fee is paid from the game account's vault (fee-aware request builder).
 */
export async function submitNoteDirect(
  notes: Note[],
  gameAccountAddress: string,
  client: TxClient,
  prover?: TransactionProver | null,
): Promise<string> {
  const builder = await client.feeAwareTransactionRequestBuilder(
    AccountId.fromBech32(gameAccountAddress),
  );
  const request = builder.withOwnOutputNotes(new NoteArray(notes)).build();
  log(`Submitting ${notes.length} note(s) directly from game account (no wallet popup)...`);
  const txId = await submitRequest(client, gameAccountAddress, request, prover);
  log(`${notes.length} note(s) submitted — tx ${txId}`);
  return txId;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * Create a public game account: battleship component + BasicWallet (to receive the
 * USDCx funding note) + NoAuth (pays fees itself; no keys, no popups).
 * The account is only deployed on-chain by its first transaction.
 */
export async function createGameAccount(
  client: { newAccount(account: unknown, overwrite: boolean): Promise<void> },
  component: AccountComponent,
): Promise<string> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const { account } = new AccountBuilder(seed)
    .accountType(AccountType.Public)
    .storageMode(AccountStorageMode.public())
    .withComponent(component)
    .withBasicWalletComponent()
    .withNoAuthComponent()
    .build();
  // Read the address before handing the account handle to the client.
  const address = Address.fromAccountId(account.id()).toBech32(NetworkId.testnet());
  await client.newAccount(account, false);
  return address;
}

/** bech32 address of an account given its (prefix, suffix) felts as stored in notes/slots. */
export function addressFromPrefixSuffix(prefix: Felt, suffix: Felt): string {
  const id = AccountId.fromPrefixSuffix(prefix, suffix);
  return Address.fromAccountId(id).toBech32(NetworkId.testnet());
}
