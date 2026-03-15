import {
  TransactionRequestBuilder,
  Package,
  NoteScript,
  Note,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteInputs,
  NoteTag,
  NoteType,
  OutputNote,
  OutputNoteArray,
  AccountId,
  AccountBuilder,
  AccountComponent,
  AccountStorageMode,
  AccountType,
  Address,
  NetworkId,
  StorageSlot,
  StorageSlotArray,
  StorageMap,
  Felt,
  FeltArray,
} from "@miden-sdk/miden-sdk";
import { Transaction } from "@miden-sdk/miden-wallet-adapter";
import { randomWord } from "@/lib/miden";
import type { ShipCell } from "@/types/game";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[Notes] ${msg}`, "color: #6af; font-weight: bold", ...args);

/** Map note tags to human-readable names */
const NOTE_TAG_NAMES: Record<number, string> = {
  1: "setup (starter)",
  2: "setup (joiner)",
  3: "challenge",
  4: "accept",
};

/** Fetch and deserialize a .masp package from /packages/ */
export async function loadPackage(name: string): Promise<Package> {
  log(`Loading package: ${name}`);
  const t0 = performance.now();
  const buf = await fetch(`/packages/${name}`).then((r) => r.arrayBuffer());
  const pkg = Package.deserialize(new Uint8Array(buf));
  log(
    `Loaded ${name} (${(buf.byteLength / 1024).toFixed(1)} KB) in ${(performance.now() - t0).toFixed(0)}ms`,
  );
  return pkg;
}

/** Build setup-note inputs: game_id(4) + opponent(2) + commitment(4) + ships(17×3) = 61 felts */
export function buildSetupInputs(
  gameIdFelts: Felt[],
  oppPrefix: Felt,
  oppSuffix: Felt,
  commitment: Felt[],
  shipCells: ShipCell[],
): FeltArray {
  const arr = new FeltArray();
  for (let i = 0; i < 4; i++) arr.push(gameIdFelts[i]);
  arr.push(oppPrefix);
  arr.push(oppSuffix);
  for (let i = 0; i < 4; i++) arr.push(commitment[i]);
  for (const cell of shipCells) {
    arr.push(new Felt(BigInt(cell.row)));
    arr.push(new Felt(BigInt(cell.col)));
    arr.push(new Felt(BigInt(cell.shipId)));
  }
  return arr;
}

/** Build challenge/accept-note inputs: game_id(4) + account(2) + commitment(4) = 10 felts */
export function buildHandshakeInputs(
  gameIdFelts: Felt[],
  accountPrefix: Felt,
  accountSuffix: Felt,
  commitment: Felt[],
): FeltArray {
  const arr = new FeltArray();
  for (let i = 0; i < 4; i++) arr.push(gameIdFelts[i]);
  arr.push(accountPrefix);
  arr.push(accountSuffix);
  for (let i = 0; i < 4; i++) arr.push(commitment[i]);
  return arr;
}

/** Build, sign, and submit a note via the wallet adapter */
export async function submitNote(
  pkg: Package,
  inputs: FeltArray,
  targetAccount: AccountId,
  targetAddress: string,
  tag: number,
  walletAddress: string,
  walletId: AccountId,
  requestTransaction: (tx: unknown) => Promise<unknown>,
): Promise<string> {
  const noteTypeName = NOTE_TAG_NAMES[tag] ?? `unknown(tag=${tag})`;
  log(`Building ${noteTypeName} note → target: ${targetAddress}`);

  const noteScript = NoteScript.fromPackage(pkg);
  const noteInputs = new NoteInputs(inputs);
  const serialNum = randomWord();
  const recipient = new NoteRecipient(serialNum, noteScript, noteInputs);

  // Use account-targeted tag for proper routing
  // (raw integer tags like 1-4 don't encode routing info)
  const noteTag = NoteTag.withAccountTarget(targetAccount);
  const metadata = new NoteMetadata(
    walletId,
    NoteType.Public,
    noteTag,
  );

  const note = new Note(new NoteAssets(), metadata, recipient);
  log(`Built ${noteTypeName} note — ID: ${note.id().toString()}, noteTag: ${noteTag.asU32()}, sender: ${walletAddress}`);

  const outputNote = OutputNote.full(note);
  const txRequest = new TransactionRequestBuilder()
    .withOwnOutputNotes(new OutputNoteArray([outputNote]))
    .build();

  const tx = Transaction.createCustomTransaction(
    walletAddress,
    targetAddress,
    txRequest,
  );
  log(`Submitting ${noteTypeName} note via wallet adapter...`);
  await requestTransaction(tx);
  log(`${noteTypeName} note ${note.id().toString()} submitted successfully`);
  return note.id().toString();
}

/**
 * Create a game account with the battleship component using AccountBuilder.
 * Uses the WebClient directly (via useMidenClient) instead of the wallet extension.
 */
export async function createGameAccount(
  client: { newAccount(account: unknown, overwrite: boolean): Promise<void> },
  battleshipPkg: Package,
): Promise<string> {
  const seed = crypto.getRandomValues(new Uint8Array(32));

  // Initialize all 7 storage slots matching the contract's #[storage] fields (in order):
  // 1. game_config: [grid_size, num_placed, phase, expected_turn]
  // 2. opponent: [prefix, suffix, ships_hit_count, total_shots_received]
  // 3. board_commitment: [h0, h1, h2, h3]
  // 4. opponent_commitment: [h0, h1, h2, h3]
  // 5. game_id: [gid0, gid1, gid2, gid3]
  // 6. reveal_status: [my_revealed, opponent_verified, 0, 0]
  // 7. my_board: StorageMap for board cells and ship counts
  const slots = new StorageSlotArray([
    StorageSlot.emptyValue("miden::component::miden_battleship_account::game_config"),
    StorageSlot.emptyValue("miden::component::miden_battleship_account::opponent"),
    StorageSlot.emptyValue("miden::component::miden_battleship_account::board_commitment"),
    StorageSlot.emptyValue("miden::component::miden_battleship_account::opponent_commitment"),
    StorageSlot.emptyValue("miden::component::miden_battleship_account::game_id"),
    StorageSlot.emptyValue("miden::component::miden_battleship_account::reveal_status"),
    StorageSlot.map("miden::component::miden_battleship_account::my_board", new StorageMap()),
  ]);
  const component = AccountComponent.fromPackage(battleshipPkg, slots).withSupportsAllTypes();

  const builder = new AccountBuilder(seed)
    .accountType(AccountType.RegularAccountImmutableCode)
    .storageMode(AccountStorageMode.tryFromStr("public"))
    .withComponent(component)
    .withNoAuthComponent();

  const result = builder.build();
  const account = result.account;
  await client.newAccount(account, false);
  const address = Address.fromAccountId(account.id());
  return address.toBech32(NetworkId.testnet());
}
