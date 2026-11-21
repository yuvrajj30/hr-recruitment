// Attendance (migrations 20261122000000..20261122000200), against the DISPOSABLE test database only.
// Everything here talks to PostgreSQL directly as the app's restricted account (row-level security and function
// rights apply), signed in through a real session token: the database functions are the only way to write
// attendance, so they are what is tested. Times are the database's own; tests that need "yesterday" move a
// record back through the owner account, stating the change like a correction would.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/lib/db";
import { realRoleIds } from "./roles-helper";
import { pgSessionToken, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");
const DOMAIN = "attendance.example.test";
type K = "a" | "b";
type Who = "sa" | "hr" | "emp" | "emp2";
type Result = { rows: Record<string, unknown>[]; rowCount: number; error?: string };

describe.skipIf(!enabled)("attendance (test database)", () => {
  let owner: Db;
  let raw: Client;
  let rt: Client;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  // Per organisation: users, members, an outlet pair and employee records (emp / emp2 / hr linked; "nologin" not).
  const w = {} as Record<K, { org: string; user: Record<Who, string>; member: Record<Who, string>; outlet: string; outlet2: string; e: Record<Who | "nologin", string> }>;

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 2 });
    raw = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    rt = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
    await raw.connect();
    await rt.connect();
    const role = await realRoleIds(owner);
    const keyOf: Record<Who, "SUPER_ADMIN" | "HR_MANAGER" | "EMPLOYEE"> = { sa: "SUPER_ADMIN", hr: "HR_MANAGER", emp: "EMPLOYEE", emp2: "EMPLOYEE" };
    for (const k of ["a", "b"] as const) {
      const user = {} as Record<Who, string>;
      for (const who of ["sa", "hr", "emp", "emp2"] as const) {
        user[who] = (await owner.user.create({ data: { email: `${who}-${k}-${rnd()}@${DOMAIN}`, name: `${who.toUpperCase()} ${k}` } })).id;
        userIds.push(user[who]);
      }
      const org = await owner.organization.create({ data: { slug: `att-${k}-${rnd()}${rnd()}`, name: `Attendance ${k}`, ownerUserId: user.sa, timezone: "Asia/Kolkata" } });
      orgIds.push(org.id);
      const member = {} as Record<Who, string>;
      for (const who of ["sa", "hr", "emp", "emp2"] as const) {
        member[who] = (await owner.organizationMember.create({ data: { organizationId: org.id, userId: user[who], status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role[keyOf[who]] }] } } })).id;
      }
      const outlet = (await raw.query(`INSERT INTO outlets (organization_id, name, updated_at) VALUES ($1, 'Vijay Nagar', now()) RETURNING id`, [org.id])).rows[0].id;
      const outlet2 = (await raw.query(`INSERT INTO outlets (organization_id, name, updated_at) VALUES ($1, 'Palasia', now()) RETURNING id`, [org.id])).rows[0].id;
      const e = {} as Record<Who | "nologin", string>;
      for (const who of ["sa", "hr", "emp", "emp2", "nologin"] as const) {
        e[who] = (await raw.query(
          `INSERT INTO employees (organization_id, employee_code, full_name, joined_on, outlet_id, member_id, updated_at)
           VALUES ($1, $2, $3, '2026-01-01', $4, $5, now()) RETURNING id`,
          [org.id, `AT-${who}-${rnd()}`.toUpperCase(), `Person ${who} ${k}`, outlet, who === "nologin" ? null : member[who]],
        )).rows[0].id;
      }
      w[k] = { org: org.id, user, member, outlet, outlet2, e };
    }
  }, 90_000);

  afterAll(async () => {
    if (raw && orgIds.length) {
      await raw.query(`DELETE FROM attendance_correction_requests WHERE organization_id = ANY($1)`, [orgIds]);
      await raw.query(`DELETE FROM attendance_records WHERE organization_id = ANY($1)`, [orgIds]); // breaks and history cascade
      await raw.query(`DELETE FROM shifts WHERE organization_id = ANY($1)`, [orgIds]);
      await raw.query(`DELETE FROM employee_assignments WHERE organization_id = ANY($1)`, [orgIds]);
      await raw.query(`DELETE FROM employees WHERE organization_id = ANY($1)`, [orgIds]);
      await raw.query(`DELETE FROM outlets WHERE organization_id = ANY($1)`, [orgIds]);
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await purgeTestAuditRows(owner, orgIds);
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await owner?.$disconnect();
    await raw?.end();
    await rt?.end();
  });

  // As the app account, signed in as `who` of `k` (or in public / maintenance mode), committed unless it fails.
  async function run(c: Client, k: K, who: Who | "public" | "maintenance", sql: string, params: unknown[] = []): Promise<Result> {
    await c.query("BEGIN");
    try {
      if (who === "public") await c.query(`SELECT set_config('app.mode', 'public_apply', true), set_config('app.org_id', $1, true)`, [w[k].org]);
      else if (who === "maintenance") await c.query(`SELECT set_config('app.mode', 'maintenance', true)`);
      else await c.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`, [await pgSessionToken(raw, w[k].user[who], w[k].org)]);
      const r = await c.query(sql, params);
      await c.query("COMMIT");
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    } catch (e) {
      await c.query("ROLLBACK");
      return { rows: [], rowCount: 0, error: (e as Error).message };
    }
  }
  const as = (k: K, who: Who | "public" | "maintenance", sql: string, params: unknown[] = []) => run(rt, k, who, sql, params);
  const ok = async (k: K, who: Who | "public" | "maintenance", sql: string, params: unknown[] = []) => {
    const r = await as(k, who, sql, params);
    expect(r.error, sql).toBeUndefined();
    return r.rows;
  };
  const count = async (k: K, who: Who | "public", table: string, where = "true", params: unknown[] = []) =>
    Number((await ok(k, who, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params))[0]!.n);
  const rec = async (id: string) => (await raw.query(`SELECT * FROM attendance_records WHERE id = $1`, [id])).rows[0];
  const kinds = async (id: string) => (await raw.query(`SELECT kind FROM attendance_changes WHERE record_id = $1 ORDER BY created_at`, [id])).rows.map((r) => r.kind);
  // Moves a record's times (owner account, stated as a correction so the history and checks still apply).
  async function backdate(id: string, inAgo: string, outAgo: string | null) {
    await raw.query("BEGIN");
    await raw.query(`SELECT set_config('app.att_kind', 'CORRECTED', true), set_config('app.att_reason', 'test backdate', true)`);
    await raw.query(`UPDATE attendance_records SET clock_in_at = now() - $2::interval, clock_out_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() - $3::interval END,
                       status = CASE WHEN $3::text IS NULL THEN status ELSE 'CLOSED' END, out_source = CASE WHEN $3::text IS NULL THEN out_source ELSE 'HR' END WHERE id = $1`, [id, inAgo, outAgo]);
    await raw.query("COMMIT");
  }
  // Closes whatever is open for an employee (keeps tests independent).
  async function closeOpen(employeeId: string) {
    await raw.query("BEGIN");
    await raw.query(`SELECT set_config('app.att_kind', 'VOIDED', true), set_config('app.att_reason', 'test cleanup', true)`);
    await raw.query(`UPDATE attendance_records SET status = 'VOID' WHERE employee_id = $1 AND status IN ('OPEN', 'MISSING_OUT')`, [employeeId]);
    await raw.query("COMMIT");
  }

  it("lets a linked employee clock in and out with breaks, at the database's time, with a full history", async () => {
    const a = w.a;
    const id = (await ok("a", "emp", `SELECT app_clock_in($1, $2) AS id`, [" 203.0.113.7 ", "Mozilla/5.0\u0007\u001b (test)"]))[0]!.id as string;
    let r = await rec(id);
    expect(r).toMatchObject({ status: "OPEN", employee_id: a.e.emp, outlet_id: a.outlet, in_source: "SELF", in_ip: "203.0.113.7", in_user_agent: "Mozilla/5.0   (test)" });
    expect(Math.abs(Date.now() - new Date(r.clock_in_at).getTime())).toBeLessThan(60_000);
    expect((await as("a", "emp", `SELECT app_clock_in(NULL, NULL)`)).error).toMatch(/already_clocked_in/);
    await ok("a", "emp", `SELECT app_break(true)`);
    expect((await as("a", "emp", `SELECT app_break(true)`)).error).toMatch(/already_on_break/);
    await ok("a", "emp", `SELECT app_break(false)`);
    expect((await as("a", "emp", `SELECT app_break(false)`)).error).toMatch(/not_on_break/);
    await ok("a", "emp", `SELECT app_break(true)`); // still on break at clock-out: ended automatically
    expect((await ok("a", "emp", `SELECT app_clock_out('not an ip', NULL) AS s`))[0]!.s).toBe("closed");
    r = await rec(id);
    expect(r).toMatchObject({ status: "CLOSED", out_source: "SELF", out_ip: null });
    expect((await raw.query(`SELECT count(*)::int n FROM attendance_breaks WHERE record_id = $1 AND ends_at IS NULL`, [id])).rows[0].n).toBe(0);
    expect(await kinds(id)).toEqual(["CLOCK_IN", "BREAK_START", "BREAK_END", "BREAK_START", "CLOCK_OUT"]);
    // The history never carries device details, and records who acted.
    const h = (await raw.query(`SELECT after, changed_by_id FROM attendance_changes WHERE record_id = $1`, [id])).rows;
    expect(JSON.stringify(h)).not.toContain("203.0.113.7");
    expect(h.every((x) => x.changed_by_id === a.user.emp)).toBe(true);
    expect((await as("a", "emp", `SELECT app_clock_out(NULL, NULL)`)).error).toMatch(/not_clocked_in/);
  });

  it("gives no way to write attendance except through the functions, and refuses people without a record", async () => {
    const a = w.a;
    for (const sql of [
      `INSERT INTO attendance_records (organization_id, employee_id, clock_in_at, status, in_source) VALUES ('${a.org}', '${a.e.emp}', now() - interval '9 hours', 'OPEN', 'SELF')`,
      `UPDATE attendance_records SET clock_in_at = clock_in_at - interval '1 hour' WHERE employee_id = '${a.e.emp}'`,
      `DELETE FROM attendance_records WHERE employee_id = '${a.e.emp}'`,
      `INSERT INTO attendance_changes (organization_id, employee_id, record_id, kind, after) SELECT organization_id, employee_id, id, 'CORRECTED', '{}' FROM attendance_records LIMIT 1`,
      `UPDATE attendance_correction_requests SET status = 'APPROVED'`,
    ]) {
      for (const who of ["hr", "sa", "emp"] as const) expect((await as("a", who, sql)).error, `${who}: ${sql}`).toMatch(/permission denied/);
    }
    // Internal helpers are not callable by the app account.
    expect((await as("a", "hr", `SELECT att_lock_employee($1, $2)`, [a.org, a.e.emp])).error).toMatch(/permission denied/);
    expect((await as("a", "hr", `SELECT att_say('CORRECTED')`)).error).toMatch(/permission denied/);
    // A signed-in person whose account is not linked to an employee record:
    await raw.query(`UPDATE employees SET member_id = NULL WHERE id = $1`, [a.e.emp2]);
    try {
      expect((await as("a", "emp2", `SELECT app_clock_in(NULL, NULL)`)).error).toMatch(/no_employee_record/);
    } finally {
      await raw.query(`UPDATE employees SET member_id = $2 WHERE id = $1`, [a.e.emp2, a.member.emp2]);
    }
    // Public careers mode and maintenance mode cannot clock.
    expect((await as("a", "public", `SELECT app_clock_in(NULL, NULL)`)).error).toMatch(/not allowed/);
    expect((await as("a", "maintenance", `SELECT app_clock_in(NULL, NULL)`)).error).toMatch(/not allowed/);
  });

  it("marks a clock-in left open as missing its clock-out, at the next clock-in or clock-out", async () => {
    const a = w.a;
    const first = (await ok("a", "emp2", `SELECT app_clock_in(NULL, NULL) AS id`))[0]!.id as string;
    await backdate(first, "21 hours", null);
    const second = (await ok("a", "emp2", `SELECT app_clock_in(NULL, NULL) AS id`))[0]!.id as string;
    expect((await rec(first)).status).toBe("MISSING_OUT");
    expect((await rec(second)).status).toBe("OPEN");
    expect(await kinds(first)).toEqual(["CLOCK_IN", "CORRECTED", "MARKED_MISSING_OUT"]);
    await backdate(second, "22 hours", null);
    expect((await ok("a", "emp2", `SELECT app_clock_out(NULL, NULL) AS s`))[0]!.s).toBe("missing_out");
    expect((await rec(second)).status).toBe("MISSING_OUT");
    // Breaks on a record left behind are refused.
    expect((await as("a", "emp2", `SELECT app_break(true)`)).error).toMatch(/not_clocked_in/);
    void a;
  });

  it("plans shifts with no overlaps, never in the past, fixed once started, cancelled with a reason", async () => {
    const a = w.a;
    const ins = (who: Who, emp: string, startIn: string, endIn: string, outlet = a.outlet) =>
      as("a", who, `INSERT INTO shifts (organization_id, employee_id, outlet_id, starts_at, ends_at, break_minutes, updated_at)
                    VALUES ($1, $2, $3, now() + $4::interval, now() + $5::interval, 30, now()) RETURNING id, created_by_id`, [a.org, emp, outlet, startIn, endIn]);
    const s1 = await ins("hr", a.e.emp, "2 days", "2 days 8 hours");
    expect(s1.error).toBeUndefined();
    expect(s1.rows[0]!.created_by_id).toBe(a.user.hr); // set by the database, not the app
    expect((await ins("hr", a.e.emp, "2 days 4 hours", "2 days 10 hours")).error).toMatch(/shifts_no_overlap/);
    expect((await ins("hr", a.e.emp, "2 days 8 hours", "2 days 12 hours")).error).toBeUndefined(); // back to back is fine
    expect((await ins("hr", a.e.emp, "-3 hours", "-1 hours")).error).toMatch(/shift_in_past/);
    expect((await ins("hr", a.e.emp, "1 day", "1 day 17 hours")).error).toMatch(/shifts_period_check/);
    expect((await ins("emp", a.e.emp, "3 days", "3 days 8 hours")).error).toMatch(/row-level security/);
    // A shift that has started: its start cannot move (a late arrival cannot be hidden); it can be cancelled.
    const started = await ins("hr", a.e.emp2, "-4 minutes", "6 hours");
    expect(started.error).toBeUndefined();
    const sid = started.rows[0]!.id as string;
    expect((await as("a", "hr", `UPDATE shifts SET starts_at = starts_at + interval '1 hour' WHERE id = $1`, [sid])).error).toMatch(/shift_started/);
    expect((await as("a", "hr", `UPDATE shifts SET ends_at = ends_at + interval '1 hour' WHERE id = $1`, [sid])).error).toBeUndefined();
    expect((await as("a", "hr", `UPDATE shifts SET status = 'CANCELLED' WHERE id = $1`, [sid])).error).toMatch(/shifts_cancel_check/);
    expect((await as("a", "hr", `UPDATE shifts SET status = 'CANCELLED', cancel_reason = 'Outlet closed' WHERE id = $1`, [sid])).error).toBeUndefined();
    expect((await as("a", "hr", `UPDATE shifts SET status = 'PLANNED', cancel_reason = NULL WHERE id = $1`, [sid])).error).toMatch(/shift_cancelled/);
    // Columns HR may not set, and no deleting.
    expect((await as("a", "hr", `UPDATE shifts SET employee_id = $2 WHERE id = $1`, [s1.rows[0]!.id, a.e.emp2])).error).toMatch(/permission denied/);
    expect((await as("a", "hr", `DELETE FROM shifts WHERE id = $1`, [s1.rows[0]!.id])).error).toMatch(/permission denied/);
    // Each employee sees only their own rota; HR of another organisation sees none.
    expect(await count("a", "emp", "shifts", "employee_id <> $1", [a.e.emp])).toBe(0);
    expect(await count("a", "emp", "shifts")).toBeGreaterThan(0);
    expect(await count("b", "hr", "shifts", "organization_id = $1", [a.org])).toBe(0);
    // A shift for an employee of another organisation, or at another organisation's outlet, is impossible.
    expect((await as("b", "hr", `INSERT INTO shifts (organization_id, employee_id, outlet_id, starts_at, ends_at, updated_at) VALUES ($1, $2, $3, now() + interval '1 day', now() + interval '1 day 4 hours', now())`,
      [w.b.org, a.e.emp, w.b.outlet])).error).toMatch(/not_found/);
  });

  it("links a clock-in to the shift it belongs to, and takes that shift's outlet", async () => {
    const a = w.a;
    await closeOpen(a.e.sa);
    const shift = (await ok("a", "hr", `INSERT INTO shifts (organization_id, employee_id, outlet_id, starts_at, ends_at, updated_at)
      VALUES ($1, $2, $3, now() + interval '40 minutes', now() + interval '8 hours', now()) RETURNING id`, [a.org, a.e.sa, a.outlet2]))[0]!.id;
    const id = (await ok("a", "sa", `SELECT app_clock_in(NULL, NULL) AS id`))[0]!.id as string;
    expect(await rec(id)).toMatchObject({ shift_id: shift, outlet_id: a.outlet2 });
    await ok("a", "sa", `SELECT app_clock_out(NULL, NULL)`);
  });

  it("lets HR record time for staff without a login, within employment, without overlaps", async () => {
    const a = w.a;
    const recordIt = (who: Who, emp: string, inAgo: string, outAgo: string | null, brk: number | null = null) =>
      as("a", who, `SELECT app_hr_record_attendance($1, NULL, now() - $2::interval, CASE WHEN $3::text IS NULL THEN NULL ELSE now() - $3::interval END, $4, 'Paper sheet') AS id`,
        [emp, inAgo, outAgo, brk]);
    const r1 = await recordIt("hr", a.e.nologin, "30 hours", "22 hours", 30);
    expect(r1.error).toBeUndefined();
    const id = r1.rows[0]!.id as string;
    expect(await rec(id)).toMatchObject({ status: "CLOSED", in_source: "HR", out_source: "HR", break_minutes: 30, in_ip: null, outlet_id: a.outlet });
    expect((await raw.query(`SELECT kind, reason, changed_by_id FROM attendance_changes WHERE record_id = $1`, [id])).rows).toEqual([{ kind: "HR_RECORDED", reason: "Paper sheet", changed_by_id: a.user.hr }]);
    expect((await recordIt("hr", a.e.nologin, "28 hours", "20 hours")).error).toMatch(/attendance_overlap/);
    expect((await recordIt("hr", a.e.nologin, "2 hours", "-1 hours")).error).toMatch(/attendance_bad_period/); // ends in the future
    expect((await recordIt("hr", a.e.nologin, "10 hours", "9 hours", 60)).error).toMatch(/attendance_bad_break/);
    expect((await recordIt("hr", a.e.nologin, "400 days", "399 days 20 hours")).error).toMatch(/attendance_outside_employment/); // before joining
    expect((await recordIt("emp", a.e.nologin, "50 hours", "45 hours")).error).toMatch(/not allowed/);
    // A void record no longer blocks the period, is never changed again, and leaves its trace.
    await ok("a", "hr", `SELECT app_hr_void_attendance($1, 'Entered twice')`, [id]);
    expect((await rec(id)).status).toBe("VOID");
    expect((await recordIt("hr", a.e.nologin, "28 hours", "20 hours")).error).toBeUndefined();
    expect((await as("a", "hr", `SELECT app_hr_correct_attendance($1, now() - interval '30 hours', now() - interval '21 hours', NULL, false, NULL, 'x')`, [id])).error).toMatch(/attendance_void/);
    expect(await kinds(id)).toEqual(["HR_RECORDED", "VOIDED"]);
    expect((await as("a", "hr", `SELECT app_hr_void_attendance($1, '  ')`, [id])).error).toMatch(/reason_required/);
  });

  it("runs correction requests: one pending per record, approval applies them, newer changes supersede them", async () => {
    const a = w.a;
    await closeOpen(a.e.emp);
    const id = (await ok("a", "emp", `SELECT app_clock_in(NULL, NULL) AS id`))[0]!.id as string;
    await ok("a", "emp", `SELECT app_clock_out(NULL, NULL)`);
    await backdate(id, "50 hours", "45 hours");
    const request = (args: unknown[]) => as("a", "emp", `SELECT app_request_attendance_correction($1, now() - $2::interval, now() - $3::interval, $4, $5) AS id`, args);
    expect((await request([id, "51 hours", "45 hours", null, "  "])).error).toMatch(/reason_required/);
    expect((await request([id, "40 days", "39 days 20 hours", null, "Late"])).error).toMatch(/attendance_bad_period/);
    expect((await request([w.a.e.emp2, "51 hours", "45 hours", null, "Not mine"])).error).toMatch(/record_not_correctable/);
    const q1 = await request([id, "51 hours", "45 hours", 15, "Clocked in late on the tablet"]);
    expect(q1.error).toBeUndefined();
    expect((await request([id, "52 hours", "45 hours", null, "Again"])).error).toMatch(/request_pending/);
    // A colleague cannot see it; HR can.
    expect(await count("a", "emp2", "attendance_correction_requests", "id = $1", [q1.rows[0]!.id])).toBe(0);
    expect(await count("a", "hr", "attendance_correction_requests", "id = $1", [q1.rows[0]!.id])).toBe(1);
    // Rejecting needs a note; approving applies exactly what was asked.
    expect((await as("a", "hr", `SELECT app_decide_attendance_correction($1, false, NULL)`, [q1.rows[0]!.id])).error).toMatch(/decision_note_required/);
    await ok("a", "hr", `SELECT app_decide_attendance_correction($1, true, NULL)`, [q1.rows[0]!.id]);
    const after = await rec(id);
    expect(after).toMatchObject({ status: "CLOSED", break_minutes: 15, in_source: "CORRECTION" });
    const last = (await raw.query(`SELECT kind, reason, request_id, changed_by_id, before, after FROM attendance_changes WHERE record_id = $1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
    expect(last).toMatchObject({ kind: "CORRECTED", reason: "Clocked in late on the tablet", request_id: q1.rows[0]!.id, changed_by_id: a.user.hr });
    expect(last.before.clock_in_at).not.toBe(last.after.clock_in_at); // the original is kept
    expect((await as("a", "hr", `SELECT app_decide_attendance_correction($1, true, NULL)`, [q1.rows[0]!.id])).error).toMatch(/request_not_pending/);
    // A newer direct correction by HR makes a pending request void (SUPERSEDED), so it cannot overwrite it later.
    const q2 = (await request([id, "52 hours", "45 hours", null, "Actually earlier"])).rows[0]!.id;
    await ok("a", "hr", `SELECT app_hr_correct_attendance($1, now() - interval '51 hours', now() - interval '44 hours', NULL, false, NULL, 'Checked the CCTV')`, [id]);
    expect((await raw.query(`SELECT status FROM attendance_correction_requests WHERE id = $1`, [q2])).rows[0].status).toBe("SUPERSEDED");
    // "I forgot to clock in at all": approval adds a record; one that would overlap is refused and stays pending.
    const add = (await as("a", "emp", `SELECT app_request_attendance_correction(NULL, now() - interval '30 hours', now() - interval '26 hours', NULL, 'Forgot my phone') AS id`)).rows[0]!.id;
    await ok("a", "sa", `SELECT app_decide_attendance_correction($1, true, 'OK')`, [add]);
    const added = (await raw.query(`SELECT * FROM attendance_records WHERE employee_id = $1 AND id <> $2 AND in_source = 'CORRECTION' AND out_source = 'CORRECTION'`, [a.e.emp, id])).rows;
    expect(added).toHaveLength(1);
    expect(await kinds(added[0].id)).toEqual(["CORRECTED"]);
    const clash = (await as("a", "emp", `SELECT app_request_attendance_correction(NULL, now() - interval '29 hours', now() - interval '27 hours', NULL, 'Twice') AS id`)).rows[0]!.id;
    expect((await as("a", "hr", `SELECT app_decide_attendance_correction($1, true, NULL)`, [clash])).error).toMatch(/attendance_overlap/);
    expect((await raw.query(`SELECT status FROM attendance_correction_requests WHERE id = $1`, [clash])).rows[0].status).toBe("PENDING");
    await ok("a", "emp", `SELECT app_withdraw_attendance_correction($1)`, [clash]);
    expect((await as("a", "emp2", `SELECT app_withdraw_attendance_correction($1)`, [add])).error).toMatch(/not_found/);
  });

  it("does not let HR decide their own request while someone else can", async () => {
    const a = w.a;
    await closeOpen(a.e.hr);
    const id = (await ok("a", "hr", `SELECT app_clock_in(NULL, NULL) AS id`))[0]!.id as string;
    await ok("a", "hr", `SELECT app_clock_out(NULL, NULL)`);
    await backdate(id, "80 hours", "72 hours");
    const q = (await ok("a", "hr", `SELECT app_request_attendance_correction($1, now() - interval '81 hours', now() - interval '72 hours', NULL, 'Started early') AS id`, [id]))[0]!.id;
    expect((await as("a", "hr", `SELECT app_decide_attendance_correction($1, true, NULL)`, [q])).error).toMatch(/own_request/);
    await ok("a", "sa", `SELECT app_decide_attendance_correction($1, false, 'Shift started at the usual time')`, [q]);
    // Correcting one's own record directly is possible (with a reason) but marked as a self-edit.
    await ok("a", "hr", `SELECT app_hr_correct_attendance($1, now() - interval '81 hours', now() - interval '72 hours', NULL, false, NULL, 'Own fix')`, [id]);
    expect((await raw.query(`SELECT self_edit FROM attendance_changes WHERE record_id = $1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0].self_edit).toBe(true);
  });

  it("keeps each organisation's attendance to itself, and each employee's to them and HR", async () => {
    const a = w.a;
    const anyA = (await raw.query(`SELECT id FROM attendance_records WHERE organization_id = $1 AND status = 'CLOSED' LIMIT 1`, [a.org])).rows[0].id;
    const reqA = (await raw.query(`SELECT id FROM attendance_correction_requests WHERE organization_id = $1 LIMIT 1`, [a.org])).rows[0].id;
    for (const t of ["attendance_records", "attendance_breaks", "attendance_changes", "attendance_correction_requests", "shifts"]) {
      expect(await count("b", "hr", t, "organization_id = $1", [a.org]), t).toBe(0);
      expect(await count("b", "sa", t, "organization_id = $1", [a.org]), t).toBe(0);
      expect(await count("a", "public", t), t).toBe(0);
      expect(await count("a", "emp", t, "employee_id <> $1", [a.e.emp]), t).toBe(0);
    }
    expect(await count("a", "hr", "attendance_records", "employee_id = $1", [a.e.emp])).toBeGreaterThan(0);
    // HR of B, with A's ids: every function says "not found" and nothing changes.
    const before = await rec(anyA);
    for (const [sql, params] of [
      [`SELECT app_hr_correct_attendance($1, now() - interval '3 hours', now() - interval '1 hour', NULL, false, NULL, 'x')`, [anyA]],
      [`SELECT app_hr_void_attendance($1, 'x')`, [anyA]],
      [`SELECT app_decide_attendance_correction($1, false, 'x')`, [reqA]],
      [`SELECT app_hr_record_attendance($1, NULL, now() - interval '200 hours', now() - interval '199 hours', NULL, NULL)`, [a.e.nologin]],
      [`SELECT app_hr_record_attendance($1, $2, now() - interval '200 hours', now() - interval '199 hours', NULL, NULL)`, [w.b.e.nologin, a.outlet]],
    ] as const) expect((await as("b", "hr", sql, [...params])).error, sql).toMatch(/not_found/);
    expect(await rec(anyA)).toEqual(before);
    // An employee cannot use HR functions, even on their own records.
    expect((await as("a", "emp", `SELECT app_hr_void_attendance($1, 'x')`, [anyA])).error).toMatch(/not allowed/);
  });

  it("refuses marking someone as left while clocked in or with later attendance, and cancels their later shifts", async () => {
    const b = w.b;
    const sid = (await ok("b", "hr", `INSERT INTO shifts (organization_id, employee_id, outlet_id, starts_at, ends_at, updated_at)
      VALUES ($1, $2, $3, now() + interval '5 days', now() + interval '5 days 8 hours', now()) RETURNING id`, [b.org, b.e.emp, b.outlet]))[0]!.id;
    await ok("b", "emp", `SELECT app_clock_in(NULL, NULL)`);
    const exit = (day: string) => as("b", "hr", `UPDATE employees SET status = 'EXITED', exited_on = $2::date WHERE id = $1`, [b.e.emp, day]);
    const today = (await raw.query(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).rows[0].d as string;
    expect((await exit(today)).error).toMatch(/employee_clocked_in/);
    await ok("b", "emp", `SELECT app_clock_out(NULL, NULL)`);
    const yesterday = (await raw.query(`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1)::text AS d`)).rows[0].d as string;
    expect((await exit(yesterday)).error).toMatch(/employee_attendance_after_exit/);
    expect((await exit(today)).error).toBeUndefined();
    expect((await raw.query(`SELECT status, cancel_reason FROM shifts WHERE id = $1`, [sid])).rows[0]).toEqual({ status: "CANCELLED", cancel_reason: "Employee left" });
    // Their last day is today: they could still clock in today, and nothing after it can be recorded.
    expect((await as("b", "hr", `SELECT app_hr_record_attendance($1, NULL, now() + interval '1 day', NULL, NULL, NULL)`, [b.e.emp])).error).toMatch(/attendance_bad_period/);
    expect((await as("b", "hr", `INSERT INTO shifts (organization_id, employee_id, outlet_id, starts_at, ends_at, updated_at)
      VALUES ($1, $2, $3, now() + interval '3 days', now() + interval '3 days 8 hours', now())`, [b.org, b.e.emp, b.outlet])).error).toMatch(/employee_not_active/);
  });

  it("keeps the history append-only and every change stated", async () => {
    const anyA = (await raw.query(`SELECT id FROM attendance_records WHERE organization_id = $1 LIMIT 1`, [w.a.org])).rows[0].id;
    expect(await raw.query(`UPDATE attendance_changes SET reason = 'rewritten' WHERE record_id = $1`, [anyA]).then(() => "allowed", (e: Error) => e.message)).toMatch(/append-only/);
    expect(await raw.query(`UPDATE attendance_records SET clock_in_at = clock_in_at - interval '1 minute' WHERE id = $1`, [anyA]).then(() => "allowed", (e: Error) => e.message)).toMatch(/attendance_change_without_kind/);
    expect(await raw.query(`TRUNCATE attendance_changes`).then(() => "allowed", (e: Error) => e.message)).toMatch(/cannot be truncated/);
  });

  it("removes device details after the retention period, only in maintenance mode", async () => {
    const a = w.a;
    await closeOpen(a.e.emp2);
    const id = (await ok("a", "emp2", `SELECT app_clock_in('198.51.100.4', 'Phone') AS id`))[0]!.id as string;
    await ok("a", "emp2", `SELECT app_clock_out('198.51.100.4', 'Phone')`);
    await backdate(id, "100 days", "99 days 20 hours");
    expect((await as("a", "hr", `SELECT app_remove_old_attendance_device_data(90)`)).error).toMatch(/not allowed/);
    expect((await as("a", "maintenance", `SELECT app_remove_old_attendance_device_data(7)`)).error).toMatch(/not allowed/);
    const n = (await ok("a", "maintenance", `SELECT app_remove_old_attendance_device_data(90) AS n`))[0]!.n as number;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await rec(id)).toMatchObject({ in_ip: null, in_user_agent: null, out_ip: null, out_user_agent: null, status: "CLOSED" });
    expect((await kinds(id)).at(-1)).toBe("CORRECTED"); // clearing device details adds no history row
  });

  it("handles breaks and dates sensibly when records are corrected (fixes in 20261122000300)", async () => {
    const a = w.a;
    // A recorded break that ends after the corrected clock-out is clipped into break minutes, not refused.
    // (The new clock-out is the middle of the first break, so that break is cut and any later one is outside.)
    const withBreaks = (await raw.query(`SELECT r.id, r.clock_in_at,
        (SELECT b.starts_at + (b.ends_at - b.starts_at) / 2 FROM attendance_breaks b WHERE b.record_id = r.id ORDER BY b.starts_at LIMIT 1) AS cut
      FROM attendance_records r WHERE r.employee_id = $1 AND r.status = 'CLOSED' AND r.break_minutes IS NULL
        AND EXISTS (SELECT 1 FROM attendance_breaks b WHERE b.record_id = r.id) ORDER BY r.clock_in_at LIMIT 1`, [a.e.emp])).rows[0];
    await ok("a", "hr", `SELECT app_hr_correct_attendance($1, $2::timestamptz - interval '2 hours', $3::timestamptz, NULL, false, NULL, 'Left during the break')`,
      [withBreaks.id, withBreaks.clock_in_at, withBreaks.cut]);
    expect(await rec(withBreaks.id)).toMatchObject({ status: "CLOSED", break_minutes: 0 });
    // Break minutes that no longer fit a shortened period: a clear refusal, not a constraint error.
    const r = (await ok("a", "hr", `SELECT app_hr_record_attendance($1, NULL, now() - interval '300 hours', now() - interval '292 hours', 60, NULL) AS id`, [a.e.nologin]))[0]!.id;
    expect((await as("a", "hr", `SELECT app_hr_correct_attendance($1, now() - interval '300 hours', now() - interval '299 hours 30 minutes', NULL, false, NULL, 'Half an hour only')`, [r])).error).toMatch(/attendance_bad_break/);
    // A complete record always has its clock-out, even for the owner account.
    await raw.query("BEGIN");
    await raw.query(`SELECT set_config('app.att_kind', 'CORRECTED', true)`);
    const broken = await raw.query(`UPDATE attendance_records SET clock_out_at = NULL WHERE id = $1`, [r]).then(() => "allowed", (e: Error) => e.message);
    await raw.query("ROLLBACK");
    expect(broken).toMatch(/attendance_records_state_check/);
    // The joining date cannot move after attendance the person already has.
    const today = (await raw.query(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).rows[0].d as string;
    expect((await as("a", "hr", `UPDATE employees SET joined_on = $2::date WHERE id = $1`, [a.e.nologin, today])).error).toMatch(/employee_joined_after_attendance/);
    expect((await as("a", "hr", `UPDATE employees SET joined_on = '2025-06-01' WHERE id = $1`, [a.e.nologin])).error).toBeUndefined(); // earlier is fine
  });

  describe("at the same moment, on two connections", () => {
    let c2: Client;
    beforeAll(async () => {
      c2 = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
      await c2.connect();
    });
    afterAll(async () => c2?.end());

    it("lets only one of two simultaneous clock-ins through", async () => {
      await closeOpen(w.a.e.emp);
      const results = await Promise.all([run(rt, "a", "emp", `SELECT app_clock_in(NULL, NULL) AS id`), run(c2, "a", "emp", `SELECT app_clock_in(NULL, NULL) AS id`)]);
      expect(results.filter((r) => !r.error)).toHaveLength(1);
      expect(results.find((r) => r.error)!.error).toMatch(/already_clocked_in/);
      expect((await raw.query(`SELECT count(*)::int n FROM attendance_records WHERE employee_id = $1 AND status = 'OPEN'`, [w.a.e.emp])).rows[0].n).toBe(1);
      await ok("a", "emp", `SELECT app_clock_out(NULL, NULL)`);
    });

    it("never lets an exit and a clock-in interleave", async () => {
      const a = w.a;
      // Exit first, holding the employee row: the clock-in waits, then sees the employee has left (last day yesterday).
      const yesterday = (await raw.query(`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1)::text AS d`)).rows[0].d as string;
      await raw.query(`DELETE FROM attendance_records WHERE employee_id = $1 AND (clock_in_at AT TIME ZONE 'Asia/Kolkata')::date > $2::date`, [a.e.emp2, yesterday]);
      await c2.query("BEGIN");
      await c2.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`, [await pgSessionToken(raw, a.user.hr, a.org)]);
      await c2.query(`UPDATE employees SET status = 'EXITED', exited_on = $2::date WHERE id = $1`, [a.e.emp2, yesterday]);
      const pending = run(rt, "a", "emp2", `SELECT app_clock_in(NULL, NULL) AS id`);
      const early = await Promise.race([pending.then(() => "done"), new Promise((r) => setTimeout(() => r("waiting"), 300))]);
      expect(early).toBe("waiting");
      await c2.query("COMMIT");
      expect((await pending).error).toMatch(/employee_not_active/);
    });
  });
});
