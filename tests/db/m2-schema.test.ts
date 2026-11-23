// Milestone 2 tables, checked on the DISPOSABLE test database as the restricted hr_runtime account.
// Needs TEST_OWNER_URL and TEST_RUNTIME_URL pointing at hr_recruitment_test (see .env.test).
// Every write runs inside a transaction that is rolled back, so nothing is ever kept.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const enabled = Boolean(ownerUrl && runtimeUrl && /_test\b/.test(new URL(ownerUrl).pathname));

const USER_ID = "00000000-0000-0000-0000-00000000a001";

describe.skipIf(!enabled)("Milestone 2 tables (test database)", () => {
  let owner: Client;
  let rt: Client;
  beforeAll(async () => {
    owner = new Client({ connectionString: ownerUrl });
    rt = new Client({ connectionString: runtimeUrl });
    await owner.connect();
    await rt.connect();
  }, 30000);
  afterAll(async () => {
    await owner?.end();
    await rt?.end();
  });

  // Runs one statement as hr_runtime inside a transaction that is always rolled back.
  const attempt = async (sql: string) => {
    await rt.query("BEGIN");
    try {
      await rt.query(sql);
      return { ok: true as const, error: "" };
    } catch (e: any) {
      return { ok: false as const, error: String(e.message) };
    } finally {
      await rt.query("ROLLBACK");
    }
  };

  // Creates a throw-away user, then tries to insert one session. Always rolled back. Run as the OWNER account:
  // these are the table's own rules, and since the security_hardening migration the app account (hr_runtime)
  // cannot insert sessions at all (the database creates them after checking the password).
  const trySession = async (columns: string, values: string) => {
    await owner.query("BEGIN");
    try {
      await owner.query(
        `INSERT INTO users(id, email, name, updated_at) VALUES ('${USER_ID}', 'm2-test@example.invalid', 'M2 Test', now())`,
      );
      await owner.query("SAVEPOINT before_session");
      try {
        await owner.query(
          `INSERT INTO sessions(id, user_id, token_hash, ${columns}) VALUES (gen_random_uuid(), '${USER_ID}', 'test-token-hash', ${values})`,
        );
        const row = (await owner.query(
          `SELECT last_seen_at IS NOT NULL AS has_last_seen, revoked_at IS NULL AS not_revoked, revoked_reason IS NULL AS no_reason FROM sessions WHERE token_hash = 'test-token-hash'`,
        )).rows[0];
        return { ok: true as const, error: "", row };
      } catch (e: any) {
        return { ok: false as const, error: String(e.message), row: undefined };
      }
    } finally {
      await owner.query("ROLLBACK");
    }
  };

  const can = async (priv: string) =>
    (await rt.query("SELECT has_table_privilege(current_user, 'public.auth_login_attempts', $1) AS v", [priv])).rows[0].v as boolean;

  it("hr_runtime can SELECT, INSERT, UPDATE and DELETE on auth_login_attempts", async () => {
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(await can(p), p).toBe(true);
  });
  it("hr_runtime cannot TRUNCATE, TRIGGER or REFERENCE auth_login_attempts", async () => {
    for (const p of ["TRUNCATE", "TRIGGER", "REFERENCES"]) expect(await can(p), p).toBe(false);
  });
  it("hr_runtime can really add, read, change and delete login attempts (rolled back)", async () => {
    await rt.query("BEGIN");
    try {
      await rt.query(`INSERT INTO auth_login_attempts(id, identifier_hash, succeeded) VALUES (gen_random_uuid(), 'hash-1', false)`);
      await rt.query(`INSERT INTO auth_login_attempts(id, identifier_hash, ip_address, succeeded, created_at) VALUES (gen_random_uuid(), 'hash-2', '203.0.113.7', false, now() - interval '20 days')`);
      const seen = (await rt.query(`SELECT count(*)::int AS n FROM auth_login_attempts WHERE identifier_hash IN ('hash-1','hash-2')`)).rows[0].n;
      expect(seen).toBe(2);
      await rt.query(`UPDATE auth_login_attempts SET succeeded = true WHERE identifier_hash = 'hash-1'`);
      // the cleanup the app will run: remove attempts older than 14 days
      // (limited to this test's own rows: other test files run in parallel against the same table)
      const removed = (await rt.query(`DELETE FROM auth_login_attempts WHERE created_at < now() - interval '14 days' AND identifier_hash IN ('hash-1','hash-2')`)).rowCount;
      expect(removed).toBe(1);
      await rt.query(`DELETE FROM auth_login_attempts`);
    } finally {
      await rt.query("ROLLBACK");
    }
  });
  it("hr_runtime cannot change the structure of auth_login_attempts or sessions", async () => {
    for (const sql of [
      "ALTER TABLE auth_login_attempts ADD COLUMN hacked int",
      "ALTER TABLE auth_login_attempts DROP COLUMN ip_address",
      "ALTER TABLE auth_login_attempts OWNER TO hr_runtime",
      "ALTER TABLE auth_login_attempts DISABLE TRIGGER ALL",
      "CREATE INDEX evil_idx ON auth_login_attempts(created_at)",
      "DROP INDEX auth_login_attempts_created_at_idx",
      "DROP TABLE auth_login_attempts",
      "TRUNCATE auth_login_attempts",
      "ALTER TABLE sessions ADD COLUMN hacked int",
      "ALTER TABLE sessions DROP COLUMN absolute_expires_at",
      "ALTER TABLE sessions DROP CONSTRAINT sessions_idle_not_after_absolute",
      "DROP INDEX sessions_user_id_revoked_at_idx",
    ]) {
      const r = await attempt(sql);
      expect(r.ok, sql).toBe(false);
      expect(r.error, sql).toMatch(/must be owner|permission denied/i);
    }
  });
  it("the login-attempt table, the new session columns, the rule and all four new indexes exist", async () => {
    const idx = (await owner.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1)`,
      [[
        "auth_login_attempts_pkey",
        "auth_login_attempts_identifier_hash_created_at_idx",
        "auth_login_attempts_ip_address_created_at_idx",
        "auth_login_attempts_created_at_idx",
        "sessions_user_id_revoked_at_idx",
      ]],
    )).rows.length;
    expect(idx).toBe(5);
    const cols = (await owner.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='sessions' AND column_name IN ('absolute_expires_at','last_seen_at','revoked_at','revoked_reason')`,
    )).rows.length;
    expect(cols).toBe(4);
    const rule = (await owner.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'sessions_idle_not_after_absolute'`)).rows[0].n;
    expect(rule).toBe(1);
  });
  it("a session without absolute_expires_at is refused", async () => {
    const r = await trySession("expires_at", "now() + interval '60 minutes'");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/absolute_expires_at/);
  });
  it("a session without expires_at is refused", async () => {
    const r = await trySession("absolute_expires_at", "now() + interval '12 hours'");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expires_at/);
  });
  it("a session whose idle deadline is later than its hard deadline is refused", async () => {
    const r = await trySession("expires_at, absolute_expires_at", "now() + interval '13 hours', now() + interval '12 hours'");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sessions_idle_not_after_absolute/);
  });
  it("a valid session (60 min idle, 12 h hard) is accepted, with last_seen_at set and not revoked", async () => {
    const r = await trySession("expires_at, absolute_expires_at", "now() + interval '60 minutes', now() + interval '12 hours'");
    expect(r.error).toBe("");
    expect(r.ok).toBe(true);
    expect(r.row).toEqual({ has_last_seen: true, not_revoked: true, no_reason: true });
  });
});
