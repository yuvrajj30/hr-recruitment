import { config } from "dotenv";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Reads .env.test (kept out of git) so the database tests know the DISPOSABLE test database.
// It never reads .env, so tests cannot be pointed at the real database by accident.
config({ path: ".env.test" });

export default defineConfig({
  resolve: {
    alias: [
      // "server-only" is a build-time guard for Next.js; in tests it is replaced by an empty module.
      { find: "server-only", replacement: fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)) },
      // Same "@/..." shortcut the app uses (see tsconfig.json), so app code can be imported in tests.
      { find: /^@\//, replacement: fileURLToPath(new URL("./src/", import.meta.url)) },
    ],
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 30000 },
});
