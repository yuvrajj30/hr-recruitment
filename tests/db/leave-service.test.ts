// Leave through the service layer (src/lib/leave/leave.ts), against the DISPOSABLE test database. The database rules
// are covered in leave.test.ts; this checks what the screens rely on: permissions are checked before the database is
// asked, a request over 31 December becomes one request per year, HR sees the recount before deciding (owner test 3),
// the "who is off" calendar follows the visibility rules (owner test 5), and the attendance day knows about leave.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AttendanceDeps, clockIn, getDay } from "@/lib/attendance/attendance";
import { addDays, localDay } from "@/lib/attendance/rules";
import type { AuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createDb, type Db } from "@/lib/db";
import {
  adjustLeave, cancelLeave, decideLeave, getEmployeeLeave, getLeaveRequest, getMyLeave, getWhoIsOff, hrRecordLeave, listHolidays, listLeaveRequests,
  listLeaveTypes, requestLeave, saveHoliday, saveLeaveType, withdrawLeave,
} from "@/lib/leave/leave";
import { realRoleIds } from "./roles-helper";
import { giveSession, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");
const TZ = "Asia/Kolkata";
type Who = "sa" | "hr" | "emp" | "emp2" | "hrB";

describe.skipIf(!enabled)("leave service (test database)", { timeout: 90_000 }, () => {
  let owner: Db;
  let db: Db;
  let raw: Client;
  const orgs: string[] = [];
  let outlet = "";
  const userIds: string[] = [];
  const ctx = {} as Record<Who, AuthContext>;
  const emp = {} as Record<"sa" | "hr" | "emp" | "emp2", string>;
  const type = {} as Record<string, string>;
  let base = ""; // a local day a few days ahead whose next two weeks stay in one year
  const d = (n: number) => addDays(base, n);
  const deps = (): AttendanceDeps => ({ db, now: new Date(), writeAudit: async () => undefined, client: { ipAddress: null, userAgent: null } });

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 2 });
    db = createDb(runtimeUrl!, { max: 3 });
    raw = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    await raw.connect();
    const role = await realRoleIds(owner);
    const keyOf: Record<Who, RoleKey> = { sa: "SUPER_ADMIN", hr: "HR_MANAGER", emp: "EMPLOYEE", emp2: "EMPLOYEE", hrB: "HR_MANAGER" };
    const users = {} as Record<Who, { id: string; email: string; name: string }>;
    for (const who of Object.keys(keyOf) as Who[]) {
      users[who] = await owner.user.create({ data: { email: `${who}-${rnd()}@leavesvc.example.test`, name: `${who} person` } });
      userIds.push(users[who].id);
    }
    const a = await owner.organization.create({ data: { slug: `leavesvc-a-${rnd()}${rnd()}`, name: "Leave service A", ownerUserId: users.sa.id, timezone: TZ } });
    const b = await owner.organization.create({ data: { slug: `leavesvc-b-${rnd()}${rnd()}`, name: "Leave service B", ownerUserId: users.hrB.id, timezone: TZ } });
    orgs.push(a.id, b.id);
    outlet = (await raw.query(`INSERT INTO outlets (organization_id, name, updated_at) VALUES ($1, 'Main', now()) RETURNING id`, [a.id])).rows[0].id;
    for (const who of Object.keys(keyOf) as Who[]) {
      const o = who === "hrB" ? b : a;
      const m = await owner.organizationMember.create({ data: { organizationId: o.id, userId: users[who].id, status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role[keyOf[who]] }] } } });
      ctx[who] = await giveSession(owner, {
        sessionId: "00000000-0000-0000-0000-000000000000", user: { ...users[who], isPlatformAdmin: false },
        organization: { id: o.id, name: o.name, slug: o.slug }, memberId: m.id, expiresAt: new Date(), absoluteExpiresAt: new Date(),
        roleKeys: [keyOf[who]], permissions: new Set(ROLE_PERMISSIONS[keyOf[who]]),
      });
      if (who !== "hrB") {
        // No standard shift pattern: every day that is not a holiday counts.
        emp[who] = (await raw.query(`INSERT INTO employees (organization_id, employee_code, full_name, joined_on, outlet_id, member_id, updated_at)
          VALUES ($1, $2, $3, '2026-01-01', $4, $5, now()) RETURNING id`, [a.id, `LS-${who}-${rnd()}`.toUpperCase(), `${who} person`, outlet, m.id])).rows[0].id;
      }
    }
    for (const t of (await raw.query(`SELECT id, code FROM leave_types WHERE organization_id = $1`, [a.id])).rows) type[t.code] = t.id;
    const today = localDay(new Date(), TZ);
    base = addDays(today, 3);
    if (addDays(base, 20).slice(0, 4) !== base.slice(0, 4)) base = `${Number(base.slice(0, 4)) + 1}-01-12`;
  }, 90_000);

  afterAll(async () => {
    if (raw && orgs.length) {
      await raw.query(`DELETE FROM leave_ledger WHERE organization_id = ANY($1)`, [orgs]).catch(() => undefined);
      await raw.query(`DELETE FROM leave_requests WHERE organization_id = ANY($1)`, [orgs]);
      await raw.query(`DELETE FROM holidays WHERE organization_id = ANY($1)`, [orgs]);
      await raw.query(`DELETE FROM shifts WHERE organization_id = ANY($1)`, [orgs]);
      await raw.query(`DELETE FROM employee_assignments WHERE organization_id = ANY($1)`, [orgs]);
      await raw.query(`DELETE FROM employees WHERE organization_id = ANY($1)`, [orgs]);
      await raw.query(`DELETE FROM outlets WHERE organization_id = ANY($1)`, [orgs]);
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgs } } });
      await purgeTestAuditRows(owner, orgs);
      await owner.organization.deleteMany({ where: { id: { in: orgs } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await owner?.$disconnect();
    await db?.$disconnect();
    await raw?.end();
  });

  const input = (code: string, start: string, end: string, extra: Partial<{ startHalf: boolean; endHalf: boolean; note: string | null }> = {}) =>
    ({ typeId: type[code]!, start, end, startHalf: false, endHalf: false, note: null, ...extra });

  it("checks permissions before asking the database", async () => {
    const e = ctx.emp;
    await expect(listLeaveRequests(db, e, "PENDING")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getEmployeeLeave(db, e, emp.emp2, 2026)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideLeave(deps(), e, type.CL!, true, null)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(hrRecordLeave(deps(), e, emp.emp2, input("UL", d(1), d(1)))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(adjustLeave(deps(), e, emp.emp2, type.CL!, 2026, 1, "x")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveLeaveType(deps(), e, type.CL!, { code: "CL", name: "Casual", paid: true, accrual: "YEARLY", daysPerYear: 1, carryOverMax: 0, noteRequired: false, isActive: true }))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveHoliday(deps(), e, { day: d(1), name: "Nope", outletId: null })).rejects.toBeInstanceOf(ForbiddenError);
    // Leave types and holidays are readable by every member.
    expect((await listLeaveTypes(db, e)).map((t) => t.code).sort()).toEqual(["CL", "CO", "EL", "SL", "UL"]);
    expect(await listHolidays(db, e, 2026)).toEqual([]);
  });

  it("saves leave-type settings (marking the type set up) and shows a warning until then", async () => {
    let mine = await getMyLeave(db, ctx.emp, localDay(new Date(), TZ));
    expect(mine).toMatchObject({ linked: true, hasStandard: false });
    expect(mine.notConfigured.sort()).toEqual(["CL", "CO", "EL", "SL"]);
    // Credited by HR only (no accrual): the daily job, which other test files run for every organisation, then never
    // adds a grant here, so the balances below stay exact.
    await saveLeaveType(deps(), ctx.hr, type.CL!, { code: "IGNORED", name: "Casual leave", paid: false, accrual: "NONE", daysPerYear: 0, carryOverMax: 3, noteRequired: false, isActive: true });
    const cl = (await listLeaveTypes(db, ctx.hr)).find((t) => t.id === type.CL)!;
    expect(cl).toMatchObject({ code: "CL", paid: true, name: "Casual leave", accrual: "NONE", carryOverMax: 3, configured: true }); // code and paid never change
    mine = await getMyLeave(db, ctx.emp, localDay(new Date(), TZ));
    expect(mine.notConfigured).not.toContain("CL");
    // A new type gets its own code.
    const id = await saveLeaveType(deps(), ctx.hr, null, { code: "ML", name: "Marriage leave", paid: true, accrual: "NONE", daysPerYear: 0, carryOverMax: 0, noteRequired: true, isActive: true });
    expect((await listLeaveTypes(db, ctx.emp)).find((t) => t.id === id)).toMatchObject({ code: "ML", configured: true });
    await expect(saveLeaveType(deps(), ctx.hr, null, { code: "ML", name: "Again", paid: true, accrual: "NONE", daysPerYear: 0, carryOverMax: 0, noteRequired: false, isActive: true }))
      .rejects.toMatchObject({ message: "A leave type with that code already exists." });
  });

  it("splits a request over 31 December into one request per year, keeping the halves at the ends", async () => {
    const y = Number(localDay(new Date(), TZ).slice(0, 4));
    const ids = await requestLeave(deps(), ctx.emp2, input("UL", `${y}-12-30`, `${y + 1}-01-02`, { endHalf: true }));
    expect(ids).toHaveLength(2);
    const rows = (await raw.query(`SELECT start_day::text s, end_day::text e, start_half, end_half, days::float FROM leave_requests WHERE id = ANY($1) ORDER BY start_day`, [ids])).rows;
    expect(rows).toEqual([
      { s: `${y}-12-30`, e: `${y}-12-31`, start_half: false, end_half: false, days: 2 },
      { s: `${y + 1}-01-01`, e: `${y + 1}-01-02`, start_half: false, end_half: true, days: 1.5 },
    ]);
    for (const id of ids) await withdrawLeave(deps(), ctx.emp2, id);
    // A refusal comes back as a message for people.
    await expect(requestLeave(deps(), ctx.emp2, input("EL", d(1), d(1)))).rejects.toMatchObject({ message: /HR has not set up this leave type/ });
  });

  it("shows HR who is off (names, codes and halves; never notes), only in their own organisation, and nobody else (owner test 5)", async () => {
    await adjustLeave(deps(), ctx.hr, emp.emp, type.CL!, Number(d(3).slice(0, 4)), 5, "Opening balance from the paper register");
    const [approvedId] = await requestLeave(deps(), ctx.emp, input("CL", d(3), d(4), { note: "Private family matter" }));
    await decideLeave(deps(), ctx.hr, approvedId!, true, "Approved, take care");
    const [pendingId] = await requestLeave(deps(), ctx.emp2, input("UL", d(5), d(5), { startHalf: true, note: "Doctor visit" }));

    const off = await getWhoIsOff(db, ctx.hr, d(0), d(10));
    expect(off.map((o) => ({ id: o.requestId, status: o.status }))).toEqual([{ id: approvedId, status: "APPROVED" }, { id: pendingId, status: "PENDING" }]);
    expect(off[0]).toEqual({
      requestId: approvedId, employeeId: emp.emp, employeeName: "emp person", employeeCode: expect.any(String), typeCode: "CL", typeName: "Casual leave",
      start: d(3), end: d(4), startHalf: false, endHalf: false, days: 2, status: "APPROVED",
    });
    expect(off[1]).toMatchObject({ employeeId: emp.emp2, typeCode: "UL", start: d(5), end: d(5), startHalf: true, days: 0.5, status: "PENDING" });
    expect(JSON.stringify(off)).not.toMatch(/Private family matter|Doctor visit|take care/);
    // Another organisation's HR sees none of it.
    expect(await getWhoIsOff(db, ctx.hrB, d(0), d(10))).toEqual([]);
    // Staff see who is off and when (approved only), without the leave type, notes or requests still waiting.
    const staffView = await getWhoIsOff(db, ctx.emp2, d(0), d(10));
    expect(staffView).toEqual([{
      requestId: null, employeeId: emp.emp, employeeName: "emp person", employeeCode: null, typeCode: null, typeName: null,
      start: d(3), end: d(4), startHalf: false, endHalf: false, days: null, status: "APPROVED",
    }]);
    expect(JSON.stringify(staffView)).not.toMatch(/Private family matter|Casual|CL/);
    // An employee's own page shows only their own requests, with their own balance.
    const mine = await getMyLeave(db, ctx.emp2, localDay(new Date(), TZ));
    expect(mine.requests.map((r) => r.id)).toContain(pendingId);
    expect(mine.requests.map((r) => r.id)).not.toContain(approvedId);
    expect(new Set(mine.requests.map((r) => r.employeeId))).toEqual(new Set([emp.emp2]));
    const empPage = await getMyLeave(db, ctx.emp, localDay(new Date(), TZ));
    expect(empPage.balances.find((x) => x.typeCode === "CL" && x.year === Number(d(3).slice(0, 4)))).toMatchObject({ credited: 5, taken: 2, pending: 0, balance: 3, available: 3 });
    // The attendance day lists approved leave (not the pending half day).
    const day = await getDay(db, ctx.hr, d(3), TZ, new Date(), null);
    expect(day.onLeave).toEqual([{ employeeId: emp.emp, employeeName: "emp person", typeCode: "CL", half: false }]);
    expect((await getDay(db, ctx.hr, d(5), TZ, new Date(), null)).onLeave).toEqual([]);
    // HR's own view of one person: the ledger lines with their reasons.
    const one = await getEmployeeLeave(db, ctx.hr, emp.emp, Number(d(3).slice(0, 4)));
    expect(one.ledger.map((l) => [l.kind, l.days])).toEqual([["ADJUSTMENT", 5], ["TAKEN", -2]]);
    expect(one.ledger[0]).toMatchObject({ reason: "Opening balance from the paper register", createdBy: "hr person" });
    await withdrawLeave(deps(), ctx.emp2, pendingId!);
    await cancelLeave(deps(), ctx.hr, approvedId!, "Test cleanup");
  });

  it("lets HR see the recount and balance impact before deciding (owner test 3)", async () => {
    const year = Number(d(7).slice(0, 4));
    await adjustLeave(deps(), ctx.hr, emp.emp2, type.CL!, year, 4, "Opening balance");
    const [id] = await requestLeave(deps(), ctx.emp2, input("CL", d(7), d(8)));
    let pending = (await listLeaveRequests(db, ctx.hr, "PENDING")).find((r) => r.id === id)!;
    expect(pending).toMatchObject({ days: 2, currentDays: 2, available: 4, availableAfter: 2 });
    // A holiday added after the request: HR sees the new count before deciding.
    await saveHoliday(deps(), ctx.hr, { day: d(8), name: "Local festival", outletId: null });
    pending = (await listLeaveRequests(db, ctx.hr, "PENDING")).find((r) => r.id === id)!;
    expect(pending).toMatchObject({ days: 2, currentDays: 1, available: 4, availableAfter: 3 });
    expect((await getLeaveRequest(db, ctx.hr, id!)).preview).toEqual({ currentDays: 1, available: 4, availableAfter: 3 });
    await decideLeave(deps(), ctx.hr, id!, true, null);
    expect((await listLeaveRequests(db, ctx.hr, "DECIDED")).find((r) => r.id === id)).toMatchObject({ status: "APPROVED", days: 1, currentDays: null });
    await cancelLeave(deps(), ctx.hr, id!, "Test cleanup");
  });

  it("records paper leave for a person, shows the shifts it cancelled, and refuses HR's own paper leave", async () => {
    const shift = (await raw.query(`INSERT INTO shifts (organization_id, employee_id, outlet_id, starts_at, ends_at, updated_at)
      VALUES ($1, $2, $3, ($4::date + time '10:00') AT TIME ZONE $5, ($4::date + time '14:00') AT TIME ZONE $5, now()) RETURNING id`, [orgs[0], emp.emp, outlet, d(10), TZ])).rows[0].id;
    const [id] = await hrRecordLeave(deps(), ctx.hr, emp.emp, input("UL", d(10), d(10), { note: "Paper form" }));
    const detail = await getLeaveRequest(db, ctx.hr, id!);
    expect(detail).toMatchObject({ status: "APPROVED", employeeId: emp.emp, preview: null });
    expect(detail.cancelledShifts).toEqual([expect.objectContaining({ id: shift, outlet: "Main", source: "MANUAL", edited: false, comesBack: false })]);
    await expect(hrRecordLeave(deps(), ctx.hr, emp.hr, input("UL", d(11), d(11)))).rejects.toMatchObject({ message: /Someone else must decide/ });
    // The employee sees their own request, but not someone else's.
    expect((await getLeaveRequest(db, ctx.emp, id!)).id).toBe(id);
    await expect(getLeaveRequest(db, ctx.emp2, id!)).rejects.toMatchObject({ code: "not_found" });
    await cancelLeave(deps(), ctx.hr, id!, "Test cleanup");
  });

  it("tells an employee on leave today why clocking in is refused", async () => {
    const today = localDay(new Date(), TZ);
    const [id] = await hrRecordLeave(deps(), ctx.hr, emp.emp, input("UL", today, today));
    try {
      await expect(clockIn(deps(), ctx.emp)).rejects.toMatchObject({ message: "You are on leave today. Ask HR if that is wrong." });
    } finally {
      await cancelLeave(deps(), ctx.hr, id!, "Test cleanup");
    }
  });
});
