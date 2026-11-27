// HR Reports through the service layer (src/lib/reports/reports.ts), against the DISPOSABLE test database. October 2026
// is seeded directly by the owner account (past shifts need the shifts guard switched off for the insert), then every
// report is read as the app's restricted account (hr_runtime) with real sessions, so row-level security applies.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "@/lib/auth/audit";
import type { AuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createDb, type Db } from "@/lib/db";
import { staffDb } from "@/lib/db-context";
import {
  exportReportCsv, getAttendanceReport, getHeadcountReport, getHiringReport, getLeaveReport, getReportSetup, getTaskReport,
} from "@/lib/reports/reports";
import { realRoleIds } from "./roles-helper";
import { giveSession, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");
const TZ = "Asia/Kolkata";
const OCT = { from: "2026-10-01", to: "2026-10-31" };
const at = (local: string) => `${local}:00+05:30`;
type Who = "sa" | "hr" | "emp" | "hrB";

describe.skipIf(!enabled)("HR reports service (test database)", { timeout: 90_000 }, () => {
  let owner: Db;
  let db: Db;
  let raw: Client;
  const orgs: string[] = [];
  const userIds: string[] = [];
  const ctx = {} as Record<Who, AuthContext>;
  const e = {} as Record<"asha" | "bilal" | "chitra" | "old" | "other", string>;
  const outlet = {} as Record<"main" | "second" | "b", string>;
  const now = new Date();

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 2 });
    db = createDb(runtimeUrl!, { max: 3 });
    raw = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    await raw.connect();
    const role = await realRoleIds(owner);
    const keyOf: Record<Who, RoleKey> = { sa: "SUPER_ADMIN", hr: "HR_MANAGER", emp: "EMPLOYEE", hrB: "HR_MANAGER" };
    const users = {} as Record<Who, { id: string; email: string; name: string }>;
    for (const who of Object.keys(keyOf) as Who[]) {
      users[who] = await owner.user.create({ data: { email: `${who}-${rnd()}@reports.example.test`, name: `${who} person` } });
      userIds.push(users[who].id);
    }
    const a = await owner.organization.create({ data: { slug: `reports-a-${rnd()}${rnd()}`, name: "Reports A", ownerUserId: users.sa.id, timezone: TZ } });
    const b = await owner.organization.create({ data: { slug: `reports-b-${rnd()}${rnd()}`, name: "Reports B", ownerUserId: users.hrB.id, timezone: TZ } });
    orgs.push(a.id, b.id);
    const addOutlet = async (org: string, name: string) => (await raw.query(`INSERT INTO outlets (organization_id, name, updated_at) VALUES ($1, $2, now()) RETURNING id`, [org, name])).rows[0].id as string;
    outlet.main = await addOutlet(a.id, "Main");
    outlet.second = await addOutlet(a.id, "Second");
    outlet.b = await addOutlet(b.id, "B outlet");
    const members = {} as Record<Who, string>;
    for (const who of Object.keys(keyOf) as Who[]) {
      const o = who === "hrB" ? b : a;
      const m = await owner.organizationMember.create({ data: { organizationId: o.id, userId: users[who].id, status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role[keyOf[who]] }] } } });
      members[who] = m.id;
      ctx[who] = await giveSession(owner, {
        sessionId: "00000000-0000-0000-0000-000000000000", user: { ...users[who], isPlatformAdmin: false },
        organization: { id: o.id, name: o.name, slug: o.slug }, memberId: m.id, expiresAt: new Date(), absoluteExpiresAt: new Date(),
        roleKeys: [keyOf[who]], permissions: new Set(ROLE_PERMISSIONS[keyOf[who]]),
      });
    }
    const addEmployee = async (org: string, name: string, joined: string, exited: string | null, outletId: string, type = "FULL_TIME", memberId: string | null = null) =>
      (await raw.query(`INSERT INTO employees (organization_id, employee_code, full_name, joined_on, exited_on, status, employment_type, outlet_id, member_id, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now()) RETURNING id`,
      [org, `RP-${rnd()}`.toUpperCase(), name, joined, exited, exited ? "EXITED" : "ACTIVE", type, outletId, memberId])).rows[0].id as string;
    e.asha = await addEmployee(a.id, "Asha", "2026-01-01", null, outlet.main, "FULL_TIME", members.emp);
    e.bilal = await addEmployee(a.id, "Bilal", "2026-10-15", null, outlet.second, "PART_TIME");
    e.chitra = await addEmployee(a.id, "Chitra", "2026-01-01", "2026-10-20", outlet.main);
    e.old = await addEmployee(a.id, "Old timer", "2025-01-01", "2026-09-01", outlet.main);
    e.other = await addEmployee(b.id, "Other org person", "2026-01-01", null, outlet.b);

    // Shifts in the past: the guard refuses planning the past, so it is switched off for these inserts only.
    const shifts: Record<string, string> = {};
    await raw.query("BEGIN");
    await raw.query(`ALTER TABLE shifts DISABLE TRIGGER shifts_guard`);
    const addShift = async (key: string, org: string, emp: string, out: string, start: string, end: string, brk: number) => {
      shifts[key] = (await raw.query(`INSERT INTO shifts (organization_id, employee_id, outlet_id, starts_at, ends_at, break_minutes, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`, [org, emp, out, at(start), at(end), brk])).rows[0].id;
    };
    await addShift("late", a.id, e.asha, outlet.main, "2026-10-05T09:00", "2026-10-05T17:00", 30);
    await addShift("missed", a.id, e.asha, outlet.main, "2026-10-06T09:00", "2026-10-06T17:00", 30);
    await addShift("leave", a.id, e.asha, outlet.main, "2026-10-07T09:00", "2026-10-07T17:00", 30);
    await addShift("bilal", a.id, e.bilal, outlet.second, "2026-10-20T09:00", "2026-10-20T13:00", 0);
    // Edges: a missed shift on the last day, covered by leave that runs on into November (counts as on leave); a night
    // shift starting 00:30 on 1 November local time (still 31 October in UTC), which belongs to November.
    await addShift("bilal-leave", a.id, e.bilal, outlet.second, "2026-10-31T09:00", "2026-10-31T13:00", 0);
    await addShift("bilal-night", a.id, e.bilal, outlet.second, "2026-11-01T00:30", "2026-11-01T06:00", 0);
    await addShift("other", b.id, e.other, outlet.b, "2026-10-05T09:00", "2026-10-05T17:00", 0);
    await raw.query(`ALTER TABLE shifts ENABLE TRIGGER shifts_guard`);
    await raw.query("COMMIT");
    const addRecord = (org: string, emp: string, out: string, shift: string, inAt: string, outAt: string) =>
      raw.query(`INSERT INTO attendance_records (organization_id, employee_id, outlet_id, shift_id, clock_in_at, clock_out_at, status, in_source, out_source)
        VALUES ($1, $2, $3, $4, $5, $6, 'CLOSED', 'HR', 'HR')`, [org, emp, out, shift, at(inAt), at(outAt)]);
    // The history trigger needs to know what kind of change this is (as HR recording past time would).
    await raw.query("BEGIN");
    await raw.query(`SELECT set_config('app.att_kind', 'HR_RECORDED', true)`);
    await addRecord(a.id, e.asha, outlet.main, shifts.late!, "2026-10-05T09:20", "2026-10-05T17:00");
    await addRecord(a.id, e.bilal, outlet.second, shifts.bilal!, "2026-10-20T09:00", "2026-10-20T13:00");
    await addRecord(b.id, e.other, outlet.b, shifts.other!, "2026-10-05T09:00", "2026-10-05T17:00");
    await raw.query("COMMIT");

    // Approved casual leave for Asha on 7 October, with 12 days granted for the year.
    const cl = (await raw.query(`SELECT id FROM leave_types WHERE organization_id = $1 AND code = 'CL'`, [a.id])).rows[0].id;
    const req = (await raw.query(`INSERT INTO leave_requests (organization_id, employee_id, leave_type_id, start_day, end_day, days, status, decided_at, decided_by_id)
      VALUES ($1, $2, $3, '2026-10-07', '2026-10-07', 1, 'APPROVED', now(), $4) RETURNING id`, [a.id, e.asha, cl, users.hr.id])).rows[0].id;
    await raw.query(`INSERT INTO leave_request_days (organization_id, request_id, day, weight) VALUES ($1, $2, '2026-10-07', 1)`, [a.id, req]);
    await raw.query(`INSERT INTO leave_ledger (organization_id, employee_id, leave_type_id, year, kind, days) VALUES ($1, $2, $3, 2026, 'GRANT', 12)`, [a.id, e.asha, cl]);
    await raw.query(`INSERT INTO leave_ledger (organization_id, employee_id, leave_type_id, year, kind, days, request_id) VALUES ($1, $2, $3, 2026, 'TAKEN', -1, $4)`, [a.id, e.asha, cl, req]);
    // Several credits of the same kind are summed (the report adds the ledger up per kind).
    await raw.query(`INSERT INTO leave_ledger (organization_id, employee_id, leave_type_id, year, kind, days, reason) VALUES ($1, $2, $3, 2026, 'ADJUSTMENT', 1.5, 'Extra day'), ($1, $2, $3, 2026, 'ADJUSTMENT', -0.5, 'Correction')`, [a.id, e.asha, cl]);
    // Unpaid leave for Bilal from 30 October to 2 November (across the end of the period).
    const ul = (await raw.query(`SELECT id FROM leave_types WHERE organization_id = $1 AND code = 'UL'`, [a.id])).rows[0].id;
    await raw.query(`INSERT INTO leave_requests (organization_id, employee_id, leave_type_id, start_day, end_day, days, status, decided_at, decided_by_id)
      VALUES ($1, $2, $3, '2026-10-30', '2026-11-02', 4, 'APPROVED', now(), $4)`, [a.id, e.bilal, ul, users.hr.id]);

    // Tasks: one approved on time with a rating, one never started (overdue), one in the other organisation.
    const addTask = (org: string, out: string, emp: string, due: string, extra: Record<string, unknown>) => {
      const cols = { organization_id: org, outlet_id: out, owner_employee_id: emp, title: "Close the till", description: "Count and photograph.", due_on: due,
        proof_kinds: "{TEXT}", created_by_id: users.hr.id, ...extra };
      const names = Object.keys(cols);
      return raw.query(`INSERT INTO tasks (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(cols));
    };
    await addTask(a.id, outlet.main, e.asha, "2026-10-10", { status: "APPROVED", submitted_at: at("2026-10-09T18:00"), decided_at: at("2026-10-10T10:00"),
      decided_by_id: users.hr.id, rating: 4, final_at: at("2026-10-10T10:00") });
    await addTask(a.id, outlet.second, e.bilal, "2026-10-21", { status: "ASSIGNED" });
    await addTask(b.id, outlet.b, e.other, "2026-10-10", { status: "ASSIGNED" });

    // Hiring: one application to a published job in October, moved to an interview; one job in the other organisation.
    for (const [org, title, by] of [[a.id, "Barista", users.sa.id], [b.id, "Other job", users.hrB.id]] as const) {
      const job = (await raw.query(`INSERT INTO job_openings (id, organization_id, slug, title, description, employment_type, work_mode, status, created_by_id, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, 'Report test job', 'FULL_TIME', 'ON_SITE', 'PUBLISHED', $4, now()) RETURNING id`, [org, `rp-${rnd()}`, title, by])).rows[0].id;
      const profile = (await raw.query(`INSERT INTO candidate_profiles (id, organization_id, email, full_name, updated_at) VALUES (gen_random_uuid(), $1, $2, 'Candidate Person', now()) RETURNING id`,
        [org, `cand-${rnd()}@reports.example.test`])).rows[0].id;
      const oc = (await raw.query(`INSERT INTO organization_candidates (id, organization_id, candidate_id, updated_at) VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`, [org, profile])).rows[0].id;
      const app = (await raw.query(`INSERT INTO applications (id, organization_id, reference_number, organization_candidate_id, job_id, stage, stage_changed_at, consent_accepted_at, privacy_notice_version, age_confirmed_at, applied_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'INTERVIEW_SCHEDULED', $5, $5, 'test', $5, $5, now()) RETURNING id`, [org, `RP-${rnd()}${rnd()}`, oc, job, at("2026-10-03T10:00")])).rows[0].id;
      await raw.query(`INSERT INTO application_status_history (id, organization_id, application_id, from_stage, to_stage, created_at) VALUES (gen_random_uuid(), $1, $2, 'APPLIED', 'INTERVIEW_SCHEDULED', $3)`,
        [org, app, at("2026-10-04T10:00")]);
    }
  }, 90_000);

  afterAll(async () => {
    if (raw && orgs.length) {
      for (const t of ["task_events", "tasks", "application_status_history", "applications", "organization_candidates", "candidate_profiles", "job_openings",
        "leave_ledger", "leave_request_days", "leave_requests", "attendance_changes", "attendance_records", "shifts", "employee_assignments", "employees", "outlets"]) {
        await raw.query(`DELETE FROM ${t} WHERE organization_id = ANY($1)`, [orgs]).catch(() => undefined);
      }
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

  it("refuses an Employee every report and export before reading anything", async () => {
    await expect(getReportSetup(db, ctx.emp)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getHeadcountReport(db, ctx.emp, OCT, null)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getAttendanceReport(db, ctx.emp, OCT, null, now)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getLeaveReport(db, ctx.emp, 2026, OCT, null)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getHiringReport(db, ctx.emp, OCT)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getTaskReport(db, ctx.emp, OCT, null, now)).rejects.toBeInstanceOf(ForbiddenError);
    const deps = { db, now, writeAudit, client: { ipAddress: null, userAgent: null } };
    await expect(exportReportCsv(deps, ctx.emp, "attendance", { period: OCT, outletId: null, year: 2026 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("would show an Employee only their own rows even if the app's check were skipped (row-level security)", async () => {
    const mine = staffDb(db, ctx.emp);
    const orgId = orgs[0]!;
    expect((await mine.shift.findMany({ where: { organizationId: orgId }, select: { employeeId: true } })).every((s) => s.employeeId === e.asha)).toBe(true);
    expect((await mine.attendanceRecord.findMany({ where: { organizationId: orgId }, select: { employeeId: true } })).every((r) => r.employeeId === e.asha)).toBe(true);
    expect(await mine.application.count({ where: { organizationId: orgId } })).toBe(0);
    expect((await mine.task.findMany({ where: { organizationId: orgId }, select: { ownerEmployeeId: true } })).every((t) => t.ownerEmployeeId === e.asha)).toBe(true);
  });

  it("gives HR the organisation's time zone and outlets only", async () => {
    const setup = await getReportSetup(db, ctx.hr);
    expect(setup.timeZone).toBe(TZ);
    expect(setup.outlets.map((o) => o.name)).toEqual(["Main", "Second"]);
  });

  it("counts headcount, joiners, leavers and turnover for October", async () => {
    const r = await getHeadcountReport(db, ctx.hr, OCT, null);
    expect(r).toMatchObject({ atStart: 2, atEnd: 2, joiners: 1, leavers: 1, turnoverPercent: 50 });
    expect(r.byOutlet).toEqual([{ name: "Main", count: 1 }, { name: "Second", count: 1 }]);
    expect((await getHeadcountReport(db, ctx.hr, OCT, outlet.second)).atEnd).toBe(1);
    // The other organisation's HR sees only its own person.
    expect((await getHeadcountReport(db, ctx.hrB, OCT, null)).atEnd).toBe(1);
  });

  it("summarises attendance per person: late, missed, on leave and worked time, within the organisation", async () => {
    const rows = await getAttendanceReport(db, ctx.hr, OCT, null, now);
    expect(rows.map((r) => r.name)).toEqual(["Asha", "Bilal"]);
    expect(rows[0]).toMatchObject({ planned: 3, attended: 1, missed: 1, onLeave: 1, late: 1, lateMinutes: 20, workedMinutes: 460 });
    // 20 Oct worked; 31 Oct missed but on leave; the 00:30 shift on 1 Nov local time is November's.
    expect(rows[1]).toMatchObject({ planned: 2, attended: 1, missed: 0, onLeave: 1, workedMinutes: 240 });
    expect((await getAttendanceReport(db, ctx.hr, { from: "2026-11-01", to: "2026-11-01" }, null, now))).toEqual([
      expect.objectContaining({ name: "Bilal", planned: 1, onLeave: 1 }),
    ]);
    expect((await getAttendanceReport(db, ctx.hr, OCT, outlet.second, now)).map((r) => r.name)).toEqual(["Bilal"]);
    // Another organisation's outlet id in the address finds nothing; it cannot widen what HR sees.
    expect(await getAttendanceReport(db, ctx.hr, OCT, outlet.b, now)).toEqual([]);
    expect((await getHeadcountReport(db, ctx.hr, OCT, outlet.b)).atEnd).toBe(0);
    expect(await getTaskReport(db, ctx.hr, OCT, outlet.b, now)).toEqual([]);
    expect((await getAttendanceReport(db, ctx.sa, OCT, null, now)).length).toBe(2);
    expect((await getAttendanceReport(db, ctx.hrB, OCT, null, now)).map((r) => r.name)).toEqual(["Other org person"]);
  });

  it("gives leave balances for the year and days taken in the period", async () => {
    const r = await getLeaveReport(db, ctx.hr, 2026, OCT, null);
    // Everyone employed at some point in 2026 (Old timer left on 1 September); nobody from the other organisation.
    expect(r.rows.map((p) => p.name)).toEqual(["Asha", "Bilal", "Chitra", "Old timer"]);
    expect((await getLeaveReport(db, ctx.hr, 2027, OCT, null)).rows.map((p) => p.name)).toEqual(["Asha", "Bilal"]);
    const asha = r.rows.find((p) => p.name === "Asha")!.balances.find((b) => b.typeCode === "CL")!;
    expect(asha).toMatchObject({ credited: 13, taken: 1, balance: 12, pending: 0, takenInPeriod: 1 });
    expect(r.requests).toEqual({ APPROVED: 2 });
    // Unpaid leave starting in the period counts its charged days; it has no balance.
    expect(r.rows.find((p) => p.name === "Bilal")!.balances.find((b) => b.typeCode === "UL")).toMatchObject({ paid: false, takenInPeriod: 4, available: null });
    expect((await getLeaveReport(db, ctx.hrB, 2026, OCT, null)).rows.map((p) => p.name)).toEqual(["Other org person"]);
  });

  it("counts hiring per job without naming anyone, within the organisation", async () => {
    const r = await getHiringReport(db, ctx.hr, OCT);
    expect(r.jobs).toEqual([{ jobId: expect.any(String), title: "Barista", received: 1, interviewing: 1, selected: 0, offerAccepted: 0, joined: 0, rejected: 0 }]);
    expect(r.pipeline).toEqual([{ stage: "INTERVIEW_SCHEDULED", label: "Interview scheduled", count: 1 }]);
    expect(JSON.stringify(r)).not.toContain("Candidate Person");
    expect((await getHiringReport(db, ctx.hr, { from: "2026-09-01", to: "2026-09-30" })).jobs[0]).toMatchObject({ received: 0, interviewing: 0 });
  });

  it("summarises tasks per person with on-time approvals, overdue work and ratings", async () => {
    const rows = await getTaskReport(db, ctx.hr, OCT, null, now);
    expect(rows).toEqual([
      expect.objectContaining({ name: "Asha", assigned: 1, approved: 1, onTime: 1, overdue: 0, averageRating: 4 }),
      expect.objectContaining({ name: "Bilal", assigned: 1, approved: 0, overdue: 1, averageRating: null }),
    ]);
  });

  it("exports CSV for every report and audits each export without the figures", async () => {
    const deps = { db, now, writeAudit, client: { ipAddress: "203.0.113.9", userAgent: "vitest" } };
    const out = await exportReportCsv(deps, ctx.hr, "attendance", { period: OCT, outletId: outlet.main, year: 2026 });
    expect(out.filename).toBe("attendance-2026-10-01-to-2026-10-31.csv");
    expect(out.csv.startsWith("﻿Employee code,Name,Planned shifts")).toBe(true);
    expect(out.csv).toContain(",Asha,3,1,1,1,0,1,20,");
    expect(out.csv).not.toContain("Bilal");
    const leave = await exportReportCsv(deps, ctx.hr, "leave", { period: OCT, outletId: null, year: 2026 });
    expect(leave.filename).toBe("leave-2026.csv");
    for (const kind of ["headcount", "hiring", "tasks"] as const) {
      expect((await exportReportCsv(deps, ctx.hr, kind, { period: OCT, outletId: null, year: 2026 })).csv.split("\r\n").length).toBeGreaterThan(2);
    }
    const audit = (await raw.query(`SELECT action, entity_type, actor_user_id, metadata, ip_address FROM audit_logs WHERE organization_id = $1 AND action = 'report.exported' ORDER BY created_at`, [orgs[0]])).rows;
    expect(audit).toHaveLength(5);
    expect(audit[0]).toMatchObject({ entity_type: "report", actor_user_id: ctx.hr.user.id, ip_address: "203.0.113.9",
      metadata: { report: "attendance", from: "2026-10-01", to: "2026-10-31", outletId: outlet.main } });
    expect(JSON.stringify(audit)).not.toContain("Asha");
  });
});
