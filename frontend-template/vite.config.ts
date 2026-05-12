import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { midenVitePlugin } from "@miden-sdk/vite-plugin";

/**
 * Vite plugin to suppress the Dexie version-conflict throw inside the SDK.
 * The MidenFi wallet extension injects Dexie 4.0.8 into the page via
 * Symbol.for("Dexie"), which conflicts with the SDK's bundled Dexie 4.4.2.
 * This plugin rewrites the `throw` into a `console.warn` so the SDK still
 * initializes correctly.
 */
function dexieConflictSuppressor(): Plugin {
  return {
    name: "dexie-conflict-suppressor",
    transform(code, id) {
      if (!id.includes("@miden-sdk") && !id.includes("dexie")) return;
      const pattern = 'throw new Error(`Two different versions of Dexie loaded';
      if (!code.includes(pattern)) return;
      return code.replace(
        /throw new Error\(`Two different versions of Dexie loaded in the same app: \$\{.*?\} and \$\{.*?\}`\);/g,
        'console.warn(`[Dexie] Version mismatch suppressed (wallet extension conflict)`); globalThis[Symbol.for("Dexie")] = _Dexie;',
      );
    },
  };
}

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? "/miden-battleship/" : "/",
  plugins: [dexieConflictSuppressor(), react(), midenVitePlugin()],
  resolve: {
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
