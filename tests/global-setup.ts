// Runs once before the whole test suite.
//
// When the disposable test database is configured (.env.test), every database test needs it. If the
// database cannot be reached (server stopped, or the process running the tests is not allowed to open
// network connections: a sandbox or firewall shows up as EACCES, a stopped server as ECONNREFUSED), the
// database tests would otherwise fail or be skipped one file at a time, with errors that look like
// permission problems. This check stops the run straight away with one clear explanation instead.
//
// It also refuses to run unless both connections point at a database whose name ends in "_test", and it
// confirms that the app's restricted account is still restricted. It only reads; it changes nothing.
import { Client } from "pg";

const NETWORK_CODES: Record<string, string> = {
  EACCES: "the operating system refused the connection (a sandbox, firewall or security tool around the process running the tests)",
  EPERM: "the operating system refused the connection (a sandbox, firewall or security tool around the process running the tests)",
  ECONNREFUSED: "nothing is listening there (is PostgreSQL running?)",
  ETIMEDOUT: "the connection timed out",
  ENOTFOUND: "the host name could not be resolved",
};

async function check(label: string, url: string): Promise<void> {
  const { hostname, port, pathname } = new URL(url);
  const where = `${hostname}:${port || 5432}${pathname}`;
  if (!/_test$/.test(pathname)) throw new Error(`${label} must point at a disposable *_test database, not ${pathname}. Check .env.test.`);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000, application_name: "vitest-preflight", options: "-c default_transaction_read_only=on" });
  try {
    await client.connect();
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    const why = NETWORK_CODES[code] ?? (error as Error).message;
    throw new Error(
      `The test database cannot be reached as ${label} (${where}): ${code ? `${code}, ` : ""}${why}.\n` +
        `The database tests need it. Start PostgreSQL, or run the tests from a process that may connect to it. ` +
        `This is not a database permission problem: those are reported by PostgreSQL as error 42501.`,
    );
  }
  try {
    const { rows } = await client.query<{ db: string; super: boolean; bypass: boolean }>(
      `SELECT current_database() AS db, r.rolsuper AS super, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const r = rows[0];
    if (!r || !/_test$/.test(r.db)) throw new Error(`${label} connected to "${r?.db}", which is not a *_test database.`);
    if (label === "TEST_RUNTIME_URL" && (r.super || r.bypass)) {
      throw new Error("The app's runtime account must not be a superuser or bypass row-level security; the security tests would be meaningless.");
    }
  } finally {
    await client.end();
  }
}

export default async function setup(): Promise<void> {
  const owner = process.env.TEST_OWNER_URL;
  const runtime = process.env.TEST_RUNTIME_URL;
  // No test database configured: the database tests skip themselves, as before.
  if (!owner || !runtime) return;
  await check("TEST_OWNER_URL", owner);
  await check("TEST_RUNTIME_URL", runtime);
}
