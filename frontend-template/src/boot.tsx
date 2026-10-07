import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// The Miden client's IndexedDB store is kept across page loads: it holds the private game
// account, the wallet and every note, so an interrupted game can be resumed (see lib/session.ts).
// "Reset Client Data" in the lobby wipes it on request.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
