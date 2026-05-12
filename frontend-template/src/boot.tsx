import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { clearMidenStorage } from "@miden-sdk/react";
import "./index.css";
import App from "./App.tsx";

// Nuke all Miden IndexedDB state on every page load so each session starts fresh.
clearMidenStorage().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
