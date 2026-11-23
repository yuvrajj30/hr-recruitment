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
  it("can add sign-in audit records only, cannot read them without being a Super Admin, and cannot update or delete them", async () => {
    // Audit rows can never be deleted, so this test must not keep its row: add it, try to read it, roll back.
    await rt.query("BEGIN");
    const inserted = await rt.query(
      `INSERT INTO audit_logs(id, action, entity_type) VALUES (gen_random_uuid(), 'auth.test_runtime_insert', 'test')`,
    );
    // Row-level security: only a Super Admin of the organisation may read the log.
    const seen = (await rt.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action='auth.test_runtime_insert'`)).rows[0].n;
    await rt.query("ROLLBACK");
    expect(inserted.rowCount).toBe(1);
    expect(seen).toBe(0);
    // Before anyone is signed in, only sign-in ("auth.") records may be added: nothing else can be made up.
    const other = await attempt(`INSERT INTO audit_logs(id, action, entity_type) VALUES (gen_random_uuid(), 'job.deleted', 'job')`);
    expect(other.ok).toBe(false);
    expect(other.error).toMatch(/row-level security/i);
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
    await rt.query(`INSERT INTO auth_login_attempts(id, identifier_hash, succeeded) VALUES (gen_random_uuid(), 'runtime-role-probe', false)`);
    await rt.query(`UPDATE auth_login_attempts SET succeeded = true WHERE identifier_hash = 'runtime-role-probe'`);
    await rt.query(`DELETE FROM auth_login_attempts WHERE identifier_hash = 'runtime-role-probe'`);
    await rt.query("ROLLBACK");
  });
  it("can read roles and permissions but never change them", async () => {
    expect((await rt.query(`SELECT count(*)::int AS n FROM roles`)).rows[0].n).toBe(3);
    for (const sql of [
      `INSERT INTO permissions(id, key, module) VALUES (gen_random_uuid(), 'test:probe', 'test')`,
      `UPDATE permissions SET description = 'changed'`,
      `DELETE FROM role_permissions`,
      `INSERT INTO role_permissions(role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p WHERE r.key = 'EMPLOYEE' AND p.key = 'audit:read'`,
      `UPDATE roles SET name = 'x'`,
    ]) {
      const r = await attempt(sql);
      expect(r.ok, sql).toBe(false);
      expect(r.error, sql).toMatch(/permission denied/i);
    }
  });
});
