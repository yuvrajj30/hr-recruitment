// Standard shifts and shift history (migration 20261122000400), against the DISPOSABLE test database only.
// As the app's restricted account through real session tokens, plus the maintenance-mode daily job.
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
type Who = "hr" | "emp";

// Each test fills the rota several times (about 15 s alone); with other database files in parallel that can pass 30 s.
describe.skipIf(!enabled)("standard shifts and shift history (test database)", { timeout: 90_000 }, () => {
  let owner: Db;
  let raw: Client;
  let rt: Client;
  let mt: Client; // maintenance mode runs as the job's account, like the daily job
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const w = {} as Record<K, { org: string; user: Record<Who, string>; outlet: string; late: string; e: Record<"morning" | "evening" | "emp", string> }>;

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 2 });
    raw = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    rt = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
    await raw.connect();
    await rt.connect();
    mt = new Client({ connectionString: maintenanceUrl, options: "-c TimeZone=UTC" });
    await mt.connect();
    const role = await realRoleIds(owner);
    for (const k of ["a", "b"] as const) {
      const user = {} as Record<Who, string>;
      for (const who of ["hr", "emp"] as const) {
        user[who] = (await owner.user.create({ data: { email: `${who}-${k}-${rnd()}@std.example.test`, name: `${who} ${k}` } })).id;
        userIds.push(user[who]);
      }
      const org = await owner.organization.create({ data: { slug: `std-${k}-${rnd()}${rnd()}`, name: `Standard ${k}`, ownerUserId: user.hr, timezone: TZ } });
      orgIds.push(org.id);
      const member = {} as Record<Who, string>;
      for (const who of ["hr", "emp"] as const) {
        member[who] = (await owner.organizationMember.create({ data: { organizationId: org.id, userId: user[who], status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role[who === "hr" ? "HR_MANAGER" : "EMPLOYEE"] }] } } })).id;
      }
      const outlet = (await raw.query(`INSERT INTO outlets (organization_id, name, updated_at) VALUES ($1, 'Day outlet', now()) RETURNING id`, [org.id])).rows[0].id;
      const late = (await raw.query(`INSERT INTO outlets (organization_id, name, updated_at) VALUES ($1, 'Midnight outlet', now()) RETURNING id`, [org.id])).rows[0].id;
      const e = {} as Record<"morning" | "evening" | "emp", string>;
      for (const [key, home, m] of [["morning", outlet, null], ["evening", late, null], ["emp", outlet, member.emp]] as const) {
        e[key] = (await raw.query(`INSERT INTO employees (organization_id, employee_code, full_name, joined_on, outlet_id, member_id, updated_at)
          VALUES ($1, $2, $3, '2026-01-01', $4, $5, now()) RETURNING id`, [org.id, `ST-${key}-${rnd()}`.toUpperCase(), `${key} ${k}`, home, m])).rows[0].id;
      }
      w[k] = { org: org.id, user, outlet, late, e };
    }
  }, 90_000);

  afterAll(async () => {
    if (raw && orgIds.length) {
      await raw.query(`DELETE FROM attendance_records WHERE organization_id = ANY($1)`, [orgIds]);
      await raw.query(`DELETE FROM shifts WHERE organization_id = ANY($1)`, [orgIds]); // history cascades
      await raw.query(`DELETE FROM employee_shift_patterns WHERE organization_id = ANY($1)`, [orgIds]);
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
    await mt?.end();
  });

  async function as(k: K, who: Who | "maintenance", sql: string, params: unknown[] = []) {
    const c = who === "maintenance" ? mt : rt;
    await c.query("BEGIN");
    try {
      if (who === "maintenance") await c.query(`SELECT set_config('app.mode', 'maintenance', true)`);
      else await c.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`, [await pgSessionToken(raw, w[k].user[who], w[k].org)]);
      const r = await c.query(sql, params);
      await c.query("COMMIT");
      return { rows: r.rows as Record<string, unknown>[], error: undefined as string | undefined };
    } catch (e) {
      await c.query("ROLLBACK");
      return { rows: [] as Record<string, unknown>[], error: (e as Error).message };
    }
  }
  const ok = async (k: K, who: Who | "maintenance", sql: string, params: unknown[] = []) => {
    const r = await as(k, who, sql, params);
    expect(r.error, sql).toBeUndefined();
    return r.rows;
  };
  const localDate = async (offsetDays: number) => (await raw.query(`SELECT ((now() AT TIME ZONE $1)::date + $2::int)::text AS d`, [TZ, offsetDays])).rows[0].d as string;
  const shiftsOn = async (employeeId: string, day: string) =>
    (await raw.query(`SELECT id, status, source, standard_shift, edited, cancel_reason, break_minutes, outlet_id,
        to_char(starts_at AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS s, to_char(ends_at AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS e
      FROM shifts WHERE employee_id = $1 AND (starts_at AT TIME ZONE $3)::date = $2::date ORDER BY created_at`, [employeeId, day, TZ])).rows;
  const history = async (shiftId: string) => (await raw.query(`SELECT kind, changed_by_id, before, after FROM shift_changes WHERE shift_id = $1 ORDER BY created_at`, [shiftId])).rows;

  it("fills two weeks of the rota from outlet hours and each employee's standard, including a midnight close", async () => {
    const a = w.a;
    await ok("a", "hr", `UPDATE outlets SET opening_time = '08:00', changeover_time = '15:00', closing_time = '23:00', shift_break_minutes = 30 WHERE id = $1`, [a.outlet]);
    await ok("a", "hr", `UPDATE outlets SET opening_time = '09:00', changeover_time = '16:00', closing_time = '00:00', shift_break_minutes = 30 WHERE id = $1`, [a.late]);
    expect((await as("a", "hr", `UPDATE outlets SET opening_time = '15:00', changeover_time = '08:00', closing_time = '23:00' WHERE id = $1`, [a.outlet])).error).toMatch(/outlets_hours_check/);
    // Morning: every day. Evening at the midnight outlet: weekdays only.
    await ok("a", "hr", `INSERT INTO employee_shift_patterns (organization_id, employee_id, standard_shift, work_days) VALUES ($1, $2, 'MORNING', '{7,1,2,3,4,5,6,1}')`, [a.org, a.e.morning]);
    await ok("a", "hr", `INSERT INTO employee_shift_patterns (organization_id, employee_id, standard_shift, work_days) VALUES ($1, $2, 'EVENING', '{1,2,3,4,5}')`, [a.org, a.e.evening]);
    expect((await raw.query(`SELECT work_days FROM employee_shift_patterns WHERE employee_id = $1`, [a.e.morning])).rows[0].work_days).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const created = Number((await ok("a", "hr", `SELECT app_apply_standard_shifts() AS n`))[0]!.n);
    expect(created).toBeGreaterThanOrEqual(13 + 9); // today's morning may already have started
    const tomorrow = await localDate(1);
    expect(await shiftsOn(a.e.morning, tomorrow)).toMatchObject([{ status: "PLANNED", source: "STANDARD", standard_shift: "MORNING", edited: false, break_minutes: 30, s: `${tomorrow} 08:00`, e: `${tomorrow} 15:00` }]);
    // The evening shift at the midnight outlet ends at 00:00 the next day; weekends are free.
    const weekday = (await raw.query(`SELECT d::text FROM generate_series((now() AT TIME ZONE $1)::date + 1, (now() AT TIME ZONE $1)::date + 7, interval '1 day') d
      WHERE extract(isodow FROM d) BETWEEN 1 AND 5 LIMIT 1`, [TZ])).rows[0].d.slice(0, 10) as string;
    const next = (await raw.query(`SELECT ($1::date + 1)::text AS d`, [weekday])).rows[0].d as string;
    expect(await shiftsOn(a.e.evening, weekday)).toMatchObject([{ standard_shift: "EVENING", s: `${weekday} 16:00`, e: `${next} 00:00` }]);
    const sunday = (await raw.query(`SELECT d::text FROM generate_series((now() AT TIME ZONE $1)::date + 1, (now() AT TIME ZONE $1)::date + 7, interval '1 day') d
      WHERE extract(isodow FROM d) = 7`, [TZ])).rows[0].d.slice(0, 10) as string;
    expect(await shiftsOn(a.e.evening, sunday)).toEqual([]);
    // Running it again adds nothing; the system's shifts have a history row with no person.
    expect(Number((await ok("a", "hr", `SELECT app_apply_standard_shifts() AS n`))[0]!.n)).toBe(0);
    const s = (await shiftsOn(a.e.morning, tomorrow))[0]!;
    expect(await history(s.id)).toMatchObject([{ kind: "CREATED", changed_by_id: null, before: null }]);
  });

  it("marks a standard shift changed by a person, records before and after, and never overwrites it", async () => {
    const a = w.a;
    const day = await localDate(2);
    const s = (await shiftsOn(a.e.morning, day))[0]!;
    await ok("a", "hr", `UPDATE shifts SET ends_at = ends_at + interval '1 hour', note = 'Stock delivery' WHERE id = $1`, [s.id]);
    expect((await shiftsOn(a.e.morning, day))[0]).toMatchObject({ edited: true, source: "STANDARD", e: `${day} 16:00` });
    const h = await history(s.id);
    expect(h.at(-1)).toMatchObject({ kind: "CHANGED", changed_by_id: a.user.hr });
    expect(h.at(-1)!.before).toMatchObject({ note: null, edited: false });
    expect(h.at(-1)!.after).toMatchObject({ note: "Stock delivery", edited: true });
    expect(new Date(h.at(-1)!.after.ends_at).getTime() - new Date(h.at(-1)!.before.ends_at).getTime()).toBe(3600_000);
    // The standard moves (outlet opens later): untouched days follow, the changed day keeps HR's times.
    await ok("a", "hr", `UPDATE outlets SET opening_time = '09:00' WHERE id = $1`, [a.outlet]);
    await ok("a", "hr", `SELECT app_apply_standard_shifts()`);
    expect((await shiftsOn(a.e.morning, day))[0]).toMatchObject({ s: `${day} 08:00`, e: `${day} 16:00`, edited: true });
    const other = await localDate(3);
    const moved = (await shiftsOn(a.e.morning, other))[0]!;
    expect(moved).toMatchObject({ s: `${other} 09:00`, edited: false });
    expect((await history(moved.id)).at(-1)).toMatchObject({ kind: "CHANGED", changed_by_id: null });
    // People cannot create STANDARD shifts or reset the mark.
    const tryInsert = await as("a", "hr", `INSERT INTO shifts (organization_id, employee_id, outlet_id, starts_at, ends_at, source, standard_shift, edited, updated_at)
      VALUES ($1, $2, $3, now() + interval '20 days', now() + interval '20 days 4 hours', 'STANDARD', 'MORNING', false, now()) RETURNING source, standard_shift`, [a.org, a.e.emp, a.outlet]);
    expect(tryInsert.rows[0]).toEqual({ source: "MANUAL", standard_shift: null });
    expect((await as("a", "hr", `UPDATE shifts SET edited = false WHERE id = $1`, [s.id])).error).toMatch(/permission denied/);
  });

  it("cancels generated days that are no longer worked, and works them again when they are", async () => {
    const a = w.a;
    const day = await localDate(5);
    const dow = Number((await raw.query(`SELECT extract(isodow FROM $1::date)::int AS d`, [day])).rows[0].d);
    const before = (await shiftsOn(a.e.morning, day))[0]!;
    const without = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== dow);
    await ok("a", "hr", `UPDATE employee_shift_patterns SET work_days = $2 WHERE employee_id = $1`, [a.e.morning, without]);
    await ok("a", "hr", `SELECT app_apply_standard_shifts()`);
    expect((await shiftsOn(a.e.morning, day))[0]).toMatchObject({ id: before.id, status: "CANCELLED", cancel_reason: "No longer in the standard rota", edited: false });
    await ok("a", "hr", `UPDATE employee_shift_patterns SET work_days = '{1,2,3,4,5,6,7}' WHERE employee_id = $1`, [a.e.morning]);
    await ok("a", "hr", `SELECT app_apply_standard_shifts()`);
    const now = await shiftsOn(a.e.morning, day);
    expect(now.map((s) => s.status)).toEqual(["CANCELLED", "PLANNED"]);
    // A shift HR planned by hand on a day keeps the standard away from that day.
    const handDay = await localDate(15);
    await ok("a", "hr", `INSERT INTO shifts (organization_id, employee_id, outlet_id, starts_at, ends_at, updated_at)
      VALUES ($1, $2, $3, ($4::date + time '12:00') AT TIME ZONE $5, ($4::date + time '18:00') AT TIME ZONE $5, now())`, [a.org, a.e.emp, a.outlet, handDay, TZ]);
    await ok("a", "hr", `INSERT INTO employee_shift_patterns (organization_id, employee_id, standard_shift, work_days) VALUES ($1, $2, 'MORNING', '{1,2,3,4,5,6,7}')`, [a.org, a.e.emp]);
    // (day 15 is beyond the 14 days of app_apply; the daily job with 16 days ahead reaches it)
    await ok("a", "maintenance", `SELECT app_generate_standard_shifts(16)`);
    expect((await shiftsOn(a.e.emp, handDay)).map((s) => s.source)).toEqual(["MANUAL"]);
    expect((await shiftsOn(a.e.emp, await localDate(14))).map((s) => s.source)).toEqual(["STANDARD"]);
  });

  it("keeps a moved standard shift as that day's, keeps the notice period, and limits outlet hours (fixes in 20261122000500)", async () => {
    const a = w.a;
    // HR moves tomorrow-plus-6's evening shift to start after midnight: the original day stays covered.
    const day = await localDate(6);
    const before = await shiftsOn(a.e.evening, day);
    if (before.length) {
      await ok("a", "hr", `UPDATE shifts SET starts_at = starts_at + interval '9 hours', ends_at = ends_at + interval '9 hours' WHERE id = $1`, [before[0]!.id]);
      await ok("a", "hr", `SELECT app_apply_standard_shifts()`);
      expect(await shiftsOn(a.e.evening, day)).toEqual([]);
      expect((await raw.query(`SELECT count(*)::int n FROM shifts WHERE employee_id = $1 AND standard_day = $2::date`, [a.e.evening, day])).rows[0].n).toBe(1);
    }
    // Someone leaving in 3 days keeps their standard shifts until then; after that they are cancelled.
    const lastDay = await localDate(3);
    await ok("a", "hr", `UPDATE employees SET status = 'EXITED', exited_on = $2::date WHERE id = $1`, [a.e.morning, lastDay]);
    await ok("a", "hr", `SELECT app_apply_standard_shifts()`);
    expect((await shiftsOn(a.e.morning, lastDay)).map((s) => s.status)).toContain("PLANNED");
    const after = await shiftsOn(a.e.morning, await localDate(4));
    expect(after.every((s) => s.status === "CANCELLED")).toBe(true);
    // The database refuses outlet hours that would make a shift longer than 16 hours.
    expect((await as("a", "hr", `UPDATE outlets SET opening_time = '06:00', changeover_time = '23:00', closing_time = '23:30' WHERE id = $1`, [a.outlet])).error).toMatch(/outlets_hours_length_check/);
    expect((await as("a", "hr", `UPDATE outlets SET opening_time = '06:00', changeover_time = '07:00', closing_time = '05:00' WHERE id = $1`, [a.outlet])).error).toMatch(/outlets_hours_length_check/);
  });

  it("keeps standards, rota changes and history to HR of the same organisation", async () => {
    const a = w.a;
    const anyShift = (await shiftsOn(a.e.morning, await localDate(2)))[0]!.id;
    // The employee sees their own standard, never shift history; another organisation sees nothing.
    expect((await ok("a", "emp", `SELECT count(*)::int AS n FROM employee_shift_patterns`))[0]!.n).toBe(1);
    expect((await ok("a", "emp", `SELECT count(*)::int AS n FROM shift_changes`))[0]!.n).toBe(0);
    for (const t of ["employee_shift_patterns", "shift_changes"]) expect((await ok("b", "hr", `SELECT count(*)::int AS n FROM ${t} WHERE organization_id = $1`, [a.org]))[0]!.n, t).toBe(0);
    expect((await as("a", "emp", `INSERT INTO employee_shift_patterns (organization_id, employee_id, standard_shift, work_days) VALUES ($1, $2, 'EVENING', '{1}')`, [a.org, a.e.evening])).error).toMatch(/row-level security|duplicate/);
    expect((await as("a", "emp", `SELECT app_apply_standard_shifts()`)).error).toMatch(/not allowed/);
    // (an employee of A without a standard, so nothing but the organisation key can refuse it)
    const bare = (await raw.query(`INSERT INTO employees (organization_id, employee_code, full_name, joined_on, updated_at) VALUES ($1, $2, 'No standard', '2026-01-01', now()) RETURNING id`,
      [a.org, `ST-BARE-${rnd()}`.toUpperCase()])).rows[0].id;
    expect((await as("b", "hr", `INSERT INTO employee_shift_patterns (organization_id, employee_id, standard_shift, work_days) VALUES ($1, $2, 'EVENING', '{1}')`, [w.b.org, bare])).error).toMatch(/employee_shift_patterns_employee_fkey/);
    // Applying B's standard never touches A's rota; the daily job is maintenance-only; the history is append-only.
    const countA = Number((await raw.query(`SELECT count(*)::int n FROM shifts WHERE organization_id = $1`, [a.org])).rows[0].n);
    await ok("b", "hr", `SELECT app_apply_standard_shifts()`);
    expect(Number((await raw.query(`SELECT count(*)::int n FROM shifts WHERE organization_id = $1`, [a.org])).rows[0].n)).toBe(countA);
    expect((await as("a", "hr", `SELECT app_generate_standard_shifts(14)`)).error).toMatch(/permission denied for function app_generate_standard_shifts/);
    expect((await as("a", "hr", `UPDATE shift_changes SET kind = 'CREATED' WHERE shift_id = $1`, [anyShift])).error).toMatch(/permission denied/);
    expect(await raw.query(`UPDATE shift_changes SET after = '{}' WHERE shift_id = $1`, [anyShift]).then(() => "allowed", (e: Error) => e.message)).toMatch(/append-only/);
  });
});
