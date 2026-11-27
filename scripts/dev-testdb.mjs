// Starts the app on http://localhost:3001 against the DISPOSABLE test database only.
//
//   npm run dev:testdb            start the test site
//   npm run dev:testdb -- --check only run the safety checks and print what would be used
//
// Safety rules (the script stops before starting anything if one fails):
//   1. The database comes from .env.test (TEST_RUNTIME_URL), never from .env.
//   2. That database must be exactly "hr_recruitment_test" on this computer (localhost),
//      reached as the restricted "hr_runtime" account.
//   3. The owner/migration connection is also replaced by the TEST one, so the real database's
//      connection string from .env is never in this process.
//   4. Uploaded files go to storage/test-private, never the real store (storage/private).
// Variables set here win over .env, because Next.js never overrides variables that already exist.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => {
  console.error(`dev:testdb refused to start: ${message}`);
  process.exit(1);
};

function readEnvFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    fail(".env.test is missing (it must hold TEST_OWNER_URL and TEST_RUNTIME_URL).");
  }
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]),
  );
}

// Checks one connection string; never prints the password.
function checkTestUrl(name, value, expectedUser) {
  if (!value) fail(`${name} is not set in .env.test.`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} is not a valid connection string.`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) fail(`${name} is not a PostgreSQL connection.`);
  if (decodeURIComponent(url.pathname) !== "/hr_recruitment_test") fail(`${name} does not point at the database "hr_recruitment_test".`);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) fail(`${name} does not point at this computer (localhost).`);
  if (decodeURIComponent(url.username) !== expectedUser) fail(`${name} must use the "${expectedUser}" account.`);
  return `${url.protocol}//${url.username}:***@${url.host}${url.pathname}`;
}

const testEnv = readEnvFile(path.join(project, ".env.test"));
const runtimeShown = checkTestUrl("TEST_RUNTIME_URL", testEnv.TEST_RUNTIME_URL, "hr_runtime");
const ownerShown = checkTestUrl("TEST_OWNER_URL", testEnv.TEST_OWNER_URL, "hr_app");

const realStore = path.join(project, "storage", "private");
const testStore = path.join(project, "storage", "test-private");
if (path.resolve(testStore) === path.resolve(realStore)) fail("the test upload folder would be the real one.");
mkdirSync(testStore, { recursive: true });

const env = {
  ...process.env,
  DATABASE_URL: testEnv.TEST_RUNTIME_URL,
  MIGRATION_DATABASE_URL: testEnv.TEST_OWNER_URL,
  FILE_STORAGE_DIR: testStore,
  APP_ORIGIN: "http://localhost:3001",
  DB_SESSION_TIME_ZONE: "UTC",
};
// The web app must never hold the maintenance account's connection (it refuses to start with it).
delete env.MAINTENANCE_DATABASE_URL;

console.log("dev:testdb safety checks passed:");
console.log(`  app database      ${runtimeShown}`);
console.log(`  owner connection  ${ownerShown} (replaces the one in .env)`);
console.log(`  test uploads      ${path.relative(project, testStore)}`);
console.log("  address           http://localhost:3001");
if (process.argv.includes("--check")) process.exit(0);

const child = spawn("npx", ["next", "dev", "-p", "3001"], { cwd: project, stdio: "inherit", shell: true, env });
child.on("exit", (code) => process.exit(code ?? 0));
