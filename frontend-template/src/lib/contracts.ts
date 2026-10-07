import {
  AccountBuilder,
  AccountComponent,
  AccountStorageMode,
  AccountType,
  StorageMap,
  StorageSlot,
  type CodeBuilder,
  type NoteScript,
  type TransactionScript,
} from "@miden-sdk/miden-sdk";
import { MASM_SOURCES, substituteWord } from "@/lib/masmSources";
import {
  BATTLESHIP_COMPONENT_NAMESPACE,
  SLOT_BOARD_MAP,
  SLOT_GAME_CONFIG,
  SLOT_GAME_ID,
  SLOT_LAST_SHOT,
  SLOT_MY_SHOTS_MAP,
  SLOT_OPPONENT,
  SLOT_OPPONENT_WALLET,
  SLOT_OUTCOME,
  SLOT_OWNER_WALLET,
  SLOT_SCRIPT_ROOTS_MAP,
  SLOT_TURN_STATE,
} from "@/config";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[Contracts] ${msg}`, "color: #9c6; font-weight: bold", ...args);

/** The part of the WebClient needed to compile MASM (`WebClient.createCodeBuilder`). */
export interface CompilerClient {
  createCodeBuilder(): Promise<CodeBuilder>;
}

/** Note scripts a game account recognises or creates, plus the wallet-level stake note. */
export type NoteScriptKind = "challenge" | "accept" | "shot" | "result" | "defeat" | "forfeit" | "stake";
export type TxScriptKind = "setup" | "fire";

export const NOTE_SCRIPT_KINDS: readonly NoteScriptKind[] = ["challenge", "accept", "shot", "result", "defeat", "forfeit", "stake"];

const NOTE_SOURCES: Record<Exclude<NoteScriptKind, "stake">, keyof typeof MASM_SOURCES> = {
  challenge: "challengeNote",
  accept: "acceptNote",
  shot: "shotNote",
  result: "resultNote",
  defeat: "defeatNote",
  forfeit: "forfeitNote",
};

const TX_SOURCES: Record<TxScriptKind, keyof typeof MASM_SOURCES> = {
  setup: "setupTx",
  fire: "fireTx",
};

/** MAST roots (four felt values each) of the notes a game account creates, in `script_roots` order. */
export interface ScriptRoots {
  shot: bigint[];
  result: bigint[];
  defeat: bigint[];
  forfeit: bigint[];
}

/** The 16 felts `[SHOT, RESULT, DEFEAT, FORFEIT]` as carried in payloads and handshake notes. */
export function scriptRootFelts(roots: ScriptRoots): bigint[] {
  return [...roots.shot, ...roots.result, ...roots.defeat, ...roots.forfeit];
}

/**
 * Initial storage slots of the battleship component (name-addressed, must match the
 * `word("...")` constants and `all_storage_slots()` order in battleship_account.masm /
 * battleship.rs). Slot handles are moved into the component, so build a fresh array per compile.
 */
export function battleshipStorageSlots(): StorageSlot[] {
  return [
    StorageSlot.emptyValue(SLOT_GAME_CONFIG),
    StorageSlot.emptyValue(SLOT_OPPONENT),
    StorageSlot.emptyValue(SLOT_GAME_ID),
    StorageSlot.emptyValue(SLOT_OWNER_WALLET),
    StorageSlot.emptyValue(SLOT_OPPONENT_WALLET),
    StorageSlot.emptyValue(SLOT_TURN_STATE),
    StorageSlot.emptyValue(SLOT_LAST_SHOT),
    StorageSlot.emptyValue(SLOT_OUTCOME),
    StorageSlot.map(SLOT_BOARD_MAP, new StorageMap()),
    StorageSlot.map(SLOT_MY_SHOTS_MAP, new StorageMap()),
    StorageSlot.map(SLOT_SCRIPT_ROOTS_MAP, new StorageMap()),
  ];
}

/**
 * Compiles the battleship MASM sources with the web SDK's `CodeBuilder`.
 *
 * The account component embeds its own initial storage commitment (the seed-anchoring check in
 * the handshake needs it), so the component is compiled twice: once with zero placeholders to
 * build a throwaway account whose storage commitment is read back, then for real.
 *
 * wasm-bindgen moves most handles that are passed by value (a component into an
 * `AccountBuilder`, a script into a `NoteRecipient`/`withCustomScript`), so every public
 * method returns a FRESH handle. Only a private "library" component is cached: its
 * `componentCode()` is linked dynamically into the note/tx scripts so their `call`s resolve
 * to the exact procedures installed on the game account.
 */
export class ContractCompiler {
  private storageCommitment: Promise<bigint[]> | null = null;
  private libraryComponent: Promise<AccountComponent> | null = null;
  private roots: Promise<ScriptRoots> | null = null;
  private noteRoots: Promise<Record<NoteScriptKind, string>> | null = null;

  constructor(private readonly client: CompilerClient) {}

  /** The initial storage commitment every battleship game account starts from. */
  initStorageCommitment(): Promise<bigint[]> {
    if (!this.storageCommitment) {
      this.storageCommitment = this.computeStorageCommitment().catch((err) => {
        this.storageCommitment = null;
        throw err;
      });
    }
    return this.storageCommitment;
  }

  /** Compile a fresh battleship component with empty storage (for account creation). */
  async component(): Promise<AccountComponent> {
    const isc = await this.initStorageCommitment();
    return this.compileComponent(substituteWord(MASM_SOURCES.battleshipAccount, "ISC", isc));
  }

  /** Compile one of the transaction scripts (links the component dynamically). */
  async txScript(kind: TxScriptKind): Promise<TransactionScript> {
    const builder = await this.linkedBuilder();
    return builder.compileTxScript(MASM_SOURCES[TX_SOURCES[kind]]);
  }

  /** Compile one of the note scripts (links the component dynamically). */
  async noteScript(kind: NoteScriptKind): Promise<NoteScript> {
    if (kind === "stake") {
      const roots = await this.scriptRoots();
      const source = substituteWord(substituteWord(MASM_SOURCES.stakeNote, "DEFEAT", roots.defeat), "FORFEIT", roots.forfeit);
      return (await this.client.createCodeBuilder()).compileNoteScript(source);
    }
    const builder = await this.linkedBuilder();
    return builder.compileNoteScript(MASM_SOURCES[NOTE_SOURCES[kind]]);
  }

  /** Roots of the notes a game account creates (pinned in storage at setup, checked at the handshake). */
  scriptRoots(): Promise<ScriptRoots> {
    if (!this.roots) {
      this.roots = (async () => {
        const [shot, result, defeat, forfeit] = await Promise.all(
          (["shot", "result", "defeat", "forfeit"] as const).map(async (kind) => rootValues(await this.noteScript(kind))),
        );
        return { shot, result, defeat, forfeit };
      })().catch((err) => {
        this.roots = null;
        throw err;
      });
    }
    return this.roots;
  }

  /** MAST roots (hex) of every note script, keyed by kind; used to classify incoming notes. */
  noteScriptRoots(): Promise<Record<NoteScriptKind, string>> {
    if (!this.noteRoots) {
      this.noteRoots = Promise.all(
        NOTE_SCRIPT_KINDS.map(async (kind) => [kind, (await this.noteScript(kind)).root().toHex().toLowerCase()] as const),
      )
        .then((entries) => Object.fromEntries(entries) as Record<NoteScriptKind, string>)
        .catch((err) => {
          this.noteRoots = null;
          throw err;
        });
    }
    return this.noteRoots;
  }

  private async compileComponent(source: string): Promise<AccountComponent> {
    const t0 = performance.now();
    const builder = await this.client.createCodeBuilder();
    const code = builder.compileAccountComponentCodeWithPath(BATTLESHIP_COMPONENT_NAMESPACE, source);
    const component = AccountComponent.compile(code, battleshipStorageSlots()).withSupportsAllTypes();
    log(`Compiled battleship component in ${(performance.now() - t0).toFixed(0)}ms`);
    return component;
  }

  /** Builds a throwaway game account from the placeholder component and reads its storage commitment. */
  private async computeStorageCommitment(): Promise<bigint[]> {
    const placeholder = await this.compileComponent(substituteWord(MASM_SOURCES.battleshipAccount, "ISC", [0n, 0n, 0n, 0n]));
    const { account } = new AccountBuilder(new Uint8Array(32))
      .accountType(AccountType.Private)
      .storageMode(AccountStorageMode.private())
      .withComponent(placeholder)
      .withBasicWalletComponent()
      .withNoAuthComponent()
      .build();
    const isc = account
      .storage()
      .commitment()
      .toFelts()
      .map((f) => f.asInt());
    log(`Initial storage commitment [${isc.join(", ")}]`);
    return isc;
  }

  private getLibraryComponent(): Promise<AccountComponent> {
    if (!this.libraryComponent) {
      this.libraryComponent = this.component().catch((err) => {
        this.libraryComponent = null;
        throw err;
      });
    }
    return this.libraryComponent;
  }

  private async linkedBuilder(): Promise<CodeBuilder> {
    const component = await this.getLibraryComponent();
    const builder = await this.client.createCodeBuilder();
    builder.linkDynamicAccountComponentCode(component.componentCode());
    return builder;
  }
}

function rootValues(script: NoteScript): bigint[] {
  return script
    .root()
    .toFelts()
    .map((f) => f.asInt());
}

const compilers = new WeakMap<CompilerClient, ContractCompiler>();

/** One compiler per client (caches the linked component across calls). */
export function getContractCompiler(client: CompilerClient): ContractCompiler {
  let compiler = compilers.get(client);
  if (!compiler) {
    compiler = new ContractCompiler(client);
    compilers.set(client, compiler);
  }
  return compiler;
}
