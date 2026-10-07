import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));
vi.mock("@/lib/funding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/funding")>()),
  claimFaucetTokens: vi.fn(async () => "0xfundingnote"),
}));

import { AccountId, Felt, NoteScript, NoteTag, makeTestNote, makeTestRecord } from "@/__tests__/mocks/miden-sdk";
import { createMockGameAccount } from "@/__tests__/fixtures/battleship";
const asNote = (n: unknown) => n as never;
const asId = (id: unknown) => id as never;

import {
  classifyNote,
  consumeShot,
  parseHandshakeStorage,
  parseResultStorage,
  parseShotStorage,
  pendingNotesFor,
  predictShot,
  publishShot,
  runSetup,
  waitForCommit,
  waitForNote,
  type GameClient,
  type GameContext,
} from "@/lib/game";

const ROOTS = { challenge: "0xc", accept: "0xa", shot: "0xs", result: "0xr", reveal: "0xv" };
const ME = "mtst1me";
const OPP = "mtst1opp";

function makeContext(overrides: Partial<GameClient> = {}) {
  const txStatus = { committed: true, discarded: false };
  const client = {
    syncState: vi.fn(async () => ({ blockNum: () => 42 })),
    getInputNotes: vi.fn(async () => []),
    getAccount: vi.fn(async () => undefined),
    getTransactions: vi.fn(async () => [{ id: () => ({ toHex: () => "0xtx" }), transactionStatus: () => ({ isCommitted: () => txStatus.committed, isDiscarded: () => txStatus.discarded }) }]),
    feeFaucetId: vi.fn(async () => AccountId.fromBech32("mtst1feefaucet")),
    newConsumeTransactionRequest: vi.fn(async () => ({ kind: "consume" })),
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
    resultScriptRoot: vi.fn(async () => [1n, 2n, 3n, 4n]),
    component: vi.fn(async () => ({})),
  };
  const ctx = { client, compiler: compiler as unknown as GameContext["compiler"] } as GameContext;
  return { ctx, client: client as unknown as Record<string, ReturnType<typeof vi.fn>>, compiler, txStatus };
}

describe("note parsing", () => {
  it("parses handshake, shot and result storage", () => {
    const hs = parseHandshakeStorage(asNote(makeTestNote({ sender: OPP, target: ME, root: ROOTS.challenge, storage: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n] })));
    expect(hs.gameId).toEqual([1n, 2n, 3n, 4n]);
    expect(hs.sender.toString()).toBe("id:5:6");
    expect(hs.commitment).toEqual([7n, 8n, 9n, 10n]);

    const shot = parseShotStorage(asNote(makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [3n, 4n, 7n, 1n, 1n, 1n, 1n, 2n, 2n, 2n, 2n] })));
    expect([shot.row, shot.col, shot.turn]).toEqual([3, 4, 7]);

    const result = parseResultStorage(asNote(makeTestNote({ sender: OPP, target: ME, root: ROOTS.result, storage: [5n, 6n, 9n, 3n] })));
    expect(result.turn).toBe(9);
    expect(result.isHit).toBe(true);
    expect(result.isGameOver).toBe(true);
  });

  it("rejects storage of the wrong size", () => {
    expect(() => parseShotStorage(asNote(makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [1n, 2n] })))).toThrow(/expected 11/);
  });
});

