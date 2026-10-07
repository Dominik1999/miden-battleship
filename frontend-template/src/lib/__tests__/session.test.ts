import { describe, it, expect } from "vitest";
import { clearSession, loadSession, saveSession, stringsToValues, valuesToStrings, type GameSession, type SessionStore } from "@/lib/session";

function memoryStore(): SessionStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const session: GameSession = {
  version: 1,
  role: "challenger",
  myAddress: "mtst1me",
  mySeed: ["1", "2", "3", "4"],
  myWallet: "mtst1wallet",
  opponentAddress: "mtst1opp",
  gameId: ["9", "8", "7", "6"],
  cells: [{ row: 0, col: 0, shipId: 1 }],
  stakeAmount: "2000",
  shots: [{ turn: 1, row: 0, col: 0, status: "hit" }],
  pendingDeadline: 123456,
  myStakeNoteId: "0xstake",
  claimed: false,
  createdAt: 1,
};

describe("session persistence", () => {
  it("round-trips a session through the store", () => {
    const store = memoryStore();
    expect(loadSession(store)).toBeNull();
    saveSession(session, store);
    expect(loadSession(store)).toEqual(session);
    clearSession(store);
    expect(loadSession(store)).toBeNull();
  });

  it("ignores corrupt or foreign records", () => {
    const store = memoryStore();
    store.setItem("miden-battleship.session.v1", "{not json");
    expect(loadSession(store)).toBeNull();
    store.setItem("miden-battleship.session.v1", JSON.stringify({ version: 2, myAddress: "x" }));
    expect(loadSession(store)).toBeNull();
  });

  it("survives a store that throws", () => {
    const broken: SessionStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => saveSession(session, broken)).not.toThrow();
    expect(loadSession(broken)).toBeNull();
    expect(() => clearSession(broken)).not.toThrow();
  });

  it("converts felt values to strings and back", () => {
    expect(stringsToValues(valuesToStrings([1n, 18446744069414584320n]))).toEqual([1n, 18446744069414584320n]);
  });
});
