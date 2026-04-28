import { AppProviders } from "@/providers";
import { AppContent } from "@/components/AppContent";
import { ConsumeRepro } from "@/repro/ConsumeRepro";

export default function App() {
  const isRepro = window.location.pathname.includes("repro") ||
    new URLSearchParams(window.location.search).has("repro");

  return (
    <AppProviders>
      {isRepro ? <ConsumeRepro /> : <AppContent />}
    </AppProviders>
  );
}
