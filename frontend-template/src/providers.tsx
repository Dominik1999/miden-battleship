import { type ReactNode } from "react";
import { MidenProvider } from "@miden-sdk/react";
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter";
import "@miden-sdk/miden-wallet-adapter/styles.css";
import { APP_NAME, MIDEN_RPC_URL, MIDEN_PROVER } from "@/config";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <MidenFiSignerProvider appName={APP_NAME} autoConnect>
      <MidenProvider
        config={{ rpcUrl: MIDEN_RPC_URL, prover: MIDEN_PROVER }}
        loadingComponent={
          <div className="loading">Loading Miden WASM...</div>
        }
      >
        {children}
      </MidenProvider>
    </MidenFiSignerProvider>
  );
}
