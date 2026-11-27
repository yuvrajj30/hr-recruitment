// The daily housekeeping functions belong to the scheduled job's own database account (hr_maintenance), not to the
// web app's account (hr_runtime): migration 20261127000000_maintenance_identity. Before it, they were gated only by
// the session setting app.mode = 'maintenance', which any connection can set for itself.
// Against the DISPOSABLE test database only. Every job call here runs in a transaction that is rolled back.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const maintenanceUrl = process.env.TEST_MAINTENANCE_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl) && isTestDb(maintenanceUrl);

// The seven housekeeping functions, each with a call that is safe to run (and is rolled back anyway). Organisation-
// scoped ones are pointed at an organisation that does not exist, so they find nothing.
const NO_ORG = randomUUID();
const JOBS: { fn: string; sig: string; sql: string; params: unknown[] }[] = [
  { fn: "app_remove_due_candidates", sig: "app_remove_due_candidates(integer,uuid,timestamp with time zone)", sql: `SELECT * FROM app_remove_due_candidates(1, $1::uuid)`, params: [NO_ORG] },
  { fn: "app_pending_file_removals", sig: "app_pending_file_removals(integer,uuid)", sql: `SELECT * FROM app_pending_file_removals(1, $1::uuid)`, params: [NO_ORG] },
  { fn: "app_confirm_file_removed", sig: "app_confirm_file_removed(uuid[])", sql: `SELECT app_confirm_file_removed(ARRAY[]::uuid[])`, params: [] },
  { fn: "app_remove_old_attendance_device_data", sig: "app_remove_old_attendance_device_data(integer)", sql: `SELECT app_remove_old_attendance_device_data(90)`, params: [] },
  { fn: "app_generate_standard_shifts", sig: "app_generate_standard_shifts(integer)", sql: `SELECT app_generate_standard_shifts(14)`, params: [] },
  { fn: "app_leave_housekeeping", sig: "app_leave_housekeeping(date)", sql: `SELECT app_leave_housekeeping(NULL)`, params: [] },
  { fn: "app_task_housekeeping", sig: "app_task_housekeeping(date)", sql: `SELECT app_task_housekeeping(NULL)`, params: [] },
];

