/**
 * Lightweight stand-ins for the WASM classes of @miden-sdk/miden-sdk used by the game
 * libraries and hooks. Only the behaviour the app relies on is modelled:
 *
 *   vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));
 */
import { vi } from "vitest";

export class Felt {
  constructor(readonly value: bigint) {}
  asInt(): bigint {
    return this.value;
  }
  toString(): string {
    return this.value.toString();
  }
}

export class FeltArray {
  readonly items: Felt[];
  constructor(elements?: Felt[] | null) {
    this.items = elements ? [...elements] : [];
  }
  push(f: Felt) {
    this.items.push(f);
  }
  length() {
    return this.items.length;
  }
  get(i: number) {
    return this.items[i];
  }
}

export class Word {
  constructor(readonly values: bigint[]) {}
  static fromHex(hex: string): Word {
    const clean = hex.replace(/^0x/, "").padStart(64, "0");
    return new Word([0, 1, 2, 3].map((i) => BigInt("0x" + clean.slice(i * 16, i * 16 + 16))));
  }
  static newFromFelts(felts: Felt[]): Word {
    return new Word(felts.map((f) => f.asInt()));
  }
  toFelts(): Felt[] {
    return this.values.map((v) => new Felt(v));
  }
  toU64s(): bigint[] {
    return [...this.values];
  }
  toHex(): string {
    return "0x" + this.values.map((v) => v.toString(16).padStart(16, "0")).join("");
  }
}

export class AccountId {
  constructor(
    readonly hex: string,
    private readonly values?: [bigint, bigint],
  ) {}
  static fromBech32(addr: string): AccountId {
    return new AccountId(addr);
  }
  static fromHex(hex: string): AccountId {
    return new AccountId(hex);
  }
  /** Round-trips: the id built from (prefix, suffix) reports exactly those values. */
  static fromPrefixSuffix(prefix: Felt, suffix: Felt): AccountId {
    return new AccountId(`id:${prefix.asInt()}:${suffix.asInt()}`, [prefix.asInt(), suffix.asInt()]);
  }
  prefix(): Felt {
    return new Felt(this.values ? this.values[0] : BigInt(hashString(this.hex + ":p")));
  }
  suffix(): Felt {
    return new Felt(this.values ? this.values[1] : BigInt(hashString(this.hex + ":s")));
  }
  toString(): string {
    return this.hex;
  }
}

export class Address {
  constructor(readonly id: AccountId) {}
  static fromAccountId(id: AccountId): Address {
    return new Address(id);
  }
  toBech32(): string {
    return this.id.hex;
  }
  accountId(): AccountId {
    return this.id;
  }
}

export const NetworkId = { testnet: () => "mtst" };

export class NoteTag {
  constructor(readonly tag: number) {}
  static withAccountTarget(id: AccountId): NoteTag {
    return new NoteTag(hashString(id.toString()) % 1_000_000);
  }
  asU32(): number {
    return this.tag;
  }
}

export const NoteType = { Public: 1, Private: 2 } as const;

export class FungibleAsset {
  constructor(
    readonly faucet: AccountId,
    readonly value: bigint,
  ) {}
  faucetId() {
    return this.faucet;
  }
  amount() {
    return this.value;
  }
}

export class NoteAssets {
  readonly fungible: FungibleAsset[];
  constructor(assets: FungibleAsset[] | null = []) {
    this.fungible = assets ? [...assets] : [];
  }
  fungibleAssets() {
    return this.fungible;
  }
  push(asset: FungibleAsset) {
    this.fungible.push(asset);
  }
}

export class NoteStorage {
  constructor(readonly felts: FeltArray) {}
  items(): Felt[] {
    return [...this.felts.items];
  }
}

export class NoteScript {
  constructor(readonly rootHex: string) {}
  root(): { toHex(): string; toFelts(): Felt[] } {
    return { toHex: () => this.rootHex, toFelts: () => [new Felt(1n), new Felt(2n), new Felt(3n), new Felt(4n)] };
  }
}

export class NoteRecipient {
  constructor(
    readonly serial: Word,
    readonly noteScript: NoteScript,
    readonly noteStorage: NoteStorage,
  ) {}
  serialNum() {
    return this.serial;
  }
  script() {
    return this.noteScript;
  }
  storage() {
    return this.noteStorage;
  }
}

export class NoteMetadata {
  constructor(
    readonly senderId: AccountId,
    readonly type: number,
    readonly noteTag: NoteTag,
  ) {}
  sender() {
    return this.senderId;
  }
  tag() {
    return this.noteTag;
  }
  noteType() {
    return this.type;
  }
}

let nextNoteId = 1;
export class Note {
  readonly noteId: string;
  constructor(
    readonly noteAssets: NoteAssets,
    readonly noteMetadata: NoteMetadata,
    readonly noteRecipient: NoteRecipient,
  ) {
    this.noteId = `0xnote${nextNoteId++}`;
  }
  id() {
    return { toString: () => this.noteId };
  }
  assets() {
    return this.noteAssets;
  }
  metadata() {
    return this.noteMetadata;
  }
  recipient() {
    return this.noteRecipient;
  }
  script() {
    return this.noteRecipient.script();
  }
}

