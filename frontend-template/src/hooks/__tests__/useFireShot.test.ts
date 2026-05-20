import { renderHook, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));

vi.mock("@miden-sdk/miden-sdk", () => {
  class MockFelt { value: bigint; constructor(v: bigint) { this.value = v; } }
  class Stub {}
  class MockTRB { withOwnOutputNotes() { return { build: () => ({}) }; } }
  return {
    Package: { deserialize: vi.fn(() => ({})) },
    NoteScript: { fromPackage: vi.fn(() => ({})) },
    Note: Stub,
    NoteAssets: Stub,
    NoteMetadata: Stub,
    NoteRecipient: Stub,
    NoteStorage: Stub,
    NoteTag: {
      withAccountTarget: vi.fn(() => ({ asU32: vi.fn(() => 42) })),
    },
    NoteType: { Public: 0 },
    NoteArray: Stub,
    TransactionRequestBuilder: MockTRB,
    AccountId: {
      fromBech32: vi.fn(() => ({
        prefix: vi.fn(() => new MockFelt(0n)),
        suffix: vi.fn(() => new MockFelt(0n)),
      })),
    },
    Felt: MockFelt,
    FeltArray: class { push() {} },
  };
});

vi.mock("@/lib/miden", () => ({
  randomWord: vi.fn(() => ({
    toFelts: vi.fn(() => [
      { value: 0n },
      { value: 0n },
      { value: 0n },
      { value: 0n },
    ]),
  })),
}));

// Mock fetch
globalThis.fetch = vi.fn(() =>
  Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }),
) as unknown as typeof fetch;

import { useFireShot } from "../useFireShot";

describe("useFireShot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns initial state", () => {
    const refetch = vi.fn();
    const { result } = renderHook(() =>
      useFireShot("mtst1myaccount", "mtst1defender", refetch),
    );

    expect(result.current.isSubmitting).toBe(false);
    expect(result.current.isWaiting).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.walletConnected).toBe(true);
    expect(typeof result.current.fireShot).toBe("function");
  });

  it("reports not connected when no game account", () => {
    const refetch = vi.fn();
    const { result } = renderHook(() =>
      useFireShot("", "mtst1defender", refetch),
    );

    expect(result.current.walletConnected).toBe(false);
  });

  it("completes fireShot without error", async () => {
    const refetch = vi.fn();
    const { result } = renderHook(() =>
      useFireShot("mtst1myaccount", "mtst1defender", refetch),
    );

    await act(async () => {
      const promise = result.current.fireShot(2, 7, 3);
      await vi.advanceTimersByTimeAsync(10_000);
      await promise;
    });

    expect(result.current.error).toBeNull();
  });

  it("does not fire when game account is empty", async () => {
    const refetch = vi.fn();
    const { result } = renderHook(() =>
      useFireShot("", "mtst1defender", refetch),
    );

    await act(async () => {
      await result.current.fireShot(0, 0, 1);
    });

    // Should return early without submitting
    expect(result.current.isSubmitting).toBe(false);
  });
});
