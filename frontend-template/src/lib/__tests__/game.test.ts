import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));
vi.mock("@/lib/funding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/funding")>()),
  claimFaucetTokens: vi.fn(async () => "0xfundingnote"),
}));

import { AccountId, Felt, NoteScript, FungibleAsset, makeTestNote, makeTestRecord } from "@/__tests__/mocks/miden-sdk";
import { createMockGameAccount } from "@/__tests__/fixtures/battleship";
import { idValues } from "@/lib/notes";
import { PHASE_ACTIVE, PHASE_CHALLENGED, ROLE_ACCEPTOR, ROLE_CHALLENGER } from "@/types/game";
import { DEADLINE_DELTA_SECONDS } from "@/config";
const asNote = (n: unknown) => n as never;
const asId = (id: unknown) => id as never;

import {
  classifyNote,
  nextFireTurn,
  parseHandshakeStorage,
  parseResultStorage,
  parseShotStorage,
  parseStakeNote,
  pendingNotesFor,
  planResolution,
  planShot,
  predictShot,
  publishHandshake,
  reclaimNote,
  runSetup,
  submitMove,
  waitForCommit,
  waitForNote,
  type GameClient,
  type GameContext,
} from "@/lib/game";

const ROOTS = { challenge: "0xc", accept: "0xa", shot: "0xs", result: "0xr", defeat: "0xd", forfeit: "0xf", stake: "0xk" };
const SCRIPT_ROOTS = { shot: [1n, 1n, 1n, 1n], result: [2n, 2n, 2n, 2n], defeat: [3n, 3n, 3n, 3n], forfeit: [4n, 4n, 4n, 4n] };
const ME = "mtst1me";
const OPP = "mtst1opp";
const WALLET = "mtst1wallet";
type Calls = { calls: { method: string; args: unknown[] }[] };

function makeContext(overrides: Partial<GameClient> = {}) {
  const txStatus = { committed: true, discarded: false };
  const client = {
    syncState: vi.fn(async () => ({ blockNum: () => 42 })),
    getInputNotes: vi.fn(async () => []),
    getOutputNotes: vi.fn(async () => []),
    getAccount: vi.fn(async () => undefined),
    getTransactions: vi.fn(async () => [{ id: () => ({ toHex: () => "0xtx" }), transactionStatus: () => ({ isCommitted: () => txStatus.committed, isDiscarded: () => txStatus.discarded }) }]),
    feeFaucetId: vi.fn(async () => AccountId.fromBech32("mtst1feefaucet")),
    getSyncHeight: vi.fn(async () => 42),
    getBlockHeaderByNumber: vi.fn(async () => ({ timestamp: () => 1_000_000 })),
    newAccount: vi.fn(async () => {}),
    feeAwareTransactionRequestBuilder: vi.fn(async () => new (await import("@miden-sdk/miden-sdk")).TransactionRequestBuilder()),
    submitNewTransaction: vi.fn(async () => ({ toHex: () => "0xtx" })),
    submitNewTransactionWithProver: vi.fn(async () => ({ toHex: () => "0xtx" })),
    ...overrides,
  } as unknown as GameClient;
  const compiler = {
    noteScriptRoots: vi.fn(async () => ROOTS),
    noteScript: vi.fn(async (kind: keyof typeof ROOTS) => new NoteScript(ROOTS[kind])),
    txScript: vi.fn(async (kind: string) => ({ kind })),
    scriptRoots: vi.fn(async () => SCRIPT_ROOTS),
    component: vi.fn(async () => ({})),
  };
  const ctx = { client, compiler: compiler as unknown as GameContext["compiler"] } as GameContext;
  return { ctx, client: client as unknown as Record<string, ReturnType<typeof vi.fn>>, compiler, txStatus };
}

const lastRequest = (client: Record<string, ReturnType<typeof vi.fn>>) => client.submitNewTransaction.mock.calls.at(-1)![1] as Calls;

