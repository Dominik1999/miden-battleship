import { type ReactNode } from "react";
import { MidenProvider } from "@miden-sdk/react";
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter";
import "@miden-sdk/miden-wallet-adapter/styles.css";
import { AppProviders } from "@/providers";
import { AppContent } from "@/components/AppContent";
import { ConsumeRepro } from "@/repro/ConsumeRepro";
import { APP_NAME, MIDEN_RPC_URL, MIDEN_PROVER, MIDEN_NOTE_TRANSPORT_URL } from "@/config";

const isRepro = window.location.pathname.includes("repro") ||
  new URLSearchParams(window.location.search).has("repro");

function ReproProviders({ children }: { children: ReactNode }) {
  return (
    <MidenFiSignerProvider appName={APP_NAME} autoConnect>
      <MidenProvider
        config={{ rpcUrl: MIDEN_RPC_URL, prover: MIDEN_PROVER, noteTransportUrl: MIDEN_NOTE_TRANSPORT_URL, autoSyncInterval: 0 }}
        loadingComponent={
          <div style={{ padding: 40, fontFamily: "monospace", background: "#1a1a2e", color: "#eee", minHeight: "100vh", position: "fixed", inset: 0, zIndex: 9999 }}>
            <h2>Consume Repro</h2>
            <p>Loading Miden WASM... (connect wallet if not connected)</p>
          </div>
        }
      >
        {children}
      </MidenProvider>
    </MidenFiSignerProvider>
  );
}

export default function App() {
  if (isRepro) {
    return (
      <ReproProviders>
        <ConsumeRepro />
      </ReproProviders>
    );
  }

  return (
    <AppProviders>
      <AppContent />
    </AppProviders>
  );
}
