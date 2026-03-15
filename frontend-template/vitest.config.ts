import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: true,
    server: {
      deps: {
        // The wallet-adapter-reactui sub-package has incorrect exports in package.json.
        // Tests mock the wallet adapter at the module level, so externalizing is safe.
        external: [/@miden-sdk\/miden-wallet-adapter/],
      },
    },
  },
});
