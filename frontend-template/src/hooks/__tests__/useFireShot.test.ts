import { renderHook, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));

const mockRequestTransaction = vi.fn(async () => ({}));
const mockUseMidenFiWallet = vi.fn(() => ({
  address: "mtst1wallet",
  connected: true,
  requestTransaction: mockRequestTransaction,
}));

vi.mock("@miden-sdk/miden-wallet-adapter", () => ({
  useMidenFiWallet: () => mockUseMidenFiWallet(),
  Transaction: {
    createCustomTransaction: vi.fn(() => ({})),
  },
}));

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
    NoteAttachment: {
      newNetworkAccountTarget: vi.fn(() => ({})),
    },
    NoteExecutionHint: { always: vi.fn(() => ({})) },
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
import { NoteAttachment } from "@miden-sdk/miden-sdk";

describe("useFireShot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockUseMidenFiWallet.mockReturnValue({
      address: "mtst1wallet",
      connected: true,
      requestTransaction: mockRequestTransaction,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns initial state", () => {
    const refetch = vi.fn();
    const { result } = renderHook(() =>
      useFireShot("mtst1defender", refetch),
    );

    expect(result.current.isSubmitting).toBe(false);
    expect(result.current.isWaiting).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.walletConnected).toBe(true);
    expect(typeof result.current.fireShot).toBe("function");
  });

  it("reports wallet not connected", () => {
    mockUseMidenFiWallet.mockReturnValue({
      address: null as unknown as string,
      connected: false,
      requestTransaction: vi.fn(),
    });

    const refetch = vi.fn();
    const { result } = renderHook(() =>
      useFireShot("mtst1defender", refetch),
    );

    expect(result.current.walletConnected).toBe(false);
  });

  it("does NOT use NoteAttachment.newNetworkAccountTarget (game accounts are regular, not network)", async () => {
    const refetch = vi.fn();
    const { result } = renderHook(() =>
      useFireShot("mtst1defender", refetch),
    );

    await act(async () => {
      const promise = result.current.fireShot(3, 5, 1);
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;
    });

    // Game accounts are RegularAccountImmutableCode, not network accounts.
    // Using NoteAttachment.newNetworkAccountTarget would throw at runtime.
    expect(NoteAttachment.newNetworkAccountTarget).not.toHaveBeenCalled();
  });

  it("completes fireShot without error", async () => {
    const refetch = vi.fn();
    const { result } = renderHook(() =>
      useFireShot("mtst1defender", refetch),
    );

    await act(async () => {
      const promise = result.current.fireShot(2, 7, 3);
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;
    });

    expect(result.current.error).toBeNull();
  });

  it("does not fire when wallet is not connected", async () => {
    mockUseMidenFiWallet.mockReturnValue({
      address: null as unknown as string,
      connected: false,
      requestTransaction: null as unknown as typeof mockRequestTransaction,
    });

    const refetch = vi.fn();
    const { result } = renderHook(() =>
      useFireShot("mtst1defender", refetch),
    );

    await act(async () => {
      await result.current.fireShot(0, 0, 1);
    });

    expect(mockRequestTransaction).not.toHaveBeenCalled();
  });
});
