// Tries the forbidden actions for real, against a DISPOSABLE test database.
// Needs TEST_OWNER_URL (hr_app) and TEST_RUNTIME_URL (hr_runtime) pointing at hr_recruitment_test.
// Every attempt runs inside a transaction that is rolled back, so nothing is ever kept.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const enabled = Boolean(ownerUrl && runtimeUrl && /_test\b/.test(new URL(ownerUrl).pathname));

describe.skipIf(!enabled)("hr_runtime restrictions (test database)", () => {
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

  it("cannot TRUNCATE tables", async () => {
    for (const t of ["users", "audit_logs", "sessions"]) {
      const r = await attempt(`TRUNCATE "${t}" CASCADE`);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/permission denied/i);
    }
  });
  it("cannot change table structure, ownership or add triggers", async () => {
    for (const sql of [
      'ALTER TABLE "users" ADD COLUMN hacked int',
      'ALTER TABLE "users" OWNER TO hr_runtime',
      'DROP TABLE "users" CASCADE',
      'DROP TRIGGER audit_logs_append_only ON "audit_logs"',
      'CREATE TABLE evil(id int)',
      'CREATE SCHEMA evil',
      'CREATE INDEX evil_idx ON "users"(email)',
    ]) {
      const r = await attempt(sql);
      expect(r.ok, sql).toBe(false);
    }
  });
  it("can add and read audit records but cannot update or delete them", async () => {
    // Audit rows can never be deleted, so this test must not keep its row: add it, read it, roll back.
    await rt.query("BEGIN");
    await rt.query(
      `INSERT INTO audit_logs(id, action, entity_type) VALUES (gen_random_uuid(), 'test.runtime_insert', 'test')`,
    );
    const seen = (await rt.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action='test.runtime_insert'`)).rows[0].n;
    await rt.query("ROLLBACK");
    expect(seen).toBe(1);
    for (const sql of [
      `UPDATE audit_logs SET action = 'tampered'`,
      `DELETE FROM audit_logs`,
      `UPDATE integration_sync_errors SET message = 'x'`,
      `DELETE FROM application_status_history`,
    ]) {
      const r = await attempt(sql);
      expect(r.ok, sql).toBe(false);
      expect(r.error).toMatch(/permission denied/i);
    }
  });
  it("cannot touch Prisma's migration table", async () => {
    const r = await attempt(`SELECT * FROM "_prisma_migrations"`);
    expect(r.ok).toBe(false);
  });
  it("can do normal work in ordinary tables", async () => {
    await rt.query("BEGIN");
    await rt.query(`INSERT INTO permissions(id, key, module) VALUES (gen_random_uuid(), 'test:probe', 'test')`);
    await rt.query(`UPDATE permissions SET description = 'changed' WHERE key = 'test:probe'`);
    await rt.query(`DELETE FROM permissions WHERE key = 'test:probe'`);
    await rt.query("ROLLBACK");
  });
});
