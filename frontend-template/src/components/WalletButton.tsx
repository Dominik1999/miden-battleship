import { useCallback, useState } from "react";
import {
  useMidenFiWallet,
  WalletReadyState,
} from "@miden-sdk/miden-wallet-adapter";
import "./WalletButton.css";

export function WalletButton() {
  const { connected, connecting, address, connect, disconnect, wallets } =
    useMidenFiWallet();
  const [showMenu, setShowMenu] = useState(false);

  const handleConnect = useCallback(async () => {
    try {
      await connect();
    } catch (err) {
      console.error("Wallet connection failed:", err);
    }
  }, [connect]);

  const handleDisconnect = useCallback(async () => {
    setShowMenu(false);
    try {
      await disconnect();
    } catch (err) {
      console.error("Wallet disconnect failed:", err);
    }
  }, [disconnect]);

  const handleCopy = useCallback(async () => {
    if (address) {
      await navigator.clipboard.writeText(address);
      setShowMenu(false);
    }
  }, [address]);

  if (connecting) {
    return <button className="wallet-btn connecting">Connecting...</button>;
  }

  if (!connected || !address) {
    const hasWallet = wallets.some(
      (w) =>
        w.readyState === WalletReadyState.Installed ||
        w.readyState === WalletReadyState.Loadable,
    );
    return (
      <button className="wallet-btn" onClick={handleConnect}>
        {hasWallet ? "Connect Wallet" : "Install Miden Wallet"}
      </button>
    );
  }

  const shortAddr = `${address.slice(0, 8)}...${address.slice(-4)}`;

  return (
    <div className="wallet-dropdown">
      <button
        className="wallet-btn connected"
        onClick={() => setShowMenu((v) => !v)}
      >
        {shortAddr}
      </button>
      {showMenu && (
        <ul className="wallet-menu">
          <li onClick={handleCopy}>Copy address</li>
          <li onClick={handleDisconnect}>Disconnect</li>
        </ul>
      )}
    </div>
  );
}