describe.skipIf(!enabled)("maintenance identity: only the scheduled job's account runs housekeeping (test database)", () => {
  let owner: Client;
  let rt: Client;
  let mt: Client;

  beforeAll(async () => {
    owner = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    rt = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
    mt = new Client({ connectionString: maintenanceUrl, options: "-c TimeZone=UTC" });
    await Promise.all([owner.connect(), rt.connect(), mt.connect()]);
  });
  afterAll(async () => {
    await Promise.all([owner?.end(), rt?.end(), mt?.end()]);
  });

  // Runs `sql` with the given session settings in a transaction that is ALWAYS rolled back.
  async function attempt(c: Client, settings: Record<string, string>, sql: string, params: unknown[] = []) {
    await c.query("BEGIN");
    try {
      for (const [k, v] of Object.entries(settings)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
      const r = await c.query(sql, params);
      return { rows: r.rows as Record<string, unknown>[], error: undefined as string | undefined, code: undefined as string | undefined };
    } catch (e) {
      return { rows: [] as Record<string, unknown>[], error: (e as Error).message, code: (e as { code?: string }).code };
    } finally {
      await c.query("ROLLBACK");
    }
  }
  const MAINT = { "app.mode": "maintenance" };

  it("connects the three accounts it is about", async () => {
    expect((await owner.query(`SELECT session_user AS u`)).rows[0].u).toBe("hr_app");
    expect((await rt.query(`SELECT session_user AS u`)).rows[0].u).toBe("hr_runtime");
    expect((await mt.query(`SELECT session_user AS u`)).rows[0].u).toBe("hr_maintenance");
  });

  it("the web app's account cannot run any housekeeping function, even after setting app.mode = 'maintenance'", async () => {
    for (const j of JOBS) {
      const r = await attempt(rt, MAINT, j.sql, j.params);
      expect(r.code, j.fn).toBe("42501");
      expect(r.error, j.fn).toMatch(new RegExp(`permission denied for function ${j.fn}`));
    }
    // ... nor with any other session setting it could think of.
    const tries: Record<string, string>[] = [{}, { "app.mode": "staff" }, { "app.mode": "public_apply" }, { "app.mode": "MAINTENANCE" }, { "app.mode": "maintenance ", "app.org_id": NO_ORG }];
    for (const settings of tries) {
      const r = await attempt(rt, settings, JOBS[0]!.sql, JOBS[0]!.params);
      expect(r.code, JSON.stringify(settings)).toBe("42501");
    }
  });

  it("the web app's account (and everyone else) has no EXECUTE right on them; the job's account has", async () => {
    for (const j of JOBS) {
      const r = (await owner.query(
        `SELECT has_function_privilege('hr_runtime', $1::regprocedure, 'EXECUTE') AS rt, has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS pub,
                has_function_privilege('hr_maintenance', $1::regprocedure, 'EXECUTE') AS mt`, [j.sig])).rows[0];
      expect(r, j.fn).toEqual({ rt: false, pub: false, mt: true });
    }
  });

  it("the web app's account cannot become the job's account", async () => {
    const r = (await owner.query(`SELECT pg_has_role('hr_runtime', 'hr_maintenance', 'MEMBER') AS a, pg_has_role('hr_runtime', 'hr_maintenance', 'USAGE') AS b`)).rows[0];
    expect(r).toEqual({ a: false, b: false });
    expect((await attempt(rt, {}, `SET LOCAL ROLE hr_maintenance`)).error).toMatch(/permission denied to set role/);
    expect((await attempt(rt, {}, `SET LOCAL SESSION AUTHORIZATION hr_maintenance`)).error).toMatch(/permission denied/);
  });

  it("maintenance mode set by any other account than the job's is reported as refused", async () => {
    expect((await attempt(rt, MAINT, `SELECT app_mode() AS m`)).rows[0]!.m).toBe("refused");
    expect((await attempt(owner, MAINT, `SELECT app_mode() AS m`)).rows[0]!.m).toBe("refused");
    // The web app's own modes are unchanged.
    expect((await attempt(rt, { "app.mode": "staff" }, `SELECT app_mode() AS m`)).rows[0]!.m).toBe("staff");
    expect((await attempt(rt, { "app.mode": "public_apply" }, `SELECT app_mode() AS m`)).rows[0]!.m).toBe("public_apply");
    expect((await attempt(rt, {}, `SELECT app_mode() AS m`)).rows[0]!.m).toBeNull(); // the sign-in look-up mode
  });

  it("the job's account runs every housekeeping job in maintenance mode", async () => {
    expect((await attempt(mt, MAINT, `SELECT app_mode() AS m`)).rows[0]!.m).toBe("maintenance");
    for (const j of JOBS) {
      const r = await attempt(mt, MAINT, j.sql, j.params);
      expect(r.error, j.fn).toBeUndefined();
    }
  });

  it("the job's account is refused outside maintenance mode, and cannot act as staff, as the public site or in the sign-in look-up", async () => {
    const others: Record<string, string>[] = [{}, { "app.mode": "staff" }, { "app.mode": "public_apply" }];
    for (const settings of others) {
      expect((await attempt(mt, settings, `SELECT app_mode() AS m`)).rows[0]!.m, JSON.stringify(settings)).toBe("refused");
      for (const j of JOBS) expect((await attempt(mt, settings, j.sql, j.params)).error, `${j.fn} ${JSON.stringify(settings)}`).toMatch(/not allowed/);
    }
  });

  it("the job's account can run nothing else that the web app's functions or internals offer", async () => {
    // Every function in the schema it may execute, apart from what every account may (PUBLIC), is exactly the seven.
    const extra = (await owner.query(
      `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND has_function_privilege('hr_maintenance', p.oid, 'EXECUTE') AND NOT has_function_privilege('public', p.oid, 'EXECUTE') ORDER BY 1`)).rows.map((r) => r.proname);
    expect(extra).toEqual(JOBS.map((j) => j.fn).sort());
    // For example, a staff action is refused outright.
    expect((await attempt(mt, MAINT, `SELECT app_clock_in(NULL, NULL)`)).error).toMatch(/permission denied for function app_clock_in/);
  });

  it("the job's account cannot read, change or create any table", async () => {
    const tables = (await owner.query(
      `SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'p')
         AND (has_table_privilege('hr_maintenance', c.oid, 'SELECT') OR has_table_privilege('hr_maintenance', c.oid, 'INSERT')
           OR has_table_privilege('hr_maintenance', c.oid, 'UPDATE') OR has_table_privilege('hr_maintenance', c.oid, 'DELETE')
           OR has_table_privilege('hr_maintenance', c.oid, 'TRUNCATE'))`)).rows.map((r) => r.relname);
    expect(tables).toEqual([]);
    for (const t of ["employees", "organization_candidates", "candidate_documents", "sessions", "audit_logs", "leave_ledger", "tasks"]) {
      expect((await attempt(mt, MAINT, `SELECT count(*) FROM ${t}`)).error, t).toMatch(/permission denied for table/);
    }
    expect((await attempt(mt, MAINT, `CREATE TABLE zz_maint_probe (id int)`)).error).toMatch(/permission denied for schema public/);
    expect((await attempt(mt, MAINT, `CREATE TEMP TABLE zz_maint_probe (id int)`)).error).toMatch(/permission denied/);
  });

  it("the job's account is a plain, restricted login", async () => {
    const r = (await owner.query(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit, rolcanlogin,
              pg_has_role('hr_maintenance', 'hr_runtime', 'MEMBER') AS in_runtime, pg_has_role('hr_maintenance', 'hr_app', 'MEMBER') AS in_owner
         FROM pg_roles WHERE rolname = 'hr_maintenance'`)).rows[0];
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolinherit: false,
      rolcanlogin: true, in_runtime: false, in_owner: false });
  });
});
