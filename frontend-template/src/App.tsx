import { AppProviders } from "@/providers";
import { AppContent } from "@/components/AppContent";
import { ConsumeRepro } from "@/repro/ConsumeRepro";

const isRepro = new URLSearchParams(window.location.search).has("repro");

export default function App() {
  return (
    <AppProviders>
      {isRepro ? <ConsumeRepro /> : <AppContent />}
    </AppProviders>
  );
}
