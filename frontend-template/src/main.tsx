// Clear any Dexie instance registered by the wallet extension to prevent
// version conflict with the SDK's bundled Dexie (Symbol.for("Dexie") is
// a cross-realm global that Dexie uses to detect duplicate loading).
delete (globalThis as Record<symbol, unknown>)[Symbol.for("Dexie")];

// Dynamic import so the SDK modules load AFTER the Dexie symbol is cleared.
import("./boot.tsx");
