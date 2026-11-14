import { config } from "dotenv";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Reads .env.test (kept out of git) so the database tests know the DISPOSABLE test database.
// It never reads .env, so tests cannot be pointed at the real database by accident.
config({ path: ".env.test" });

export default defineConfig({
  resolve: {
    alias: {
      // "server-only" is a build-time guard for Next.js; in tests it is replaced by an empty module.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 30000 },
});
