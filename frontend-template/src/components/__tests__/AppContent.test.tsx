import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));
vi.mock("@miden-sdk/miden-wallet-adapter", () => ({
  useMidenFiWallet: () => ({
    address: "mtst1wallet",
    connected: true,
    connecting: false,
    requestTransaction: vi.fn(),
    createAccount: vi.fn(),
    wallets: [],
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
  Transaction: { createCustomTransaction: vi.fn(() => ({})) },
  WalletReadyState: { Installed: "Installed", Loadable: "Loadable" },
}));
vi.mock("@/components/WalletButton", () => ({
  WalletButton: () => <button>Connect Wallet</button>,
}));
vi.mock("@/components/ShipPlacement", () => ({
  ShipPlacement: ({ onConfirm }: { onConfirm: () => void }) => (
    <div data-testid="ship-placement" onClick={onConfirm}>
      Ship Placement Mock
    </div>
  ),
}));
vi.mock("@/components/LobbyScreen", () => ({
  LobbyScreen: ({
    onStartGame,
    onJoinGame,
  }: {
    walletConnected: boolean;
    onStartGame: () => void;
    onJoinGame: (id: string) => void;
  }) => (
    <div data-testid="lobby">
      <button onClick={onStartGame}>Start Game</button>
      <button onClick={() => onJoinGame("mtst1test")}>Join Game</button>
    </div>
  ),
}));
vi.mock("@/components/WaitingScreen", () => ({
  WaitingScreen: () => <div data-testid="waiting-screen">Waiting Mock</div>,
}));
vi.mock("@/components/GamePlay", () => ({
  GamePlay: () => <div data-testid="game-play">Game Play Mock</div>,
}));
vi.mock("@/hooks/useStartGame", () => ({
  useStartGame: () => ({
    startGame: vi.fn(),
    stage: "idle",
    error: null,
    gameAccountAddress: null,
    opponentAddress: null,
    walletConnected: true,
  }),
}));
vi.mock("@/hooks/useJoinGame", () => ({
  useJoinGame: () => ({
    joinGame: vi.fn(),
    stage: "idle",
    error: null,
    gameAccountAddress: null,
    starterAddress: null,
    walletConnected: true,
  }),
}));

import { useMiden, useSyncState } from "@miden-sdk/react";
import { AppContent } from "../AppContent";

describe("AppContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders lobby screen when Miden is ready", () => {
    render(<AppContent />);

    expect(screen.getByText("Miden Battleship")).toBeInTheDocument();
    expect(screen.getByText("Connect Wallet")).toBeInTheDocument();
    expect(screen.getByTestId("lobby")).toBeInTheDocument();
  });

  it("shows sync height", () => {
    render(<AppContent />);
    expect(screen.getByText(/Block: 12345/)).toBeInTheDocument();
  });

  it("shows syncing indicator when syncHeight is null", () => {
    vi.mocked(useSyncState).mockReturnValue({
      syncHeight: null as unknown as number,
      isSyncing: true,
      lastSyncTime: null,
      error: null,
      sync: vi.fn(),
    });

    render(<AppContent />);
    expect(screen.getByText(/syncing\.\.\./)).toBeInTheDocument();
  });

  it("shows loading message and wallet button during initialization", () => {
    vi.mocked(useMiden).mockReturnValue({
      client: null,
      isReady: false,
      isInitializing: true,
      error: null,
      sync: vi.fn(),
      runExclusive: vi.fn(),
      prover: null,
      signerAccountId: null,
      signerConnected: false,
    });

    render(<AppContent />);
    expect(
      screen.getByText(/Initializing Miden client/),
    ).toBeInTheDocument();
    expect(screen.getByText("Connect Wallet")).toBeInTheDocument();
    expect(screen.getByText("Miden Battleship")).toBeInTheDocument();
  });

  it("shows error message on initialization failure", () => {
    vi.mocked(useMiden).mockReturnValue({
      client: null,
      isReady: false,
      isInitializing: false,
      error: new Error("WASM failed to load"),
      sync: vi.fn(),
      runExclusive: vi.fn(),
      prover: null,
      signerAccountId: null,
      signerConnected: false,
    });

    render(<AppContent />);
    expect(
      screen.getByText("Failed to initialize Miden client"),
    ).toBeInTheDocument();
    expect(screen.getByText("WASM failed to load")).toBeInTheDocument();
  });
});