describe("note parsing", () => {
  it("parses handshake, shot, result and stake storage", () => {
    const seq = (n: number, from = 1) => Array.from({ length: n }, (_, i) => BigInt(from + i));
    const hs = parseHandshakeStorage(asNote(makeTestNote({ sender: OPP, target: ME, root: ROOTS.challenge, storage: seq(28) })));
    expect(hs.gameId).toEqual([1n, 2n, 3n, 4n]);
    expect(hs.sender.toString()).toBe("id:5:6");
    expect(hs.seed).toEqual([7n, 8n, 9n, 10n]);
    expect(hs.wallet.toString()).toBe("id:11:12");
    expect(hs.roots.shot).toEqual([13n, 14n, 15n, 16n]);
    expect(hs.roots.forfeit).toEqual([25n, 26n, 27n, 28n]);

    const shot = parseShotStorage(asNote(makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [3n, 4n, 7n, 500n] })));
    expect(shot).toEqual({ row: 3, col: 4, turn: 7, deadline: 500 });

    const result = parseResultStorage(asNote(makeTestNote({ sender: OPP, target: ME, root: ROOTS.result, storage: [5n, 6n, 9n, 3n, 600n] })));
    expect(result.shooter.toString()).toBe("id:5:6");
    expect([result.turn, result.isHit, result.isGameOver, result.deadline]).toEqual([9, true, true, 600]);

    const fee = AccountId.fromBech32("mtst1fee");
    const stake = parseStakeNote(asNote(makeTestNote({ sender: WALLET, target: OPP, root: ROOTS.stake, storage: [...seq(8), 77n], assets: [new FungibleAsset(fee, 2000n)] })));
    expect(stake.myWallet.toString()).toBe("id:1:2");
    expect(stake.oppGame.toString()).toBe("id:7:8");
    expect(stake.expiry).toBe(77);
    expect(stake.amount).toBe(2000n);
  });

  it("rejects storage of the wrong size", () => {
    expect(() => parseShotStorage(asNote(makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [1n, 2n] })))).toThrow(/expected 4/);
    expect(() => parseResultStorage(asNote(makeTestNote({ sender: OPP, target: ME, root: ROOTS.result, storage: [1n, 2n, 3n, 4n] })))).toThrow(/expected 5/);
  });
});

describe("classification and discovery", () => {
  it("classifies notes by script root and funding notes by the fee asset", async () => {
    const { ctx } = makeContext();
    const feeFaucet = AccountId.fromBech32("mtst1feefaucet");
    const shot = makeTestRecord(makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [] }));
    expect((await classifyNote(ctx, shot as never, asId(feeFaucet))).kind).toBe("shot");
    const defeat = makeTestRecord(makeTestNote({ sender: OPP, target: WALLET, root: ROOTS.defeat, storage: [] }));
    expect((await classifyNote(ctx, defeat as never, asId(feeFaucet))).kind).toBe("defeat");
    const unknown = makeTestRecord(makeTestNote({ sender: OPP, target: ME, root: "0xdead", storage: [] }));
    expect((await classifyNote(ctx, unknown as never, asId(feeFaucet))).kind).toBe("unknown");
    const funding = makeTestNote({ sender: "mtst1faucet", target: ME, root: "0xp2id", storage: [], assets: [new FungibleAsset(feeFaucet, 10_000n)] });
    expect((await classifyNote(ctx, makeTestRecord(funding) as never, asId(feeFaucet))).kind).toBe("funding");
  });

  it("lists only committed, unconsumed notes tagged for my account", async () => {
    const mine = makeTestRecord(makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [] }));
    const consumed = makeTestRecord(makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [] }), { consumed: true });
    const theirs = makeTestRecord(makeTestNote({ sender: ME, target: OPP, root: ROOTS.shot, storage: [] }));
    const { ctx } = makeContext({ getInputNotes: vi.fn(async () => [mine, consumed, theirs]) } as never);
    expect(await pendingNotesFor(ctx, ME)).toEqual([mine]);
  });

  it("waitForNote syncs until the predicate matches, then times out", async () => {
    const wanted = makeTestRecord(makeTestNote({ sender: OPP, target: ME, root: ROOTS.accept, storage: [] }));
    let calls = 0;
    const { ctx, client } = makeContext({ getInputNotes: vi.fn(async () => (++calls >= 2 ? [wanted] : [])) } as never);
    vi.useFakeTimers();
    const promise = waitForNote(ctx, (r) => (r as unknown) === wanted, 60_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe(wanted as never);
    expect(client.syncState).toHaveBeenCalledTimes(2);

    const never = waitForNote(ctx, () => false, 5_000);
    const rejection = expect(never).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    vi.useRealTimers();
  });
});

