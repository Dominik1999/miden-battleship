import { describe, it, expect, vi } from "vitest";

vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));

import { AccountId, TransactionRequestBuilder } from "@miden-sdk/miden-sdk";
import { NoteScript as MockNoteScript } from "@/__tests__/mocks/miden-sdk";
import {
  buildHandshakeStorage,
  buildNote,
  buildSetupPayload,
  buildSetupRequest,
  buildStakeNote,
  decodeResult,
  encodeResult,
  expectedDefeatNote,
  expectedResultNote,
  expectedShotNote,
  fireArgs,
  idValues,
  ownSerial,
  shotNoteArgs,
  stakeStorage,
} from "@/lib/notes";
import { HANDSHAKE_NOTE_ITEMS, SERIAL_KIND_DEFEAT, SERIAL_KIND_RESULT, SERIAL_KIND_SHOT, SETUP_PAYLOAD_ITEMS } from "@/config";

const script = (root: string) => new MockNoteScript(root) as never;
const ROOTS = { shot: [1n, 1n, 1n, 1n], result: [2n, 2n, 2n, 2n], defeat: [3n, 3n, 3n, 3n], forfeit: [4n, 4n, 4n, 4n] };
const me = AccountId.fromBech32("mtst1me");
const opp = AccountId.fromBech32("mtst1opp");
const wallet = AccountId.fromBech32("mtst1wallet");
const items = (note: { recipient(): { storage(): { items(): { asInt(): bigint }[] } } }) => note.recipient().storage().items().map((f) => f.asInt());

describe("payload and storage builders", () => {
  it("builds the 36-felt setup payload: game id, opponent, wallet, rows, roots, padding", () => {
    const payload = buildSetupPayload([1n, 2n, 3n, 4n], opp, wallet, [{ row: 0, col: 1, shipId: 2 }], ROOTS);
    expect(payload).toHaveLength(SETUP_PAYLOAD_ITEMS);
    expect(payload.slice(0, 4)).toEqual([1n, 2n, 3n, 4n]);
    expect(payload.slice(4, 6)).toEqual(idValues(opp));
    expect(payload.slice(6, 8)).toEqual(idValues(wallet));
    expect(payload[8]).toBe(2n << 3n); // row 0: ship 2 in column 1
    expect(payload.slice(9, 18).every((v) => v === 0n)).toBe(true);
    expect(payload.slice(18, 34)).toEqual([...ROOTS.shot, ...ROOTS.result, ...ROOTS.defeat, ...ROOTS.forfeit]);
    expect(payload.slice(34)).toEqual([0n, 0n]);
  });

  it("builds the setup request with the payload under the key and the key as script arg", () => {
    const request = buildSetupRequest(new TransactionRequestBuilder(), {} as never, [1n, 2n], [9n, 9n, 9n, 9n]) as unknown as { calls: { method: string }[] };
    expect(request.calls.map((c) => c.method)).toEqual(["withCustomScript", "withScriptArg", "extendAdviceMap"]);
  });

  it("builds 28-felt handshake storage: game id, sender, seed, wallet, roots", () => {
    const storage = buildHandshakeStorage([1n, 2n, 3n, 4n], me, [5n, 6n, 7n, 8n], wallet, ROOTS);
    expect(storage).toHaveLength(HANDSHAKE_NOTE_ITEMS);
    expect(storage.slice(4, 6)).toEqual(idValues(me));
    expect(storage.slice(6, 10)).toEqual([5n, 6n, 7n, 8n]);
    expect(storage.slice(10, 12)).toEqual(idValues(wallet));
    expect(storage.slice(24)).toEqual(ROOTS.forfeit);
  });

  it("encodes and decodes shot results as is_hit * 2 + game_over", () => {
    expect(encodeResult(false, false)).toBe(0n);
    expect(encodeResult(true, false)).toBe(2n);
    expect(encodeResult(true, true)).toBe(3n);
    for (const v of [0n, 1n, 2n, 3n]) {
      const { isHit, isGameOver } = decodeResult(v);
      expect(encodeResult(isHit, isGameOver)).toBe(v);
    }
  });

  it("builds fire args [row, col, deadline, 0] and shot note args [deadline x4]", () => {
    expect(fireArgs(3, 4, 1000)).toEqual([3n, 4n, 1000n, 0n]);
    expect(shotNoteArgs(77)).toEqual([77n, 77n, 77n, 77n]);
  });

  it("derives own serial numbers from the account id, turn and kind", () => {
    expect(ownSerial(me, 5, SERIAL_KIND_SHOT)).toEqual([...idValues(me), 5n, 1n]);
  });
});

describe("expected component notes", () => {
  it("shot note: storage [row, col, turn, deadline], serial (shooter, turn, SHOT), tagged for the defender", () => {
    const note = expectedShotNote(script("0xs"), me, opp, 2, 3, 7, 5000);
    expect(items(note)).toEqual([2n, 3n, 7n, 5000n]);
    expect(note.recipient().serialNum().toU64s()).toEqual(ownSerial(me, 7, SERIAL_KIND_SHOT));
    expect(note.metadata().sender().toString()).toBe("mtst1me");
    expect(note.metadata().tag().asU32()).toBe(buildNote(script("0xs"), [], opp, me).metadata().tag().asU32());
  });

  it("result note: storage [shooter, turn, encoded, deadline], serial (defender, turn, RESULT)", () => {
    const note = expectedResultNote(script("0xr"), me, opp, 8, true, false, 6000);
    expect(items(note)).toEqual([...idValues(opp), 8n, 2n, 6000n]);
    expect(note.recipient().serialNum().toU64s()).toEqual(ownSerial(me, 8, SERIAL_KIND_RESULT));
  });

  it("defeat note: storage [wallet], serial (loser, 0, DEFEAT), tagged for the winner's wallet", () => {
    const note = expectedDefeatNote(script("0xd"), me, wallet);
    expect(items(note)).toEqual(idValues(wallet));
    expect(note.recipient().serialNum().toU64s()).toEqual(ownSerial(me, 0, SERIAL_KIND_DEFEAT));
  });

  it("stake note: nine storage items, the fee asset and a tag for the opponent's wallet", () => {
    const parties = { myWallet: wallet, myGame: me, oppWallet: AccountId.fromBech32("mtst1oppwallet"), oppGame: opp };
    const feeFaucet = AccountId.fromBech32("mtst1fee");
    const note = buildStakeNote(script("0xk"), parties, 99, feeFaucet, 2000n);
    expect(items(note)).toEqual(stakeStorage(parties, 99));
    expect(items(note)).toHaveLength(9);
    expect(note.assets().fungibleAssets()[0].amount()).toBe(2000n);
    expect(note.metadata().sender().toString()).toBe("mtst1wallet");
  });
});
