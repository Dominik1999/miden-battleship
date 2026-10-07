import { describe, it, expect, vi } from "vitest";

vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));

import { Felt, AccountId, TransactionRequestBuilder } from "@miden-sdk/miden-sdk";
import { NoteScript as MockNoteScript } from "@/__tests__/mocks/miden-sdk";
const script = (root: string) => new MockNoteScript(root) as never;
import {
  buildHandshakeStorage,
  buildNote,
  buildResultRecipient,
  buildSetupPayload,
  buildSetupRequest,
  buildShotStorage,
  decodeResult,
  encodeResult,
} from "@/lib/notes";

const felts = (...v: number[]) => v.map((x) => new Felt(BigInt(x)));

describe("note storage builders", () => {
  it("builds the 20-felt setup payload: game id, opponent, commitment, rows", () => {
    const payload = buildSetupPayload([1n, 2n, 3n, 4n], new Felt(10n), new Felt(11n), [5n, 6n, 7n, 8n], [
      { row: 0, col: 0, shipId: 1 },
    ]);
    expect(payload).toHaveLength(20);
    expect(payload.slice(0, 4).map((f) => f.asInt())).toEqual([1n, 2n, 3n, 4n]);
    expect(payload[4].asInt()).toBe(10n);
    expect(payload[5].asInt()).toBe(11n);
    expect(payload.slice(6, 10).map((f) => f.asInt())).toEqual([5n, 6n, 7n, 8n]);
    expect(payload[10].asInt()).toBe(1n);
    expect(payload.slice(11).every((f) => f.asInt() === 0n)).toBe(true);
  });

  it("builds the setup request with the payload under the key and the key as script arg", () => {
    const builder = new TransactionRequestBuilder();
    const request = buildSetupRequest(builder, {} as never, felts(1, 2), [9n, 9n, 9n, 9n]) as unknown as { calls: { method: string }[] };
    expect(request.calls.map((c) => c.method)).toEqual(["withCustomScript", "withScriptArg", "extendAdviceMap"]);
  });

  it("builds 10-felt handshake storage and 11-felt shot storage", () => {
    expect(buildHandshakeStorage([1n, 2n, 3n, 4n], new Felt(5n), new Felt(6n), [7n, 8n, 9n, 10n]).length()).toBe(10);
    const shot = buildShotStorage(3, 4, 7, [1n, 1n, 1n, 1n], [2n, 2n, 2n, 2n]);
    expect(shot.length()).toBe(11);
    expect(shot.get(0).asInt()).toBe(3n);
    expect(shot.get(1).asInt()).toBe(4n);
    expect(shot.get(2).asInt()).toBe(7n);
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

  it("builds the result recipient with [shooter_prefix, shooter_suffix, turn, encoded]", () => {
    const recipient = buildResultRecipient([7n, 7n, 7n, 7n], script("0xr"), new Felt(1n), new Felt(2n), 3, 2n);
    expect(recipient.storage().items().map((f) => f.asInt())).toEqual([1n, 2n, 3n, 2n]);
  });

  it("builds a public note tagged for the target and sent by the sender", () => {
    const { note, tag } = buildNote(script("0xc"), buildHandshakeStorage([1n, 2n, 3n, 4n], new Felt(1n), new Felt(1n), [1n, 1n, 1n, 1n]), AccountId.fromBech32("mtst1target"), AccountId.fromBech32("mtst1sender"));
    expect(note.metadata().sender().toString()).toBe("mtst1sender");
    expect(note.metadata().tag().asU32()).toBe(tag);
  });
});
