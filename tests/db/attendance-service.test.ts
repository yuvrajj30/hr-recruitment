// Attendance through the service layer (src/lib/attendance/attendance.ts), against the DISPOSABLE test database.
// The database rules themselves are covered in attendance.test.ts; this checks what the screens rely on: Prisma's
// writes fit the narrow column rights, refusals become messages for people, permissions are checked before the
// database is asked, and the HR views group and flag correctly.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AttendanceDeps, clockIn, clockOut, confirmShift, copyWeek, createShift, getDay, getMyAttendance, getRecord, getRota, hrCorrect, hrRecord,
  listRequests, requestCorrection, takeBreak, updateShift, cancelShift, decideRequest, getStandards, setOutletHours, setEmployeeStandard,
  getShiftHistory,
} from "@/lib/attendance/attendance";
import { dayRange, localDay, weekStart, addDays } from "@/lib/attendance/rules";
import type { AuthContext } from "@/lib/auth/context";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createDb, type Db } from "@/lib/db";
import { realRoleIds } from "./roles-helper";
import { giveSession, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");
const TZ = "Asia/Kolkata";
type Who = "hr" | "emp" | "other";

describe.skipIf(!enabled)("attendance service (test database)", () => {
  let owner: Db;
  let db: Db;
  let raw: Client;
  let org = "";
  let outlet = "";
  const userIds: string[] = [];
  const ctx = {} as Record<Who, AuthContext>;
  const emp = {} as Record<Who | "nologin", string>;
  let deps: AttendanceDeps;

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 2 });
    db = createDb(runtimeUrl!, { max: 3 });
    raw = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    await raw.connect();
    const role = await realRoleIds(owner);
    const keyOf: Record<Who, RoleKey> = { hr: "HR_MANAGER", emp: "EMPLOYEE", other: "EMPLOYEE" };
    const users = {} as Record<Who, { id: string; email: string; name: string }>;
    for (const who of ["hr", "emp", "other"] as const) {
      users[who] = await owner.user.create({ data: { email: `${who}-${rnd()}@attsvc.example.test`, name: `${who} person` } });
      userIds.push(users[who].id);
    }
    const o = await owner.organization.create({ data: { slug: `attsvc-${rnd()}${rnd()}`, name: "Attendance service", ownerUserId: users.hr.id, timezone: TZ } });
    org = o.id;
    outlet = (await raw.query(`INSERT INTO outlets (organization_id, name, updated_at) VALUES ($1, 'Main', now()) RETURNING id`, [org])).rows[0].id;
    for (const who of ["hr", "emp", "other"] as const) {
      const m = await owner.organizationMember.create({ data: { organizationId: org, userId: users[who].id, status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role[keyOf[who]] }] } } });
      ctx[who] = await giveSession(owner, {
        sessionId: "00000000-0000-0000-0000-000000000000", user: { ...users[who], isPlatformAdmin: false },
        organization: { id: org, name: o.name, slug: o.slug }, memberId: m.id, expiresAt: new Date(), absoluteExpiresAt: new Date(),
        roleKeys: [keyOf[who]], permissions: new Set(ROLE_PERMISSIONS[keyOf[who]]),
      });
      emp[who] = (await raw.query(`INSERT INTO employees (organization_id, employee_code, full_name, joined_on, outlet_id, member_id, updated_at)
        VALUES ($1, $2, $3, '2026-01-01', $4, $5, now()) RETURNING id`, [org, `S-${who}-${rnd()}`.toUpperCase(), `${who} person`, outlet, who === "other" ? null : m.id])).rows[0].id;
    }
    emp.nologin = emp.other; // "other" has a login but no linked record; the record is someone without a login
    deps = { db, now: new Date(), writeAudit: async () => undefined, client: { ipAddress: "192.0.2.10", userAgent: "vitest" } };
  }, 90_000);

  afterAll(async () => {
    if (raw && org) {
      await raw.query(`DELETE FROM attendance_correction_requests WHERE organization_id = $1`, [org]);
      await raw.query(`DELETE FROM attendance_records WHERE organization_id = $1`, [org]);
      await raw.query(`DELETE FROM shifts WHERE organization_id = $1`, [org]);
      await raw.query(`DELETE FROM employee_assignments WHERE organization_id = $1`, [org]);
      await raw.query(`DELETE FROM employees WHERE organization_id = $1`, [org]);
      await raw.query(`DELETE FROM outlets WHERE organization_id = $1`, [org]);
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: org } });
      await purgeTestAuditRows(owner, [org]);
      await owner.organization.deleteMany({ where: { id: org } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await owner?.$disconnect();
    await db?.$disconnect();
    await raw?.end();
  });

  const fresh = (): AttendanceDeps => ({ ...deps, now: new Date() });
  const H = 3600_000;

  it("clocks an employee in and out and shows it on their own page with friendly refusals", async () => {
    expect((await getMyAttendance(db, ctx.other, new Date())).linked).toBe(false);
    await expect(clockIn(fresh(), ctx.other)).rejects.toThrow(/not linked to an employee record/);
    await clockIn(fresh(), ctx.emp);
    await expect(clockIn(fresh(), ctx.emp)).rejects.toMatchObject({ code: "conflict", message: "You are already clocked in." });
    await takeBreak(fresh(), ctx.emp, true);
    let mine = await getMyAttendance(db, ctx.emp, new Date());
    expect(mine).toMatchObject({ linked: true, canClock: true, open: { onBreak: true, abandoned: false, flags: ["unplanned"] } });
    expect(await clockOut(fresh(), ctx.emp)).toBe("closed");
    mine = await getMyAttendance(db, ctx.emp, new Date());
    expect(mine.open).toBeNull();
    expect(mine.history[0]).toMatchObject({ status: "CLOSED", inSource: "SELF" });
    // Device details only on the record page.
    expect(JSON.stringify(mine)).not.toContain("192.0.2.10");
    expect((await getRecord(db, ctx.emp, mine.history[0]!.id, new Date())).device.inIp).toBe("192.0.2.10");
    // Clocking out while on a break ends the break (no separate "break ended" row).
    expect((await getRecord(db, ctx.emp, mine.history[0]!.id, new Date())).history.map((h) => h.kind)).toEqual(["CLOCK_IN", "BREAK_START", "CLOCK_OUT"]);
  });

  it("checks permissions before asking the database", async () => {
    // ForbiddenError (its message is kept generic: "forbidden").
    await expect(hrRecord(fresh(), ctx.emp, emp.nologin, null, { start: new Date(Date.now() - 5 * H), end: new Date(Date.now() - H), breakMinutes: null, reason: null })).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(getDay(db, ctx.emp, localDay(new Date(), TZ), TZ, new Date(), null)).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(createShift(fresh(), ctx.emp, { employeeId: emp.emp, outletId: outlet, startsAt: new Date(Date.now() + 24 * H), endsAt: new Date(Date.now() + 30 * H), breakMinutes: 0, note: null })).rejects.toMatchObject({ name: "ForbiddenError" });
    // A colleague's record is simply not there for an employee.
    const theirs = (await hrRecord(fresh(), ctx.hr, emp.nologin, null, { start: new Date(Date.now() - 50 * H), end: new Date(Date.now() - 45 * H), breakMinutes: null, reason: null })).id;
    await expect(getRecord(db, ctx.emp, theirs, new Date())).rejects.toMatchObject({ code: "not_found" });
  });

  it("plans, edits, cancels and copies shifts through Prisma within the database's column rights", async () => {
    const day = addDays(localDay(new Date(), TZ), 2);
    const { start } = dayRange(day, TZ);
    const s = await createShift(fresh(), ctx.hr, { employeeId: emp.emp, outletId: outlet, startsAt: new Date(start.getTime() + 9 * H), endsAt: new Date(start.getTime() + 17 * H), breakMinutes: 30, note: "Opening" });
    await expect(createShift(fresh(), ctx.hr, { employeeId: emp.emp, outletId: outlet, startsAt: new Date(start.getTime() + 12 * H), endsAt: new Date(start.getTime() + 20 * H), breakMinutes: 0, note: null }))
      .rejects.toMatchObject({ message: "This employee already has a shift at that time." });
    await updateShift(fresh(), ctx.hr, s.id, { outletId: outlet, startsAt: new Date(start.getTime() + 10 * H), endsAt: new Date(start.getTime() + 18 * H), breakMinutes: 45, note: null });
    const week = weekStart(day);
    const range = { start: dayRange(week, TZ).start, end: dayRange(addDays(week, 7), TZ).start };
    let rota = await getRota(db, ctx.hr, range, null);
    expect(rota.shifts.find((x) => x.id === s.id)).toMatchObject({ breakMinutes: 45, note: null, status: "PLANNED" });
    // Copying the week twice: the second time everything overlaps and is skipped.
    const first = await copyWeek(fresh(), ctx.hr, range, null, TZ);
    expect(first.created).toBeGreaterThanOrEqual(1);
    expect(await copyWeek(fresh(), ctx.hr, range, null, TZ)).toEqual({ created: 0, skipped: first.created + first.skipped });
    await cancelShift(fresh(), ctx.hr, s.id, "Outlet closed for repairs");
    await expect(cancelShift(fresh(), ctx.hr, s.id, "again")).rejects.toMatchObject({ code: "not_found" });
    rota = await getRota(db, ctx.hr, range, null);
    expect(rota.shifts.find((x) => x.id === s.id)).toMatchObject({ status: "CANCELLED", cancelReason: "Outlet closed for repairs" });
  });

  it("shows HR a day with planned versus actual, missed shifts, and confirms a shift worked as planned", async () => {
    // A shift that is over. Nobody can plan the past, so the owner account switches the shifts guard off for this one
    // insert, inside a transaction (test database only).
    const startedAt = new Date(Date.now() - 10 * H);
    await raw.query("BEGIN");
    await raw.query(`ALTER TABLE shifts DISABLE TRIGGER shifts_guard`);
    const sid = (await raw.query(`INSERT INTO shifts (organization_id, employee_id, outlet_id, starts_at, ends_at, break_minutes, updated_at)
      VALUES ($1, $2, $3, $4, $5, 30, now()) RETURNING id`, [org, emp.nologin, outlet, startedAt, new Date(startedAt.getTime() + 8 * H)])).rows[0].id;
    await raw.query(`ALTER TABLE shifts ENABLE TRIGGER shifts_guard`);
    await raw.query("COMMIT");
    const day = localDay(startedAt, TZ);
    let view = await getDay(db, ctx.hr, day, TZ, new Date(), null);
    const row = () => view.rows.find((r) => r.employeeId === emp.nologin)!;
    expect(row().shifts.find((s) => s.id === sid)).toMatchObject({ missed: true });
    const confirmed = await confirmShift(fresh(), ctx.hr, sid);
    view = await getDay(db, ctx.hr, day, TZ, new Date(), null);
    expect(row().shifts.find((s) => s.id === sid)).toMatchObject({ missed: false });
    expect(row().records.find((r) => r.id === confirmed.id)).toMatchObject({ worked: 450, flags: [], inSource: "HR" });
    await expect(confirmShift(fresh(), ctx.hr, sid)).rejects.toMatchObject({ message: "That time overlaps another attendance record of this employee." });
  });

  it("takes a correction request from the employee to HR's decision, and HR corrections need a reason", async () => {
    const id = (await getMyAttendance(db, ctx.emp, new Date())).history[0]!.id;
    const rec = await getRecord(db, ctx.emp, id, new Date());
    const start = new Date(rec.clockInAt.getTime() - 30 * 60_000);
    await requestCorrection(fresh(), ctx.emp, id, { start, end: rec.clockOutAt!, breakMinutes: null, reason: "Started earlier, forgot to clock in" });
    const pending = await listRequests(db, ctx.hr, "PENDING");
    expect(pending.map((q) => q.reason)).toContain("Started earlier, forgot to clock in");
    const q = pending.find((p) => p.recordId === id)!;
    expect(q.current).toMatchObject({ status: "CLOSED" });
    await expect(decideRequest(fresh(), ctx.hr, q.id, false, null)).rejects.toMatchObject({ message: "Give a note when rejecting a request." });
    await decideRequest(fresh(), ctx.hr, q.id, true, null);
    expect((await getRecord(db, ctx.hr, id, new Date())).clockInAt.toISOString()).toBe(start.toISOString());
    await expect(hrCorrect(fresh(), ctx.hr, id, { start, end: rec.clockOutAt, breakMinutes: null, reason: null }, { outletId: null, setBreak: false })).rejects.toMatchObject({ code: "invalid" });
  });

  it("saves outlet hours (midnight close included) and employee standards, fills the rota, and shows a shift's history", async () => {
    // Hours go through Prisma's TIME handling and come back the same, including 00:00.
    const added = await setOutletHours(fresh(), ctx.hr, outlet, { opening: "08:00", changeover: "16:00", closing: "00:00", breakMinutes: 30 });
    expect(added).toBe(0); // nobody has a standard yet
    expect((await getStandards(db, ctx.hr)).outlets.find((o) => o.id === outlet)).toMatchObject({ opening: "08:00", changeover: "16:00", closing: "00:00", breakMinutes: 30 });
    // Two first saves at the same moment: both succeed (one becomes an update), and the rota is filled once.
    const both = await Promise.all([
      setEmployeeStandard(fresh(), ctx.hr, emp.emp, { standardShift: "EVENING", workDays: [1, 2, 3, 4, 5, 6, 7] }),
      setEmployeeStandard(fresh(), ctx.hr, emp.emp, { standardShift: "EVENING", workDays: [1, 2, 3, 4, 5, 6, 7] }),
    ]);
    expect(both.every((n) => n !== null)).toBe(true);
    const standards = await getStandards(db, ctx.hr);
    expect(standards.employees.find((e) => e.id === emp.emp)).toMatchObject({ standardShift: "EVENING", workDays: [1, 2, 3, 4, 5, 6, 7] });
    const tomorrow = addDays(localDay(new Date(), TZ), 1);
    const range = { start: dayRange(tomorrow, TZ).start, end: dayRange(addDays(tomorrow, 1), TZ).start };
    const shift = (await getRota(db, ctx.hr, range, null)).shifts.find((s) => s.employeeId === emp.emp && s.source === "STANDARD")!;
    expect(shift).toMatchObject({ standardShift: "EVENING", edited: false, breakMinutes: 30 });
    expect(shift.endsAt.getTime() - shift.startsAt.getTime()).toBe(8 * 3600_000); // 16:00 -> 00:00
    const history = await getShiftHistory(db, ctx.hr, shift.id);
    expect(history).toMatchObject([{ kind: "CREATED", system: true, by: null }]);
    // Unknown shifts are "not found", not an empty history; employees cannot read it or change standards.
    await expect(getShiftHistory(db, ctx.hr, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "not_found" });
    await expect(getShiftHistory(db, ctx.emp, shift.id)).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(setEmployeeStandard(fresh(), ctx.emp, emp.emp, null)).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(setOutletHours(fresh(), ctx.hr, outlet, { opening: "06:00", changeover: "23:00", closing: "23:30", breakMinutes: 0 })).rejects.toMatchObject({ message: "Each standard shift can be at most 16 hours." });
    // Clearing the standard cancels the generated shifts that are still to come.
    expect(await setEmployeeStandard(fresh(), ctx.hr, emp.emp, null)).not.toBeNull(); // saved AND applied
    expect((await getRota(db, ctx.hr, range, null)).shifts.find((s) => s.id === shift.id)).toMatchObject({ status: "CANCELLED", cancelReason: "No longer in the standard rota" });
  });
});