describe("classification and discovery", () => {
  it("classifies notes by script root and funding notes by the fee asset", async () => {
    const { ctx } = makeContext();
    const feeFaucet = AccountId.fromBech32("mtst1feefaucet");
    const shot = makeTestRecord(makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [] }));
    expect((await classifyNote(ctx, shot as never, asId(feeFaucet))).kind).toBe("shot");
    const unknown = makeTestRecord(makeTestNote({ sender: OPP, target: ME, root: "0xdead", storage: [] }));
    expect((await classifyNote(ctx, unknown as never, asId(feeFaucet))).kind).toBe("unknown");
    const funding = makeTestNote({ sender: "mtst1faucet", target: ME, root: "0xp2id", storage: [] });
    funding.noteAssets.fungible.push({ faucetId: () => feeFaucet, amount: () => 10_000n });
    expect((await classifyNote(ctx, makeTestRecord(funding) as never, asId(feeFaucet))).kind).toBe("funding");
  });

  it("lists only committed, unconsumed notes tagged for my account", async () => {
    const mine = makeTestRecord(makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [] }));
    const consumed = makeTestRecord(makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [] }), { consumed: true });
    const theirs = makeTestRecord(makeTestNote({ sender: ME, target: OPP, root: ROOTS.shot, storage: [] }));
    const { ctx } = makeContext({ getInputNotes: vi.fn(async () => [mine, consumed, theirs]) } as never);
    const pending = await pendingNotesFor(ctx, ME);
    expect(pending).toEqual([mine]);
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

  it("runSetup submits the setup script with the payload in the advice map", async () => {
    const { ctx, client } = makeContext();
    const opponent = AccountId.fromBech32(OPP);
    await runSetup(ctx, ME, [1n, 2n, 3n, 4n], asId(opponent), [5n, 6n, 7n, 8n], [{ row: 0, col: 0, shipId: 1 }]);
    const request = client.submitNewTransaction.mock.calls[0][1] as { calls: { method: string; args: unknown[] }[] };
    expect(request.calls.map((c) => c.method)).toEqual(["withCustomScript", "withScriptArg", "extendAdviceMap"]);
    expect((request.calls[0].args[0] as { kind: string }).kind).toBe("setup");
  });

  it("publishShot sends a shot note carrying a fresh result serial and the result script root", async () => {
    const { ctx, client, compiler } = makeContext();
    const { resultSerial } = await publishShot(ctx, ME, OPP, 2, 3, 5);
    expect(resultSerial).toHaveLength(4);
    expect(compiler.noteScript).toHaveBeenCalledWith("shot");
    expect(client.submitNewTransaction).toHaveBeenCalledTimes(1);
  });

  it("predictShot mirrors the contract: ship cells hit, 17th hit ends the game", () => {
    const account = createMockGameAccount({ id: ME, shipsHitCount: 16, boardCells: new Map([["0,0", 1], ["0,1", 6]]) });
    expect(predictShot(account as never, 0, 0)).toEqual({ isHit: true, gameOver: true });
    expect(predictShot(account as never, 0, 1)).toEqual({ isHit: false, gameOver: false }); // already hit: not a ship any more
    expect(predictShot(account as never, 5, 5)).toEqual({ isHit: false, gameOver: false });
  });

  it("consumeShot declares the exact result recipient for the shooter", async () => {
    const account = createMockGameAccount({ id: ME, shipsHitCount: 2, boardCells: new Map([["1,1", 3]]) });
    const { ctx, client } = makeContext({ getAccount: vi.fn(async () => account) } as never);
    const shot = makeTestNote({ sender: OPP, target: ME, root: ROOTS.shot, storage: [1n, 1n, 4n, 9n, 9n, 9n, 9n, 1n, 2n, 3n, 4n] });
    const outcome = await consumeShot(ctx, ME, makeTestRecord(shot) as never);
    expect(outcome).toEqual({ row: 1, col: 1, turn: 4, isHit: true, gameOver: false });
    const request = client.submitNewTransaction.mock.calls[0][1] as { calls: { method: string; args: unknown[] }[] };
    expect(request.calls.map((c) => c.method)).toEqual(["withInputNotes", "withExpectedOutputRecipients"]);
    const recipients = request.calls[1].args[0] as { items: { storage(): { items(): Felt[] }; serialNum(): { toU64s(): bigint[] } }[] };
    const [recipient] = recipients.items;
    expect(recipient.serialNum().toU64s()).toEqual([9n, 9n, 9n, 9n]);
    const shooter = AccountId.fromBech32(OPP);
    expect(recipient.storage().items().map((f) => f.asInt())).toEqual([shooter.prefix().asInt(), shooter.suffix().asInt(), 4n, 2n]);
  });

  it("tags notes for the target account", () => {
    expect(NoteTag.withAccountTarget(AccountId.fromBech32(ME)).asU32()).toBe(NoteTag.withAccountTarget(AccountId.fromBech32(ME)).asU32());
    expect(NoteTag.withAccountTarget(AccountId.fromBech32(ME)).asU32()).not.toBe(NoteTag.withAccountTarget(AccountId.fromBech32(OPP)).asU32());
  });
});
