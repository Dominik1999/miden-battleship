import { type ReactNode } from "react";
import { MidenProvider } from "@miden-sdk/react";
import { MIDEN_RPC_URL, MIDEN_PROVER, MIDEN_PROVER_TIMEOUT_MS } from "@/config";

/**
 * No wallet / signer provider: game accounts use NoAuth and pay their own fees from the
 * faucet, and the SDK's `MidenProvider` would never initialize behind a disconnected signer.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <MidenProvider
      config={{ rpcUrl: MIDEN_RPC_URL, prover: MIDEN_PROVER, autoSyncInterval: 0, proverTimeoutMs: MIDEN_PROVER_TIMEOUT_MS }}
      loadingComponent={<div className="loading">Loading Miden WASM...</div>}
    >
      {children}
    </MidenProvider>
  );
}
