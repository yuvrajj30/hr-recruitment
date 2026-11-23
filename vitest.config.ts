import { config } from "dotenv";
import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Reads .env.test (kept out of git) so the database tests know the DISPOSABLE test database.
// It never reads .env, so tests cannot be pointed at the real database by accident.
config({ path: ".env.test" });

// Test files that deliberately max out the CPU with bcrypt (cost 12): sign-ins fired many at once, password
// changes and invitation acceptance (inside PostgreSQL), and the password module itself (in Node). While they
// run, every core is busy for seconds, and any other test running at the same moment stalls: a query that takes
// milliseconds then shows up as 5-30 s, failing Prisma's 5-second transaction limit or the test's own time limit
// at random (investigated 17-18 Nov 2026, when "searches, filters and sorts the applications list" failed about
// one run in three). So these run first, as a group of their own, and everything else runs after them.
const CPU_HEAVY = [
  "tests/db/auth-login.test.ts",
  "tests/db/self-service.test.ts",
  "tests/db/invitation-acceptance.test.ts",
  "tests/db/security-hardening.test.ts",
  "tests/security/password.test.ts",
];

export default defineConfig({
  resolve: {
    alias: [
      // "server-only" is a build-time guard for Next.js; in tests it is replaced by an empty module.
      { find: "server-only", replacement: fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)) },
      // Same "@/..." shortcut the app uses (see tsconfig.json), so app code can be imported in tests.
      { find: /^@\//, replacement: fileURLToPath(new URL("./src/", import.meta.url)) },
    ],
  },
  test: {
    environment: "node",
    testTimeout: 30000,
    // How many test files run at once. Each database test file opens about 6 connections for the app's account
    // (hr_runtime), which may hold at most 20 in total across the server (a role setting shared with production),
    // and this machine has little free memory; three at a time stays well inside both.
    maxWorkers: 3,
    // Before anything runs: is the test database reachable, and really a *_test database? (tests/global-setup.ts)
    globalSetup: ["./tests/global-setup.ts"],
    projects: [
      { extends: true, test: { name: "cpu-heavy", include: CPU_HEAVY, sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: "main", include: ["tests/**/*.test.ts"], exclude: [...configDefaults.exclude, ...CPU_HEAVY], sequence: { groupOrder: 1 } } },
    ],
  },
});
