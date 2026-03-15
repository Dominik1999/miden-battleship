import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

// AudioContext stub for music auto-start
function MockAudioContext() {
  const mockNode = { gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn().mockReturnThis(), disconnect: vi.fn(), type: "", frequency: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, Q: { value: 0 }, start: vi.fn(), stop: vi.fn(), buffer: null };
  return {
    currentTime: 0,
    destination: {},
    sampleRate: 44100,
    createOscillator: vi.fn(() => ({ ...mockNode })),
    createGain: vi.fn(() => ({ ...mockNode })),
    createBiquadFilter: vi.fn(() => ({ ...mockNode })),
    createBuffer: vi.fn(() => ({ getChannelData: () => new Float32Array(100) })),
    createBufferSource: vi.fn(() => ({ ...mockNode })),
  };
}
vi.stubGlobal("AudioContext", MockAudioContext);

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));

const mockUseMidenFiWallet = vi.fn(() => ({
  address: "mtst1wallet",
  connected: true,
  requestTransaction: vi.fn(),
}));

vi.mock("@miden-sdk/miden-wallet-adapter", () => ({
  useMidenFiWallet: () => mockUseMidenFiWallet(),
  Transaction: { createCustomTransaction: vi.fn() },
}));
vi.mock("@miden-sdk/miden-sdk", () => {
  function MockFelt(this: { value: bigint }, v: bigint) { this.value = v; }
  return {
  Felt: MockFelt,
  Word: {
    newFromFelts: vi.fn(() => ({
      toU64s: () => [0n, 0n, 0n, 0n],
      toFelts: vi.fn(() => [{ value: 0n }, { value: 0n }, { value: 0n }, { value: 0n }]),
    })),
  },
  FeltArray: vi.fn(() => ({ push: vi.fn() })),
  Package: { deserialize: vi.fn(() => ({})) },
  NoteScript: { fromPackage: vi.fn(() => ({})) },
  Note: vi.fn(() => ({})),
  NoteAssets: vi.fn(() => ({})),
  NoteMetadata: vi.fn(() => ({ withAttachment: vi.fn(() => ({})) })),
  NoteRecipient: vi.fn(() => ({})),
  NoteInputs: vi.fn(() => ({})),
  NoteTag: { withAccountTarget: vi.fn(() => ({ asU32: vi.fn(() => 0) })) },
  NoteType: { Public: 0 },
  NoteAttachment: { newNetworkAccountTarget: vi.fn(() => ({})) },
  NoteExecutionHint: { always: vi.fn(() => ({})) },
  OutputNote: { full: vi.fn(() => ({})) },
  OutputNoteArray: vi.fn(() => ({})),
  TransactionRequestBuilder: vi.fn(() => ({
    withOwnOutputNotes: vi.fn(() => ({ build: vi.fn(() => ({})) })),
  })),
  AccountId: {
    fromBech32: vi.fn(() => ({
      prefix: vi.fn(() => ({ value: 0n })),
      suffix: vi.fn(() => ({ value: 0n })),
    })),
  },
};
});
vi.mock("@/lib/miden", () => ({
  randomWord: vi.fn(() => ({ toFelts: vi.fn(() => [{ value: 0n }, { value: 0n }, { value: 0n }, { value: 0n }]) })),
}));

import { useAccount } from "@miden-sdk/react";
import { createMockGameAccount } from "@/__tests__/fixtures/battleship";
import { GamePlay } from "../GamePlay";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAccount = any;

describe("GamePlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up both game accounts
    const accountA = createMockGameAccount({
      id: "mtst1a",
      phase: 2,
      expectedTurn: 2,
      shipsHitCount: 0,
      totalShotsReceived: 0,
    });
    const accountB = createMockGameAccount({
      id: "mtst1b",
      phase: 2,
      expectedTurn: 1,
      shipsHitCount: 0,
      totalShotsReceived: 0,
    });

    let callCount = 0;
    vi.mocked(useAccount).mockImplementation(() => {
      callCount++;
      const account = callCount % 2 === 1 ? accountA : accountB;
      return {
        account: account as AnyAccount,
        assets: [],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        getBalance: vi.fn(() => 0n),
      };
    });
  });

  it("renders two game boards", () => {
    render(
      <GamePlay accountA="mtst1a" accountB="mtst1b" playerRole="challenger" />,
    );
    expect(screen.getByText("Your Fleet")).toBeInTheDocument();
    expect(screen.getByText("Enemy Waters")).toBeInTheDocument();
  });

  it("shows loading state when boards not ready", () => {
    vi.mocked(useAccount).mockReturnValue({
      account: null,
      assets: [],
      isLoading: true,
      error: null,
      refetch: vi.fn(),
      getBalance: vi.fn(() => 0n),
    });

    render(
      <GamePlay accountA="mtst1a" accountB="mtst1b" playerRole="challenger" />,
    );
    expect(screen.getByText("Loading boards...")).toBeInTheDocument();
  });

  it("shows wallet connection warning when disconnected", () => {
    mockUseMidenFiWallet.mockReturnValue({
      address: null as unknown as string,
      connected: false,
      requestTransaction: vi.fn(),
    });

    render(
      <GamePlay accountA="mtst1a" accountB="mtst1b" playerRole="challenger" />,
    );
    expect(
      screen.getByText("Connect your wallet to fire shots"),
    ).toBeInTheDocument();
  });
});
