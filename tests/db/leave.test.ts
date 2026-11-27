// Leave (CafeOS Milestone 3): migrations 20261123000000_leave and 20261123000100_leave_functions, against the
// DISPOSABLE test database only. As the app's restricted account through real session tokens (row-level security and
// function rights apply), plus maintenance mode for the daily job. Plan: docs/superpowers/plans/2026-11-21-leave.md.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/lib/db";
import { realRoleIds } from "./roles-helper";
import { pgSessionToken, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const maintenanceUrl = process.env.TEST_MAINTENANCE_URL; // the scheduled job's own account (hr_maintenance)
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl) && isTestDb(maintenanceUrl);
const rnd = () => randomBytes(4).toString("hex");
const TZ = "Asia/Kolkata";
type K = "a" | "b";
type Who = "sa" | "hr" | "emp" | "emp2";
type Emp = Who | "nologin";
type Result = { rows: Record<string, unknown>[]; error?: string };

describe.skipIf(!enabled)("leave (test database)", () => {
  let owner: Db;
  let raw: Client;
  let rt: Client;
  let mt: Client; // maintenance mode runs as the job's account, like the daily job
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const w = {} as Record<K, { org: string; user: Record<Who, string>; member: Record<Who, string>; outlet: string; e: Record<Emp, string>; type: Record<string, string> }>;
  let monday = ""; // a Monday 3+ weeks ahead whose week (Mon-Sun) stays in one year
  const d = (offset: number) => addDays(monday, offset);

  function addDays(day: string, n: number): string {
    const x = new Date(`${day}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  }

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 2 });
    raw = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    rt = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
    await raw.connect();
    await rt.connect();
    mt = new Client({ connectionString: maintenanceUrl, options: "-c TimeZone=UTC" });
    await mt.connect();
    // The test weeks (d(0) .. d(45)) must stay in one year and within 365 days: from 3 weeks ahead if that fits,
    // otherwise the second Monday of next January.
    monday = (await raw.query(`SELECT (CASE WHEN extract(year FROM m) = extract(year FROM m + 45) THEN m
        ELSE date_trunc('week', make_date(extract(year FROM t)::int + 1, 1, 14))::date END)::text AS d
      FROM (SELECT t, date_trunc('week', t + 21)::date AS m FROM (SELECT (now() AT TIME ZONE $1)::date AS t) y) x`, [TZ])).rows[0].d.slice(0, 10);
    const role = await realRoleIds(owner);
    const keyOf: Record<Who, "SUPER_ADMIN" | "HR_MANAGER" | "EMPLOYEE"> = { sa: "SUPER_ADMIN", hr: "HR_MANAGER", emp: "EMPLOYEE", emp2: "EMPLOYEE" };
    for (const k of ["a", "b"] as const) {
      const user = {} as Record<Who, string>;
      for (const who of ["sa", "hr", "emp", "emp2"] as const) {
        user[who] = (await owner.user.create({ data: { email: `${who}-${k}-${rnd()}@leave.example.test`, name: `${who.toUpperCase()} ${k}` } })).id;
        userIds.push(user[who]);
      }
      const org = await owner.organization.create({ data: { slug: `leave-${k}-${rnd()}${rnd()}`, name: `Leave ${k}`, ownerUserId: user.sa, timezone: TZ } });
      orgIds.push(org.id);
      const member = {} as Record<Who, string>;
      for (const who of ["sa", "hr", "emp", "emp2"] as const) {
        member[who] = (await owner.organizationMember.create({ data: { organizationId: org.id, userId: user[who], status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role[keyOf[who]] }] } } })).id;
      }
      const outlet = (await raw.query(`INSERT INTO outlets (organization_id, name, opening_time, changeover_time, closing_time, updated_at) VALUES ($1, 'Main', '08:00', '15:00', '23:00', now()) RETURNING id`, [org.id])).rows[0].id;
      const e = {} as Record<Emp, string>;
      for (const who of ["sa", "hr", "emp", "emp2", "nologin"] as const) {
        e[who] = (await raw.query(`INSERT INTO employees (organization_id, employee_code, full_name, joined_on, outlet_id, member_id, updated_at)
          VALUES ($1, $2, $3, '2026-01-01', $4, $5, now()) RETURNING id`, [org.id, `LV-${who}-${rnd()}`.toUpperCase(), `Person ${who} ${k}`, outlet, who === "nologin" ? null : member[who]])).rows[0].id;
      }
      // Employees work Monday to Saturday (Sunday off) on the morning standard; HR and SA have no standard.
      for (const who of ["emp", "emp2", "nologin"] as const) {
        await raw.query(`INSERT INTO employee_shift_patterns (organization_id, employee_id, standard_shift, work_days) VALUES ($1, $2, 'MORNING', '{1,2,3,4,5,6}')`, [org.id, e[who]]);
      }
      w[k] = { org: org.id, user, member, outlet, e, type: {} };
      // The five types are seeded with the organisation; cache their ids now so no test depends on running after another.
      for (const t of (await raw.query(`SELECT id, code FROM leave_types WHERE organization_id = $1`, [org.id])).rows) w[k].type[t.code] = t.id;
    }
  }, 90_000);

  afterAll(async () => {
    if (raw && orgIds.length) {
      for (const t of ["leave_requests", "attendance_correction_requests", "attendance_records", "shifts", "employee_shift_patterns", "holidays", "employee_assignments"]) {
        await raw.query(`DELETE FROM ${t} WHERE organization_id = ANY($1)`, [orgIds]).catch(() => undefined);
      }
      await raw.query(`DELETE FROM leave_ledger WHERE organization_id = ANY($1)`, [orgIds]).catch(() => undefined);
      await raw.query(`DELETE FROM employees WHERE organization_id = ANY($1)`, [orgIds]);
      await raw.query(`DELETE FROM leave_types WHERE organization_id = ANY($1)`, [orgIds]).catch(() => undefined);
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
    await mt?.end();
  });

  async function run(c: Client, k: K, who: Who | "public" | "maintenance", sql: string, params: unknown[] = []): Promise<Result> {
    if (who === "maintenance") c = mt;
    await c.query("BEGIN");
    try {
      if (who === "public") await c.query(`SELECT set_config('app.mode', 'public_apply', true), set_config('app.org_id', $1, true)`, [w[k].org]);
      else if (who === "maintenance") await c.query(`SELECT set_config('app.mode', 'maintenance', true)`);
      else await c.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`, [await pgSessionToken(raw, w[k].user[who], w[k].org)]);
      const r = await c.query(sql, params);
      await c.query("COMMIT");
      return { rows: r.rows };
    } catch (e) {
      await c.query("ROLLBACK");
      return { rows: [], error: (e as Error).message };
    }
  }
  const as = (k: K, who: Who | "public" | "maintenance", sql: string, params: unknown[] = []) => run(rt, k, who, sql, params);
  const ok = async (k: K, who: Who | "public" | "maintenance", sql: string, params: unknown[] = []) => {
    const r = await as(k, who, sql, params);
    expect(r.error, sql).toBeUndefined();
    return r.rows;
  };
  const typeId = async (k: K, code: string) => (await raw.query(`SELECT id FROM leave_types WHERE organization_id = $1 AND code = $2`, [w[k].org, code])).rows[0].id as string;
  const configure = (k: K, code: string, days: number, accrual = "YEARLY", carry = 0) =>
    ok(k, "hr", `UPDATE leave_types SET days_per_year = $3, accrual = $4, carry_over_max = $5, configured = true WHERE organization_id = $1 AND code = $2`, [w[k].org, code, days, accrual, carry]);
  const balance = async (k: K, who: Emp, code: string, year: number) =>
    Number((await raw.query(`SELECT COALESCE(sum(days), 0) AS b FROM leave_ledger WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`, [w[k].e[who], await typeId(k, code), year])).rows[0].b);
  const adjust = (k: K, who: Emp, code: string, year: number, days: number) =>
    ok(k, "sa", `SELECT app_adjust_leave($1, $2, $3, $4, 'Test balance')`, [w[k].e[who], w[k].type[code] ?? null, year, days]).then(async () => undefined);
  const request = (k: K, who: Who, code: string, start: string, end: string, startHalf = false, endHalf = false, note: string | null = null) =>
    typeIdCached(k, code).then((t) => as(k, who, `SELECT app_request_leave($1, $2::date, $3::date, $4, $5, $6) AS id`, [t, start, end, startHalf, endHalf, note]));
  async function typeIdCached(k: K, code: string) {
    if (!w[k].type[code]) w[k].type[code] = await typeId(k, code);
    return w[k].type[code]!;
  }
  // "Today" can be a weekly off (Sunday) for the test staff, so tests that need leave today make the person work every day.
  const workingEveryDay = async <T>(k: K, who: Emp, fn: () => Promise<T>) => {
    await raw.query(`UPDATE employee_shift_patterns SET work_days = '{1,2,3,4,5,6,7}' WHERE employee_id = $1`, [w[k].e[who]]);
    try { return await fn(); } finally {
      await raw.query(`UPDATE employee_shift_patterns SET work_days = '{1,2,3,4,5,6}' WHERE employee_id = $1`, [w[k].e[who]]);
    }
  };
  const req = async (id: unknown) => (await raw.query(`SELECT * FROM leave_requests WHERE id = $1`, [id])).rows[0];
  const year = () => Number(monday.slice(0, 4));

  // ---------------------------------------------------------------------------
  // Task 1: schema, rights, seeding
  // ---------------------------------------------------------------------------
  describe("leave schema", () => {
    it("seeds five unconfigured types per organisation and new organisations get them too", async () => {
      for (const k of ["a", "b"] as const) {
        const rows = (await raw.query(`SELECT code, configured, days_per_year::float AS d, paid FROM leave_types WHERE organization_id = $1 ORDER BY code`, [w[k].org])).rows;
        expect(rows.map((r) => r.code)).toEqual(["CL", "CO", "EL", "SL", "UL"]);
        for (const r of rows) {
          expect(r.d, r.code).toBe(0);
          expect(r.configured, r.code).toBe(r.code === "UL");
          expect(r.paid, r.code).toBe(r.code !== "UL");
        }
      }
      for (const code of ["CL", "CO", "EL", "SL", "UL"]) await typeIdCached("a", code);
      for (const code of ["CL", "CO", "EL", "SL", "UL"]) await typeIdCached("b", code);
    });

    it("lets HR manage types and holidays, everyone read them, nobody write the ledger or requests directly", async () => {
      const a = w.a;
      for (const sql of [
        `INSERT INTO leave_ledger (organization_id, employee_id, leave_type_id, year, kind, days, reason) VALUES ('${a.org}', '${a.e.emp}', '${a.type.CL}', 2026, 'ADJUSTMENT', 5, 'x')`,
        `UPDATE leave_ledger SET days = 99`,
        `DELETE FROM leave_ledger`,
        `INSERT INTO leave_requests (organization_id, employee_id, leave_type_id, start_day, end_day, days) VALUES ('${a.org}', '${a.e.emp}', '${a.type.CL}', '${monday}', '${monday}', 1)`,
        `UPDATE leave_requests SET status = 'APPROVED'`,
        `DELETE FROM leave_requests`,
      ]) for (const who of ["sa", "hr", "emp"] as const) expect((await as("a", who, sql)).error, `${who}: ${sql}`).toMatch(/permission denied/);
      // Holidays: HR adds, everyone in the organisation reads, an employee cannot add, another organisation sees none.
      await ok("a", "hr", `INSERT INTO holidays (organization_id, day, name) VALUES ($1, $2::date - 30, 'Test day')`, [a.org, monday]);
      expect((await as("a", "emp", `INSERT INTO holidays (organization_id, day, name) VALUES ($1, $2::date - 29, 'Mine')`, [a.org, monday])).error).toMatch(/row-level security/);
      expect((await ok("a", "emp", `SELECT count(*)::int AS n FROM holidays`))[0]!.n).toBeGreaterThan(0);
      expect((await ok("a", "emp", `SELECT count(*)::int AS n FROM leave_types`))[0]!.n).toBe(5);
      expect((await ok("b", "hr", `SELECT count(*)::int AS n FROM holidays WHERE organization_id = $1`, [a.org]))[0]!.n).toBe(0);
      expect((await ok("b", "hr", `SELECT count(*)::int AS n FROM leave_types WHERE organization_id = $1`, [a.org]))[0]!.n).toBe(0);
      expect((await as("a", "emp", `UPDATE leave_types SET days_per_year = 50 WHERE organization_id = $1`, [a.org])).rows).toEqual([]);
      expect((await raw.query(`SELECT max(days_per_year)::float AS m FROM leave_types WHERE organization_id = $1`, [a.org])).rows[0].m).toBe(0);
      expect((await as("a", "public", `SELECT count(*)::int AS n FROM leave_types`)).rows[0]?.n ?? 0).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Task 2: day count, requests, decisions, ledger
  // ---------------------------------------------------------------------------
  describe("leave requests and balances", () => {
    it("counts only working days: holidays and weekly offs are skipped, half days count 0.5", async () => {
      const a = w.a;
      await configure("a", "CL", 12);
      await adjust("a", "emp", "CL", year(), 10);
      await ok("a", "hr", `INSERT INTO holidays (organization_id, day, name) VALUES ($1, $2::date, 'Midweek holiday')`, [a.org, d(2)]);
      // Mon-Sun with a Wednesday holiday and Sunday off: 5 days. Starting at midday on Monday: 4.5.
      const full = await request("a", "emp", "CL", d(0), d(6));
      expect(full.error).toBeUndefined();
      expect(Number((await req(full.rows[0]!.id)).days)).toBe(5);
      await ok("a", "emp", `SELECT app_withdraw_leave($1)`, [full.rows[0]!.id]);
      const half = await request("a", "emp", "CL", d(0), d(6), true, false);
      expect(Number((await req(half.rows[0]!.id)).days)).toBe(4.5);
      await ok("a", "emp", `SELECT app_withdraw_leave($1)`, [half.rows[0]!.id]);
      // A request that is only a Sunday (weekly off) counts nothing and is refused.
      expect((await request("a", "emp", "CL", d(6), d(6))).error).toMatch(/leave_zero_days/);
    });

    it("counts a same-day half-day request as 0.5, not 1.0 (owner test 1)", async () => {
      const r = await request("a", "emp", "CL", d(0), d(0), true, false);
      expect(r.error).toBeUndefined();
      expect(Number((await req(r.rows[0]!.id)).days)).toBe(0.5);
      await ok("a", "hr", `SELECT app_decide_leave($1, true, NULL)`, [r.rows[0]!.id]);
      const taken = (await raw.query(`SELECT kind, days::float AS d FROM leave_ledger WHERE request_id = $1`, [r.rows[0]!.id])).rows;
      expect(taken).toEqual([{ kind: "TAKEN", d: -0.5 }]);
      await ok("a", "hr", `SELECT app_cancel_leave($1, 'Test cleanup')`, [r.rows[0]!.id]);
    });

    it("refuses paid leave beyond the available balance, counts pending requests, allows unpaid", async () => {
      const a = w.a;
      await configure("a", "SL", 6);
      await adjust("a", "emp2", "SL", year(), 2);
      expect((await request("a", "emp2", "SL", d(7), d(9))).error).toMatch(/leave_insufficient_balance/); // 3 > 2
      const first = await request("a", "emp2", "SL", d(7), d(7), false, true); // 0.5
      expect(first.error).toBeUndefined();
      const pend = await request("a", "emp2", "SL", d(8), d(8)); // 1.0 -> pending 1.5 of 2
      expect(pend.error).toBeUndefined();
      expect((await request("a", "emp2", "SL", d(9), d(9))).error).toMatch(/leave_insufficient_balance/); // 1.5 + 1 > 2
      const unpaid = await request("a", "emp2", "UL", d(10), d(12));
      expect(unpaid.error).toBeUndefined();
      // Not configured types cannot be used; overlapping active requests are refused.
      expect((await request("a", "emp2", "EL", d(14), d(14))).error).toMatch(/leave_type_not_configured/);
      expect((await request("a", "emp2", "UL", d(11), d(11))).error).toMatch(/leave_overlap/);
      for (const id of [first.rows[0]!.id, pend.rows[0]!.id, unpaid.rows[0]!.id]) await ok("a", "emp2", `SELECT app_withdraw_leave($1)`, [id]);
      void a;
    });

    it("approval writes TAKEN once, rejection needs a note, nobody approves their own leave unless sole approver", async () => {
      const a = w.a;
      const r = await request("a", "emp", "CL", d(7), d(8));
      expect((await as("a", "hr", `SELECT app_decide_leave($1, false, NULL)`, [r.rows[0]!.id])).error).toMatch(/decision_note_required/);
      await ok("a", "hr", `SELECT app_decide_leave($1, true, NULL)`, [r.rows[0]!.id]);
      expect((await raw.query(`SELECT kind, days::float AS d FROM leave_ledger WHERE request_id = $1`, [r.rows[0]!.id])).rows).toEqual([{ kind: "TAKEN", d: -2 }]);
      expect((await as("a", "hr", `SELECT app_decide_leave($1, true, NULL)`, [r.rows[0]!.id])).error).toMatch(/request_not_pending/);
      // HR's own request: refused while the SA can decide.
      await adjust("a", "hr", "CL", year(), 3);
      const own = await request("a", "hr", "CL", d(9), d(9));
      expect(own.error).toBeUndefined();
      expect((await as("a", "hr", `SELECT app_decide_leave($1, true, NULL)`, [own.rows[0]!.id])).error).toMatch(/own_request/);
      await ok("a", "hr", `SELECT app_withdraw_leave($1)`, [own.rows[0]!.id]);
      // The owner's own request: refused while HR can decide; allowed (and marked) once the owner is the only approver.
      // (An organisation always keeps one active Super Admin, so the sole approver in practice is the owner.)
      await adjust("a", "sa", "CL", year(), 3);
      const mine = await request("a", "sa", "CL", d(9), d(9));
      expect(mine.error).toBeUndefined();
      expect((await as("a", "sa", `SELECT app_decide_leave($1, true, NULL)`, [mine.rows[0]!.id])).error).toMatch(/own_request/);
      await raw.query(`UPDATE organization_members SET status = 'SUSPENDED' WHERE id = $1`, [a.member.hr]);
      try {
        await ok("a", "sa", `SELECT app_decide_leave($1, true, NULL)`, [mine.rows[0]!.id]);
        expect((await req(mine.rows[0]!.id)).self_decided).toBe(true);
      } finally {
        await raw.query(`UPDATE organization_members SET status = 'ACTIVE' WHERE id = $1`, [a.member.hr]);
      }
    });

    it("lets HR record leave for staff without a login", async () => {
      const a = w.a;
      await adjust("a", "nologin", "CL", year(), 4);
      const r = await ok("a", "hr", `SELECT app_hr_record_leave($1, $2, $3::date, $4::date, false, false, 'Paper form') AS id`, [a.e.nologin, a.type.CL, d(14), d(15)]);
      expect(await req(r[0]!.id)).toMatchObject({ status: "APPROVED", requested_by_id: a.user.hr, decided_by_id: a.user.hr });
      expect(await balance("a", "nologin", "CL", year())).toBe(2);
      // An employee cannot record leave for someone else.
      expect((await as("a", "emp", `SELECT app_hr_record_leave($1, $2, $3::date, $3::date, false, false, NULL)`, [a.e.nologin, a.type.CL, d(16)])).error).toMatch(/not allowed/);
    });

    it("restores only the days not yet taken when approved leave is cancelled (Review Focus 3)", async () => {
      const a = w.a;
      const today = (await raw.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d as string;
      const y = Number(today.slice(0, 4));
      // HR records CL with enough balance, from yesterday to tomorrow, kept inside this year (a request cannot cross
      // 31 December, so on 1 January it starts today and on 31 December it ends today).
      const start = (await raw.query(`SELECT GREATEST($1::date - 1, make_date($2, 1, 1))::text AS d`, [today, y])).rows[0].d as string;
      const end = (await raw.query(`SELECT LEAST($1::date + 1, make_date($2, 12, 31))::text AS d`, [today, y])).rows[0].d as string;
      await workingEveryDay("a", "emp2", async () => {
        await adjust("a", "emp2", "CL", y, 5);
        const rec = await as("a", "hr", `SELECT app_hr_record_leave($1, $2, $3::date, $4::date, false, false, NULL) AS id`, [a.e.emp2, a.type.CL, start, end]);
        expect(rec.error).toBeUndefined();
        const days = Number((await req(rec.rows[0]!.id)).days);
        // The employee can no longer cancel (it has started); HR can, and only today and later come back.
        expect((await as("a", "emp2", `SELECT app_cancel_leave($1, 'Changed plans')`, [rec.rows[0]!.id])).error).toMatch(/leave_already_started/);
        await ok("a", "hr", `SELECT app_cancel_leave($1, 'Came back early')`, [rec.rows[0]!.id]);
        const restored = Number((await raw.query(`SELECT COALESCE(sum(days), 0) AS r FROM leave_ledger WHERE request_id = $1 AND kind = 'RESTORED'`, [rec.rows[0]!.id])).rows[0].r);
        const pastDays = start < today ? (Date.parse(today) - Date.parse(start)) / 86_400_000 : 0; // every day is a working day here
        expect(restored).toBe(days - pastDays);
        expect((await req(rec.rows[0]!.id)).status).toBe("CANCELLED");
      });
    });

    it("grants yearly leave pro rata, accrues monthly once per counting month, and closes the year on 1 February", async () => {
      const b = w.b;
      await configure("b", "CL", 12, "YEARLY");
      await configure("b", "EL", 12, "MONTHLY", 5);
      // A joiner on 10 March (counts March, since employed on the 15th): 10 of 12 months.
      await raw.query(`UPDATE employees SET joined_on = '2026-03-10' WHERE id = $1`, [b.e.emp]);
      await ok("b", "maintenance", `SELECT app_leave_housekeeping('2026-03-20'::date)`);
      expect(await balance("b", "emp", "CL", 2026)).toBe(10);
      expect(await balance("b", "emp", "EL", 2026)).toBe(1); // March only
      await ok("b", "maintenance", `SELECT app_leave_housekeeping('2026-03-21'::date)`); // idempotent
      expect(await balance("b", "emp", "CL", 2026)).toBe(10);
      expect(await balance("b", "emp", "EL", 2026)).toBe(1);
      await ok("b", "maintenance", `SELECT app_leave_housekeeping('2026-11-01'::date)`);
      expect(await balance("b", "emp", "EL", 2026)).toBe(9); // March..November
      // Year close is tested for 2025 -> 2026 (p_today may only move back): a 2025 EL balance of 7, carry-over 5.
      await ok("b", "sa", `SELECT app_adjust_leave($1, $2, 2025, 7, 'Opening balance')`, [b.e.emp2, b.type.EL ?? (await typeIdCached("b", "EL"))]);
      await ok("b", "maintenance", `SELECT app_leave_housekeeping('2026-02-01'::date)`);
      const close = (await raw.query(`SELECT year, kind, days::float AS d FROM leave_ledger WHERE employee_id = $1 AND leave_type_id = $2 AND kind IN ('CARRY_OVER','EXPIRED') ORDER BY year`, [b.e.emp2, b.type.EL])).rows;
      expect(close).toEqual([{ year: 2025, kind: "EXPIRED", d: -7 }, { year: 2026, kind: "CARRY_OVER", d: 5 }]);
      await ok("b", "maintenance", `SELECT app_leave_housekeeping('2026-02-02'::date)`);
      expect((await raw.query(`SELECT count(*)::int n FROM leave_ledger WHERE employee_id = $1 AND kind IN ('CARRY_OVER','EXPIRED')`, [b.e.emp2])).rows[0].n).toBe(2);
      expect((await as("b", "hr", `SELECT app_leave_housekeeping(NULL)`)).error).toMatch(/permission denied for function app_leave_housekeeping/);
      expect((await as("b", "maintenance", `SELECT app_leave_housekeeping('2099-01-01'::date)`)).error).toMatch(/not allowed/);
    });

    it("keeps the stored count when a holiday is added after approval (Review Focus 4)", async () => {
      const a = w.a;
      await adjust("a", "emp", "CL", year(), 5);
      const r = await request("a", "emp", "CL", d(21), d(22));
      await ok("a", "hr", `SELECT app_decide_leave($1, true, NULL)`, [r.rows[0]!.id]);
      await ok("a", "hr", `INSERT INTO holidays (organization_id, day, name) VALUES ($1, $2::date, 'Late holiday')`, [a.org, d(22)]);
      expect(Number((await req(r.rows[0]!.id)).days)).toBe(2);
      expect((await raw.query(`SELECT days::float AS d FROM leave_ledger WHERE request_id = $1 AND kind = 'TAKEN'`, [r.rows[0]!.id])).rows[0].d).toBe(-2);
    });

    it("lets HR see the recount before deciding, and approves the current count (owner test 3)", async () => {
      const a = w.a;
      await adjust("a", "emp2", "CL", year(), 6);
      const r = await request("a", "emp2", "CL", d(28), d(32)); // Mon-Fri: 5
      expect(Number((await req(r.rows[0]!.id)).days)).toBe(5);
      await ok("a", "hr", `INSERT INTO holidays (organization_id, day, name) VALUES ($1, $2::date, 'New holiday')`, [a.org, d(30)]);
      const before = Number((await raw.query(`SELECT COALESCE(sum(days),0) b FROM leave_ledger WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`, [a.e.emp2, a.type.CL, year()])).rows[0].b);
      const p = (await ok("a", "hr", `SELECT stored_days::float, current_days::float, available::float, available_after::float FROM app_leave_preview($1)`, [r.rows[0]!.id]))[0]!;
      expect(p).toMatchObject({ stored_days: 5, current_days: 4, available_after: before - 4 });
      expect((await as("a", "emp2", `SELECT * FROM app_leave_preview($1)`, [r.rows[0]!.id])).error).toMatch(/not allowed/);
      await ok("a", "hr", `SELECT app_decide_leave($1, true, NULL)`, [r.rows[0]!.id]);
      expect(Number((await req(r.rows[0]!.id)).days)).toBe(4);
      expect((await raw.query(`SELECT days::float AS d FROM leave_ledger WHERE request_id = $1`, [r.rows[0]!.id])).rows).toEqual([{ d: -4 }]);
    });

    it("never changes history when a type's settings change or it is deactivated (owner test 4)", async () => {
      const b = w.b;
      const t = await typeIdCached("b", "SL");
      await configure("b", "SL", 12);
      await ok("b", "sa", `SELECT app_adjust_leave($1, $2, $3, 12, 'Grant')`, [b.e.emp, t, year()]);
      await adjust("b", "emp", "SL", year(), -2);
      const lines = (await raw.query(`SELECT id, kind, days::float FROM leave_ledger WHERE employee_id = $1 AND leave_type_id = $2 ORDER BY created_at`, [b.e.emp, t])).rows;
      await ok("b", "hr", `UPDATE leave_types SET days_per_year = 20, carry_over_max = 5 WHERE id = $1`, [t]);
      await ok("b", "hr", `UPDATE leave_types SET is_active = false WHERE id = $1`, [t]);
      expect(await balance("b", "emp", "SL", year())).toBe(10);
      expect((await raw.query(`SELECT id, kind, days::float FROM leave_ledger WHERE employee_id = $1 AND leave_type_id = $2 ORDER BY created_at`, [b.e.emp, t])).rows).toEqual(lines);
      expect((await request("b", "emp", "SL", d(7), d(7))).error).toMatch(/leave_type_inactive/);
      // Adjustments cannot push a paid balance below zero; a reason is required.
      expect((await as("b", "sa", `SELECT app_adjust_leave($1, $2, $3, -50, 'Too much')`, [b.e.emp, t, year()])).error).toMatch(/adjust_negative_balance/);
      expect((await as("b", "sa", `SELECT app_adjust_leave($1, $2, $3, 1, '  ')`, [b.e.emp, t, year()])).error).toMatch(/reason_required/);
      await ok("b", "hr", `UPDATE leave_types SET is_active = true WHERE id = $1`, [t]);
    });

    it("keeps each organisation's leave to itself and lets employees only use their own", async () => {
      const a = w.a;
      const anyReq = (await raw.query(`SELECT id FROM leave_requests WHERE organization_id = $1 LIMIT 1`, [a.org])).rows[0].id;
      for (const [sql, params] of [
        [`SELECT app_decide_leave($1, false, 'x')`, [anyReq]],
        [`SELECT app_cancel_leave($1, 'x')`, [anyReq]],
        [`SELECT * FROM app_leave_preview($1)`, [anyReq]],
        [`SELECT app_hr_record_leave($1, $2, $3::date, $3::date, false, false, NULL)`, [a.e.emp, a.type.CL, d(40)]],
        [`SELECT app_adjust_leave($1, $2, 2026, 1, 'x')`, [a.e.emp, a.type.CL]],
      ] as const) expect((await as("b", "hr", sql, [...params])).error, sql).toMatch(/not_found/);
      for (const t of ["leave_requests", "leave_ledger"]) {
        expect((await ok("b", "hr", `SELECT count(*)::int n FROM ${t} WHERE organization_id = $1`, [a.org]))[0]!.n, t).toBe(0);
        expect((await ok("a", "emp", `SELECT count(*)::int n FROM ${t} WHERE employee_id <> $1`, [a.e.emp]))[0]!.n, t).toBe(0);
      }
      expect((await as("a", "emp", `SELECT app_decide_leave($1, true, NULL)`, [anyReq])).error).toMatch(/not allowed/);
      expect((await as("a", "emp2", `SELECT app_withdraw_leave($1)`, [anyReq])).error).toMatch(/not_found|request_not_pending/);
      expect((await as("a", "public", `SELECT app_request_leave($1, $2::date, $2::date, false, false, NULL)`, [a.type.UL, d(40)])).error).toMatch(/not allowed/);
      expect((await as("a", "maintenance", `SELECT app_request_leave($1, $2::date, $2::date, false, false, NULL)`, [a.type.UL, d(40)])).error).toMatch(/permission denied for function app_request_leave/);
      // Dates: at most 31 days back, 365 ahead, and never across a year end.
      expect((await as("a", "emp", `SELECT app_request_leave($1, (now() AT TIME ZONE 'Asia/Kolkata')::date - 40, (now() AT TIME ZONE 'Asia/Kolkata')::date - 39, false, false, NULL)`, [a.type.UL])).error).toMatch(/leave_too_far_back/);
      expect((await as("a", "emp", `SELECT app_request_leave($1, (now() AT TIME ZONE 'Asia/Kolkata')::date + 400, (now() AT TIME ZONE 'Asia/Kolkata')::date + 400, false, false, NULL)`, [a.type.UL])).error).toMatch(/leave_too_far_ahead/);
      expect((await as("a", "emp", `SELECT app_request_leave($1, $2::date, $3::date, false, false, NULL)`, [a.type.UL, `${year()}-12-31`, `${year() + 1}-01-01`])).error).toMatch(/leave_crosses_year/);
      // A history row cannot be rewritten, even by the owner account.
      expect(await raw.query(`UPDATE leave_ledger SET days = 1 WHERE organization_id = $1`, [a.org]).then(() => "allowed", (e: Error) => e.message)).toMatch(/append-only/);
    });

    describe("two approvals at the same moment", () => {
      let c2: Client;
      beforeAll(async () => {
        c2 = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
        await c2.connect();
      });
      afterAll(async () => c2?.end());

      it("cannot overspend a balance (Review Focus 2)", async () => {
        await configure("b", "CL", 12);
        await adjust("b", "emp2", "CL", year(), 2);
        const r1 = await request("b", "emp2", "CL", d(35), d(35), false, true); // 0.5
        const r2 = await request("b", "emp2", "CL", d(36), d(36)); // 1.0 -> pending 1.5 of 2: both allowed
        expect([r1.error, r2.error]).toEqual([undefined, undefined]);
        // HR lowers the balance to 1, then two HR people approve both at once: only one fits.
        await adjust("b", "emp2", "CL", year(), -1);
        const results = await Promise.all([
          run(rt, "b", "hr", `SELECT app_decide_leave($1, true, NULL)`, [r1.rows[0]!.id]),
          run(c2, "b", "sa", `SELECT app_decide_leave($1, true, NULL)`, [r2.rows[0]!.id]),
        ]);
        expect(await balance("b", "emp2", "CL", year())).toBeGreaterThanOrEqual(0);
        expect(results.filter((x) => !x.error).length).toBeGreaterThanOrEqual(1);
        if (results.every((x) => !x.error)) throw new Error("both approved: overspent");
        expect(results.find((x) => x.error)!.error).toMatch(/leave_insufficient_balance/);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Task 3: attendance and rota
  // ---------------------------------------------------------------------------
  // These fill the rota several times (about 15 s alone); with other database files in parallel that can pass 30 s.
  describe("leave and attendance", { timeout: 90_000 }, () => {
    const shiftsOn = async (employeeId: string, day: string) =>
      (await raw.query(`SELECT id, status, source, cancel_reason FROM shifts WHERE employee_id = $1 AND (starts_at AT TIME ZONE $2)::date = $3::date ORDER BY created_at`, [employeeId, TZ, day])).rows;

    it("cancels shifts on full leave days, keeps half-day shifts, keeps the rota fill away, and refills after cancelling", async () => {
      const a = w.a;
      // Two working days in a row within the 14 days the standard rota fills, in one year: next Monday and Tuesday,
      // or Tuesday and Wednesday when that Monday is 31 December (a request cannot cross the year).
      const monNext = (await raw.query(`SELECT (date_trunc('week', (now() AT TIME ZONE $1)::date) + interval '7 days')::date::text AS d`, [TZ])).rows[0].d as string;
      const near = monNext.slice(0, 4) === addDays(monNext, 1).slice(0, 4) ? monNext : addDays(monNext, 1);
      const tue = addDays(near, 1);
      await ok("a", "hr", `SELECT app_apply_standard_shifts()`);
      expect((await shiftsOn(a.e.emp, near)).map((s) => s.status)).toEqual(["PLANNED"]);
      await adjust("a", "emp", "CL", Number(near.slice(0, 4)), 5);
      const r = await request("a", "emp", "CL", near, tue, false, true); // full Monday, half Tuesday
      expect(r.error).toBeUndefined();
      await ok("a", "hr", `SELECT app_decide_leave($1, true, NULL)`, [r.rows[0]!.id]);
      expect(await shiftsOn(a.e.emp, near)).toMatchObject([{ status: "CANCELLED", cancel_reason: "On leave" }]);
      expect((await shiftsOn(a.e.emp, tue)).map((s) => s.status)).toEqual(["PLANNED"]); // half day: kept
      await ok("a", "hr", `SELECT app_apply_standard_shifts()`);
      expect((await shiftsOn(a.e.emp, near)).map((s) => s.status)).toEqual(["CANCELLED"]); // not refilled
      await ok("a", "emp", `SELECT app_cancel_leave($1, 'Plans changed')`, [r.rows[0]!.id]);
      expect((await shiftsOn(a.e.emp, near)).map((s) => s.status)).toEqual(["CANCELLED", "PLANNED"]); // refilled at once
      await ok("a", "hr", `SELECT app_apply_standard_shifts()`);
      expect((await shiftsOn(a.e.emp, near)).map((s) => s.status)).toEqual(["CANCELLED", "PLANNED"]); // and only once
    });

    it("keeps the shift on a holiday inside leave and brings cancelled shifts back as soon as HR cancels the leave", async () => {
      const a = w.a;
      const monNext = (await raw.query(`SELECT (date_trunc('week', (now() AT TIME ZONE $1)::date) + interval '7 days')::date::text AS d`, [TZ])).rows[0].d as string;
      const near = monNext.slice(0, 4) === addDays(monNext, 1).slice(0, 4) ? monNext : addDays(monNext, 1);
      const next = addDays(near, 1);
      await ok("a", "hr", `SELECT app_apply_standard_shifts()`);
      await raw.query(`INSERT INTO holidays (organization_id, day, name) VALUES ($1, $2::date, 'Holiday inside leave')`, [a.org, near]);
      try {
        await configure("a", "CL", 12);
        await adjust("a", "emp2", "CL", Number(near.slice(0, 4)), 5);
        const r = await request("a", "emp2", "CL", near, next);
        expect(r.error).toBeUndefined();
        expect(Number((await req(r.rows[0]!.id)).days)).toBe(1); // the holiday is not charged
        await ok("a", "hr", `SELECT app_decide_leave($1, true, NULL)`, [r.rows[0]!.id]);
        expect((await shiftsOn(a.e.emp2, near)).map((s) => s.status)).toEqual(["PLANNED"]); // holiday: not cancelled for leave
        expect(await shiftsOn(a.e.emp2, next)).toMatchObject([{ status: "CANCELLED", cancel_reason: "On leave" }]);
        await ok("a", "hr", `SELECT app_cancel_leave($1, 'Plans changed')`, [r.rows[0]!.id]);
        expect((await shiftsOn(a.e.emp2, next)).map((s) => s.status)).toEqual(["CANCELLED", "PLANNED"]); // back at once
        expect((await shiftsOn(a.e.emp2, near)).map((s) => s.status)).toEqual(["PLANNED"]);
      } finally {
        await raw.query(`DELETE FROM holidays WHERE organization_id = $1 AND name = 'Holiday inside leave'`, [a.org]);
      }
    });

    it("does not count a weekly off inside leave as a day on leave", async () => {
      const a = w.a;
      // d(12) Saturday, d(13) Sunday (weekly off), d(14) Monday.
      await configure("a", "CL", 12);
      await adjust("a", "emp2", "CL", year(), 3);
      const r = await request("a", "emp2", "CL", d(12), d(14));
      expect(r.error).toBeUndefined();
      expect(Number((await req(r.rows[0]!.id)).days)).toBe(2);
      await ok("a", "hr", `SELECT app_decide_leave($1, true, NULL)`, [r.rows[0]!.id]);
      try {
        const onLeave = (await raw.query(`SELECT leave_on_full_leave($1, x::date) AS full_leave FROM unnest($2::text[]) AS x`, [a.e.emp2, [d(12), d(13), d(14)]])).rows.map((x) => x.full_leave);
        expect(onLeave).toEqual([true, false, true]);
      } finally {
        await ok("a", "hr", `SELECT app_cancel_leave($1, 'Test cleanup')`, [r.rows[0]!.id]);
      }
    });

    it("refuses clock-in on a full leave day", async () => {
      const a = w.a;
      const today = (await raw.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d as string;
      await adjust("a", "emp2", "UL", Number(today.slice(0, 4)), 0).catch(() => undefined);
      await workingEveryDay("a", "emp2", async () => {
        const rec = await ok("a", "hr", `SELECT app_hr_record_leave($1, $2, $3::date, $3::date, false, false, NULL) AS id`, [a.e.emp2, a.type.UL, today]);
        expect((await as("a", "emp2", `SELECT app_clock_in(NULL, NULL)`)).error).toMatch(/on_leave/);
        await ok("a", "hr", `SELECT app_cancel_leave($1, 'Test cleanup')`, [rec[0]!.id]);
      });
    });

    it("approving leave for someone already clocked in today leaves their shift, record and day intact (owner test 2, Review Focus 5)", async () => {
      const a = w.a;
      const today = (await raw.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d as string;
      await workingEveryDay("a", "hr", async () => {
        const shiftId = (await ok("a", "hr", `INSERT INTO shifts (organization_id, employee_id, outlet_id, starts_at, ends_at, updated_at)
          VALUES ($1, $2, $3, now() - interval '4 minutes', now() + interval '6 hours', now()) RETURNING id`, [a.org, a.e.hr, a.outlet]))[0]!.id;
        const recordId = (await ok("a", "hr", `SELECT app_clock_in('203.0.113.9', 'Phone') AS id`))[0]!.id;
        await adjust("a", "hr", "UL", Number(today.slice(0, 4)), 0).catch(() => undefined);
        const leave = await ok("a", "sa", `SELECT app_hr_record_leave($1, $2, $3::date, $3::date, false, false, 'Went home ill') AS id`, [a.e.hr, a.type.UL, today]);
        expect((await raw.query(`SELECT status FROM shifts WHERE id = $1`, [shiftId])).rows[0].status).toBe("PLANNED"); // started: not cancelled
        expect((await raw.query(`SELECT status, clock_out_at FROM attendance_records WHERE id = $1`, [recordId])).rows[0]).toMatchObject({ status: "OPEN", clock_out_at: null });
        expect((await raw.query(`SELECT count(*)::int n FROM leave_ledger WHERE request_id = $1`, [leave[0]!.id])).rows[0].n).toBe(1);
        expect((await as("a", "hr", `SELECT app_clock_out(NULL, NULL) AS s`)).rows[0]?.s).toBe("closed");
        await ok("a", "sa", `SELECT app_cancel_leave($1, 'Test cleanup')`, [leave[0]!.id]);
      });
    });

    it("keeps the approved clock-in location behaviour: from anywhere, outlet from the shift or home, device recorded (owner test 6)", async () => {
      const a = w.a;
      const id = (await ok("a", "emp", `SELECT app_clock_in('198.51.100.77', 'Any phone') AS id`))[0]!.id;
      const rec = (await raw.query(`SELECT outlet_id, in_ip, in_user_agent, status FROM attendance_records WHERE id = $1`, [id])).rows[0];
      expect(rec).toMatchObject({ outlet_id: a.outlet, in_ip: "198.51.100.77", in_user_agent: "Any phone", status: "OPEN" });
      await ok("a", "emp", `SELECT app_clock_out(NULL, NULL)`);
    });

    it("cancels future approved leave and withdraws pending leave when someone leaves", async () => {
      const b = w.b;
      await adjust("b", "emp", "CL", year(), 5);
      const approved = await request("b", "emp", "CL", d(42), d(42));
      await ok("b", "hr", `SELECT app_decide_leave($1, true, NULL)`, [approved.rows[0]!.id]);
      const pending = await request("b", "emp", "CL", d(43), d(43));
      const before = await balance("b", "emp", "CL", year());
      await ok("b", "hr", `UPDATE employees SET status = 'EXITED', exited_on = $2::date WHERE id = $1`, [b.e.emp, d(40)]);
      expect((await req(approved.rows[0]!.id)).status).toBe("CANCELLED");
      expect((await req(pending.rows[0]!.id)).status).toBe("WITHDRAWN");
      expect(await balance("b", "emp", "CL", year())).toBe(before + 1);
    });
  });

  // -------------------------------------------------------------------------
  // Final review fixes (migration 20261123000300_leave_review_fixes)
  // -------------------------------------------------------------------------
  describe("review fixes", { timeout: 90_000 }, () => {
    it("returns exactly the days charged for today and later when partly-past leave is cancelled, whatever changed since", async () => {
      const a = w.a;
      const today = (await raw.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d as string;
      const y = Number(today.slice(0, 4));
      // Two days back and one ahead, kept inside this year (only 1 and 2 January lose the past part).
      const start = (await raw.query(`SELECT GREATEST($1::date - 2, make_date($2, 1, 1))::text AS d`, [today, y])).rows[0].d as string;
      const end = (await raw.query(`SELECT LEAST($1::date + 1, make_date($2, 12, 31))::text AS d`, [today, y])).rows[0].d as string;
      await configure("a", "CL", 12);
      await typeIdCached("a", "CL");
      await workingEveryDay("a", "emp2", async () => {
        await adjust("a", "emp2", "CL", y, 6);
        const rec = await ok("a", "hr", `SELECT app_hr_record_leave($1, $2, $3::date, $4::date, false, false, NULL) AS id`, [a.e.emp2, a.type.CL, start, end]);
        const id = rec[0]!.id;
        const charged = Number((await req(id)).days);
        const future = (Date.parse(end) - Date.parse(today)) / 86_400_000 + 1; // every day is a working day here
        // After approval HR adds a holiday on the first (past) leave day and changes the standard: neither may change
        // what was charged for the days already passed.
        await raw.query(`INSERT INTO holidays (organization_id, day, name) VALUES ($1, $2::date, 'Added later')`, [a.org, start]);
        try {
          await ok("a", "hr", `SELECT app_cancel_leave($1, 'Came back early')`, [id]);
        } finally {
          await raw.query(`DELETE FROM holidays WHERE organization_id = $1 AND day = $2::date AND name = 'Added later'`, [a.org, start]);
        }
        const lines = (await raw.query(`SELECT kind, days::float AS d FROM leave_ledger WHERE request_id = $1 ORDER BY kind`, [id])).rows;
        expect(lines).toEqual([{ kind: "TAKEN", d: -charged }, { kind: "RESTORED", d: future }]); // enum order
      });
    });

    it("carries a comp-off (no accrual) balance into the new year instead of expiring it on 1 February", async () => {
      await configure("a", "CO", 0, "NONE", 0);
      await typeIdCached("a", "CO");
      await adjust("a", "emp", "CO", 2025, 3);
      await ok("a", "maintenance", `SELECT app_leave_housekeeping('2026-02-02'::date)`);
      expect(await balance("a", "emp", "CO", 2025)).toBe(0);
      expect(await balance("a", "emp", "CO", 2026)).toBe(3);
      const carry = (await raw.query(`SELECT days::float AS d FROM leave_ledger WHERE employee_id = $1 AND leave_type_id = $2 AND kind = 'CARRY_OVER' AND year = 2026`, [w.a.e.emp, w.a.type.CO])).rows;
      expect(carry).toEqual([{ d: 3 }]);
    });

    it("keeps a shift the person has already clocked into early when leave for today is approved (Review Focus 5)", async () => {
      const b = w.b;
      const today = (await raw.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d as string;
      // Leave today and tomorrow, so the shift starting in an hour is on a leave day even late in the evening
      // (only 31 December after 23:00 is not covered: a request cannot cross the year).
      const end = (await raw.query(`SELECT LEAST($1::date + 1, make_date(extract(year FROM $1::date)::int, 12, 31))::text AS d`, [today])).rows[0].d as string;
      await workingEveryDay("b", "sa", async () => {
        const shiftId = (await raw.query(`INSERT INTO shifts (organization_id, employee_id, outlet_id, starts_at, ends_at, updated_at)
          VALUES ($1, $2, $3, now() + interval '1 hour', now() + interval '5 hours', now()) RETURNING id`, [b.org, b.e.sa, b.outlet])).rows[0].id;
        const recordId = (await ok("b", "sa", `SELECT app_clock_in(NULL, NULL) AS id`))[0]!.id;
        expect((await raw.query(`SELECT shift_id FROM attendance_records WHERE id = $1`, [recordId])).rows[0].shift_id).toBe(shiftId);
        const leave = await ok("b", "hr", `SELECT app_hr_record_leave($1, $2, $3::date, $4::date, false, false, 'Went home ill') AS id`, [b.e.sa, await typeIdCached("b", "UL"), today, end]);
        try {
          expect((await raw.query(`SELECT status FROM shifts WHERE id = $1`, [shiftId])).rows[0].status).toBe("PLANNED");
        } finally {
          await ok("b", "hr", `SELECT app_cancel_leave($1, 'Test cleanup')`, [leave[0]!.id]);
          await ok("b", "sa", `SELECT app_clock_out(NULL, NULL)`);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // Who is off, for staff (migration 20261123000400_who_is_off_for_staff, owner decision 22 Nov 2026)
  // -------------------------------------------------------------------------
  describe("who is off for staff", { timeout: 90_000 }, () => {
    it("shows every member approved leave of their own organisation with names and dates only", async () => {
      const a = w.a;
      const b = w.b;
      const approved = await ok("a", "hr", `SELECT app_hr_record_leave($1, $2, $3::date, $4::date, true, false, 'Private reason') AS id`, [a.e.emp2, await typeIdCached("a", "UL"), d(25), d(26)]);
      const pending = await request("a", "emp", "UL", d(26), d(26), false, false, "Another private reason");
      expect(pending.error).toBeUndefined();
      const other = await ok("b", "hr", `SELECT app_hr_record_leave($1, $2, $3::date, $3::date, false, false, NULL) AS id`, [b.e.emp2, await typeIdCached("b", "UL"), d(25)]);
      try {
        const rows = (await ok("a", "emp", `SELECT * FROM app_who_is_off($1::date, $2::date)`, [d(24), d(27)]));
        // Exactly these columns: no leave type (it can reveal sick leave), no note, no days balance, no status.
        expect(rows).toEqual([{ employee_id: a.e.emp2, employee_name: "Person emp2 a", start_day: expect.any(Date), end_day: expect.any(Date), start_half: true, end_half: false }]);
        // Pending requests and other organisations never show; neither do people outside the range.
        expect(await ok("a", "emp", `SELECT * FROM app_who_is_off($1::date, $1::date)`, [d(27)])).toEqual([]);
        expect((await ok("b", "emp", `SELECT employee_id FROM app_who_is_off($1::date, $2::date)`, [d(24), d(27)])).map((r) => r.employee_id)).toEqual([b.e.emp2]);
        // Not signed in: nothing; ranges longer than two months are refused.
        expect((await as("a", "public", `SELECT * FROM app_who_is_off($1::date, $2::date)`, [d(24), d(27)])).error).toMatch(/not allowed/);
        expect((await as("a", "emp", `SELECT * FROM app_who_is_off($1::date, $1::date + 63)`, [d(0)])).error).toMatch(/leave_bad_period/);
      } finally {
        await ok("a", "hr", `SELECT app_cancel_leave($1, 'Test cleanup')`, [approved[0]!.id]);
        await ok("a", "emp", `SELECT app_withdraw_leave($1)`, [pending.rows[0]!.id]);
        await ok("b", "hr", `SELECT app_cancel_leave($1, 'Test cleanup')`, [other[0]!.id]);
      }
    });
  });
});