export class NoteArray {
  readonly notes: Note[];
  constructor(notes: Note[] = []) {
    this.notes = [...notes];
  }
  push(note: Note) {
    this.notes.push(note);
  }
}
export class NoteAndArgs {
  constructor(
    readonly note: Note,
    readonly args?: Word | null,
  ) {}
}
export class NoteAndArgsArray {
  constructor(readonly items: NoteAndArgs[]) {}
}
export class NoteRecipientArray {
  constructor(readonly items: NoteRecipient[]) {}
}

export class AdviceMap {
  readonly entries = new Map<string, Felt[]>();
  insert(key: Word, value: FeltArray) {
    this.entries.set(key.toHex(), value.items);
  }
}

/** Records every builder call so tests can assert on the request shape. */
export class TransactionRequestBuilder {
  readonly calls: { method: string; args: unknown[] }[] = [];
  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    return this;
  }
  withCustomScript(...a: unknown[]) {
    return this.record("withCustomScript", ...a);
  }
  withScriptArg(...a: unknown[]) {
    return this.record("withScriptArg", ...a);
  }
  extendAdviceMap(...a: unknown[]) {
    return this.record("extendAdviceMap", ...a);
  }
  withOwnOutputNotes(...a: unknown[]) {
    return this.record("withOwnOutputNotes", ...a);
  }
  withInputNotes(...a: unknown[]) {
    return this.record("withInputNotes", ...a);
  }
  withExpectedOutputRecipients(...a: unknown[]) {
    return this.record("withExpectedOutputRecipients", ...a);
  }
  build() {
    return { calls: this.calls };
  }
}

export class NoteFilter {
  constructor(readonly type: number) {}
}
export const NoteFilterTypes = { All: 0, Consumed: 1, Committed: 2, Expected: 3, Processing: 4 } as const;

export class TransactionId {
  constructor(readonly hex: string) {}
  static fromHex(hex: string) {
    return new TransactionId(hex);
  }
  toHex() {
    return this.hex;
  }
}
export class TransactionFilter {
  constructor(readonly txIds: TransactionId[] | null) {}
  static ids(ids: TransactionId[]) {
    return new TransactionFilter(ids);
  }
  static uncommitted() {
    return new TransactionFilter(null);
  }
  static all() {
    return new TransactionFilter(null);
  }
}

export const AccountType = { Private: 0, Public: 1 };
export const AccountStorageMode = { public: () => "public", private: () => "private" };
let nextAccount = 1;
export class AccountBuilder {
  mode = "public";
  constructor(readonly seed: Uint8Array) {}
  accountType() {
    return this;
  }
  storageMode(mode: string) {
    this.mode = mode;
    return this;
  }
  withComponent() {
    return this;
  }
  withBasicWalletComponent() {
    return this;
  }
  withNoAuthComponent() {
    return this;
  }
  buildWithoutSchemaCommitment() {
    return this.build();
  }
  build() {
    const n = nextAccount++;
    const account = {
      id: () => new AccountId(`mtst1${this.mode}account${n}`),
      storage: () => ({ commitment: () => new Word([11n, 22n, 33n, 44n]) }),
    };
    return { account, seed: new Word([BigInt(n), 2n, 3n, 4n]) };
  }
}

export class StorageMap {}
export const StorageSlot = {
  emptyValue: vi.fn((name: string) => ({ name })),
  map: vi.fn((name: string) => ({ name })),
};
export const AccountComponent = {
  compile: vi.fn(() => ({ withSupportsAllTypes: () => ({ componentCode: () => ({}) }) })),
};

/** Deterministic small hash for mock ids/tags. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Test helper: a public game note with the given script root and storage felts. */
export function makeTestNote(opts: { sender: string; target: string; root: string; storage: bigint[]; serial?: bigint[]; assets?: FungibleAsset[] }): Note {
  const storage = new NoteStorage(new FeltArray(opts.storage.map((v) => new Felt(v))));
  const recipient = new NoteRecipient(new Word(opts.serial ?? [1n, 2n, 3n, 4n]), new NoteScript(opts.root), storage);
  const metadata = new NoteMetadata(AccountId.fromBech32(opts.sender), NoteType.Public, NoteTag.withAccountTarget(AccountId.fromBech32(opts.target)));
  return new Note(new NoteAssets(opts.assets ?? []), metadata, recipient);
}

/** Test helper: an InputNoteRecord-like wrapper around a note. */
export function makeTestRecord(note: Note, state: { consumed?: boolean; processing?: boolean } = {}) {
  return {
    id: () => note.id(),
    isConsumed: () => state.consumed ?? false,
    isProcessing: () => state.processing ?? false,
    isAuthenticated: () => true,
    metadata: () => note.metadata(),
    details: () => ({ recipient: () => note.recipient(), assets: () => note.assets() }),
    toNote: () => note,
  };
}
