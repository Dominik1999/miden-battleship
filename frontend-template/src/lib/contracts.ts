import {
  AccountComponent,
  StorageMap,
  StorageSlot,
  type CodeBuilder,
  type Felt,
  type NoteScript,
  type TransactionScript,
} from "@miden-sdk/miden-sdk";
import { MASM_SOURCES } from "@/lib/masmSources";
import {
  BATTLESHIP_COMPONENT_NAMESPACE,
  SLOT_BOARD_COMMITMENT,
  SLOT_BOARD_MAP,
  SLOT_GAME_CONFIG,
  SLOT_GAME_ID,
  SLOT_OPPONENT,
  SLOT_OPPONENT_COMMITMENT,
  SLOT_REVEAL_STATUS,
} from "@/config";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[Contracts] ${msg}`, "color: #9c6; font-weight: bold", ...args);

/** The part of the WebClient needed to compile MASM (`WebClient.createCodeBuilder`). */
export interface CompilerClient {
  createCodeBuilder(): Promise<CodeBuilder>;
}

export type NoteScriptKind = "challenge" | "accept" | "shot" | "result" | "reveal";
export type TxScriptKind = "setup" | "enterReveal" | "markMyReveal";

export const NOTE_SCRIPT_KINDS: readonly NoteScriptKind[] = ["challenge", "accept", "shot", "result", "reveal"];

const NOTE_SOURCES: Record<NoteScriptKind, keyof typeof MASM_SOURCES> = {
  challenge: "challengeNote",
  accept: "acceptNote",
  shot: "shotNote",
  result: "resultNote",
  reveal: "revealNote",
};

const TX_SOURCES: Record<TxScriptKind, keyof typeof MASM_SOURCES> = {
  setup: "setupTx",
  enterReveal: "enterRevealTx",
  markMyReveal: "markMyRevealTx",
};

/**
 * Initial storage slots of the battleship component (name-addressed, must match
 * the `word("...")` constants in battleship_account.masm):
 *   value slots: game_config, opponent, board_commitment, opponent_commitment, game_id, reveal_status
 *   map slot:    my_board (key [0,0,0,row] → [packed_row,0,0,0])
 * Slot handles are moved into the component, so build a fresh array per compile.
 */
export function battleshipStorageSlots(): StorageSlot[] {
  return [
    StorageSlot.emptyValue(SLOT_GAME_CONFIG),
    StorageSlot.emptyValue(SLOT_OPPONENT),
    StorageSlot.emptyValue(SLOT_BOARD_COMMITMENT),
    StorageSlot.emptyValue(SLOT_OPPONENT_COMMITMENT),
    StorageSlot.emptyValue(SLOT_GAME_ID),
    StorageSlot.emptyValue(SLOT_REVEAL_STATUS),
    StorageSlot.map(SLOT_BOARD_MAP, new StorageMap()),
  ];
}

/**
 * Compiles the battleship MASM sources with the web SDK's `CodeBuilder`.
 *
 * wasm-bindgen moves most handles that are passed by value (a component into an
 * `AccountBuilder`, a script into a `NoteRecipient`/`withCustomScript`), so every
 * public method returns a FRESH handle. Only a private "library" component is
 * cached: its `componentCode()` is linked dynamically into the note/tx scripts so
 * their `call`s resolve to the exact procedures installed on the game account.
 */
export class ContractCompiler {
  private libraryComponent: Promise<AccountComponent> | null = null;
  private resultRoot: Promise<bigint[]> | null = null;
  private noteRoots: Promise<Record<NoteScriptKind, string>> | null = null;

  constructor(private readonly client: CompilerClient) {}

  /** Compile a fresh battleship component with empty storage (for account creation). */
  async component(): Promise<AccountComponent> {
    const t0 = performance.now();
    const builder = await this.client.createCodeBuilder();
    const code = builder.compileAccountComponentCodeWithPath(
      BATTLESHIP_COMPONENT_NAMESPACE,
      MASM_SOURCES.battleshipAccount,
    );
    const component = AccountComponent.compile(code, battleshipStorageSlots()).withSupportsAllTypes();
    log(`Compiled battleship component in ${(performance.now() - t0).toFixed(0)}ms`);
    return component;
  }

  /** Compile one of the transaction scripts (links the component dynamically). */
  async txScript(kind: TxScriptKind): Promise<TransactionScript> {
    const builder = await this.linkedBuilder();
    return builder.compileTxScript(MASM_SOURCES[TX_SOURCES[kind]]);
  }

  /** MAST roots (hex) of every note script, keyed by kind; used to classify incoming notes. */
  noteScriptRoots(): Promise<Record<NoteScriptKind, string>> {
    if (!this.noteRoots) {
      this.noteRoots = Promise.all(
        NOTE_SCRIPT_KINDS.map(async (kind) => [kind, (await this.noteScript(kind)).root().toHex()] as const),
      )
        .then((entries) => Object.fromEntries(entries) as Record<NoteScriptKind, string>)
        .catch((err) => {
          this.noteRoots = null;
          throw err;
        });
    }
    return this.noteRoots;
  }

  /** Compile one of the note scripts (links the component dynamically). */
  async noteScript(kind: NoteScriptKind): Promise<NoteScript> {
    const builder = await this.linkedBuilder();
    return builder.compileNoteScript(MASM_SOURCES[NOTE_SOURCES[kind]]);
  }

  /** MAST root of the result note script (as felt values), as the shooter must place it in the shot note. */
  resultScriptRoot(): Promise<bigint[]> {
    if (!this.resultRoot) {
      this.resultRoot = this.noteScript("result")
        .then((script) => script.root().toFelts().map((f: Felt) => f.asInt()))
        .catch((err) => {
          this.resultRoot = null;
          throw err;
        });
    }
    return this.resultRoot;
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