describe("transactions", () => {
  beforeEach(() => vi.useRealTimers());

  it("waitForCommit returns on commit and throws when discarded", async () => {
    const { ctx, txStatus } = makeContext();
    await expect(waitForCommit(ctx, "0xtx")).resolves.toBeUndefined();
    txStatus.committed = false;
    txStatus.discarded = true;
    await expect(waitForCommit(ctx, "0xtx")).rejects.toThrow(/discarded/);
  });

  it("runSetup submits the setup script with the 36-felt payload in the advice map", async () => {
    const { ctx, client } = makeContext();
    await runSetup(ctx, ME, [1n, 2n, 3n, 4n], asId(AccountId.fromBech32(OPP)), asId(AccountId.fromBech32(WALLET)), [{ row: 0, col: 0, shipId: 1 }]);
    const request = lastRequest(client);
    expect(request.calls.map((c) => c.method)).toEqual(["withCustomScript", "withScriptArg", "extendAdviceMap"]);
    expect((request.calls[0].args[0] as { kind: string }).kind).toBe("setup");
    const advice = request.calls[2].args[0] as { entries: Map<string, Felt[]> };
    expect([...advice.entries.values()][0]).toHaveLength(36);
  });

  it("publishHandshake sends a 28-item note from my game account to the opponent", async () => {
    const { ctx, client, compiler } = makeContext();
    const { noteId } = await publishHandshake(ctx, "challenge", ME, OPP, { gameId: [1n, 2n, 3n, 4n], seed: [5n, 6n, 7n, 8n], wallet: WALLET });
    expect(noteId).toMatch(/^0xnote/);
    expect(compiler.noteScript).toHaveBeenCalledWith("challenge");
    const request = lastRequest(client);
    expect(request.calls[0].method).toBe("withOwnOutputNotes");
    const [note] = (request.calls[0].args[0] as { notes: { recipient(): { storage(): { items(): Felt[] } } }[] }).notes;
    expect(note.recipient().storage().items()).toHaveLength(28);
  });

  it("nextFireTurn: challenger fires odd turns, acceptor even, turn 1 before the handshake completes", () => {
    const base = { phase: PHASE_ACTIVE, expectedTurn: 0, shipsHitCount: 0, totalShotsReceived: 0, resultsProcessed: 0, lastShot: { row: 0, col: 0, turn: 0 }, outcome: 0, ownerWallet: null, opponentWallet: null } as const;
    expect(nextFireTurn({ ...base, role: ROLE_CHALLENGER, shotsFired: 3 })).toBe(7);
    expect(nextFireTurn({ ...base, role: ROLE_ACCEPTOR, shotsFired: 3 })).toBe(8);
    expect(nextFireTurn({ ...base, phase: PHASE_CHALLENGED, role: 0, shotsFired: 0 })).toBe(1);
  });

  it("planShot derives the turn from my state and a 12-hour deadline from the latest block", async () => {
    const account = createMockGameAccount({ id: ME, role: ROLE_ACCEPTOR, shotsFired: 2, resultsProcessed: 2 });
    const { ctx } = makeContext({ getAccount: vi.fn(async () => account) } as never);
    const plan = await planShot(ctx, ME, OPP, 4, 5);
    expect(plan.turn).toBe(6);
    expect(plan.deadline).toBe(1_000_000 + DEADLINE_DELTA_SECONDS);
    expect(plan.args).toEqual([4n, 5n, BigInt(plan.deadline), 0n]);
    expect(plan.note.recipient().storage().items().map((f) => f.asInt())).toEqual([4n, 5n, 6n, BigInt(plan.deadline)]);
  });

  it("predictShot mirrors the contract: ship cells hit, 17th hit ends the game", () => {
    const account = createMockGameAccount({ id: ME, shipsHitCount: 16, boardCells: new Map([["0,0", 1], ["0,1", 6]]) });
    expect(predictShot(account as never, 0, 0)).toEqual({ isHit: true, gameOver: true });
    expect(predictShot(account as never, 0, 1)).toEqual({ isHit: false, gameOver: false }); // already hit: not a ship any more
    expect(predictShot(account as never, 5, 5)).toEqual({ isHit: false, gameOver: false });
  });

  it("planResolution predicts the result note and adds the defeat note on the 17th hit", async () => {
    const oppWallet = AccountId.fromBech32("mtst1oppwallet");
    const account = createMockGameAccount({ id: ME, shipsHitCount: 16, boardCells: new Map([["1,1", 3]]), opponentWallet: idValues(oppWallet as never) });
    const { ctx } = makeContext({ getAccount: vi.fn(async () => account) } as never);
    const shot = makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [1n, 1n, 4n, 999n] });
    const plan = await planResolution(ctx, ME, asNote(shot));
    expect(plan.outcome).toEqual({ row: 1, col: 1, turn: 4, isHit: true, gameOver: true });
    expect(plan.args).toEqual(Array(4).fill(BigInt(plan.deadline)));
    const shooter = AccountId.fromBech32(OPP);
    expect(plan.result.recipient().storage().items().map((f) => f.asInt())).toEqual([...idValues(shooter as never), 4n, 3n, BigInt(plan.deadline)]);
    expect(plan.defeat?.recipient().storage().items().map((f) => f.asInt())).toEqual(idValues(oppWallet as never));
  });

  it("submitMove consumes the inputs with their args, declares the expected notes and runs the fire script", async () => {
    const { ctx, client } = makeContext();
    const result = makeTestNote({ sender: OPP, target: ME, root: ROOTS.result, storage: [] });
    const shot = makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [] });
    const mine = makeTestNote({ sender: ME, target: OPP, root: ROOTS.shot, storage: [] });
    await submitMove(ctx, ME, { inputs: [{ note: asNote(result) }, { note: asNote(shot), args: [5n, 5n, 5n, 5n] }], expected: [asNote(mine)], fire: [1n, 2n, 3n, 0n] });
    const request = lastRequest(client);
    expect(request.calls.map((c) => c.method)).toEqual(["withInputNotes", "withExpectedOutputRecipients", "withCustomScript", "withScriptArg"]);
    const inputs = (request.calls[0].args[0] as { items: { note: unknown; args?: { toU64s(): bigint[] } | null }[] }).items;
    expect(inputs[0].args).toBeUndefined();
    expect(inputs[1].args?.toU64s()).toEqual([5n, 5n, 5n, 5n]);
    expect((request.calls[2].args[0] as { kind: string }).kind).toBe("fire");
  });

  it("reclaimNote consumes my own note and expects the forfeit note for my wallet", async () => {
    const wallet = AccountId.fromBech32(WALLET);
    const account = createMockGameAccount({ id: ME, ownerWallet: idValues(wallet as never) });
    const { ctx, client } = makeContext({ getAccount: vi.fn(async () => account) } as never);
    const mine = makeTestNote({ sender: ME, target: OPP, root: ROOTS.shot, storage: [] });
    const forfeit = await reclaimNote(ctx, ME, asNote(mine));
    expect(forfeit.recipient().storage().items().map((f) => f.asInt())).toEqual(idValues(wallet as never));
    expect(lastRequest(client).calls.map((c) => c.method)).toEqual(["withInputNotes", "withExpectedOutputRecipients"]);
  });
});
