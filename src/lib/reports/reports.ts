import "server-only";
import type { AuditWriter } from "@/lib/auth/audit";
import { type AuthContext, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import { Prisma } from "@/generated/prisma/client";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { addDays, formatMinutes, isUuid } from "@/lib/attendance/rules";
import type { Db } from "@/lib/db";
import { staffDb } from "@/lib/db-context";
import type { EmploymentType } from "@/lib/employees/rules";
import { balancesOf, type BalanceView, toTypeView, typeSelect } from "@/lib/leave/leave";
import { invalid } from "@/lib/recruitment/errors";
import type { AnyStage } from "@/lib/recruitment/stages";
import type { TaskStatus } from "@/lib/tasks/rules";
import {
  type AttendanceRow, type CsvCell, withinLimit, type HeadcountReport, type HiringReport, periodRange, type Person, REPORT_LIMITS, type ReportKind,
  type ReportPeriod, summariseAttendance, summariseHeadcount, summariseHiring, summariseTasks, type TaskRow, toCsv,
} from "./rules";

// HR Reports: read-only figures from the data CafeOS already holds.
//
// Who may see them is decided twice: here by the permission key report:read (HR Managers and Super Admins), and by
// PostgreSQL, whose row-level security shows a member only their own organisation's rows (and an Employee only their
// own). Everything is read through staffDb, inside one transaction per report so the figures are consistent.
// Nothing is written, except the audit line of a CSV export. No candidate is named anywhere: the hiring report counts.

type Tx = Prisma.TransactionClient;
const dayText = (d: Date): string => d.toISOString().slice(0, 10); // DATE columns arrive as UTC midnight
const dayValue = (s: string): Date => new Date(`${s}T00:00:00Z`);
const timeText = (d: Date | null): string | null => (d ? d.toISOString().slice(11, 16) : null); // TIME columns arrive on 1970-01-01 UTC

const TOO_MUCH = "This period holds too much data for one report. Choose a shorter period or one outlet.";
function capped<T>(rows: T[]): T[] {
  try {
    return withinLimit(rows);
  } catch {
    throw invalid(TOO_MUCH);
  }
}
const take = REPORT_LIMITS.maxRows + 1;

function begin(ctx: AuthContext) {
  requirePermission(ctx, "report:read");
  return requireOrganizationId(ctx);
}
const outletOf = (outletId: string | null) => (outletId && isUuid(outletId) ? outletId : null);

async function peopleOf(tx: Tx, organizationId: string): Promise<Map<string, Person>> {
  const rows = capped(await tx.employee.findMany({ where: { organizationId }, select: { id: true, fullName: true, employeeCode: true }, take }));
  return new Map(rows.map((e) => [e.id, { name: e.fullName, code: e.employeeCode }]));
}

// ---------------------------------------------------------------------------
// Filters shared by every report page
// ---------------------------------------------------------------------------
export type ReportSetup = { timeZone: string; outlets: { id: string; name: string; isActive: boolean }[] };
export async function getReportSetup(rawDb: Db, ctx: AuthContext): Promise<ReportSetup> {
  const organizationId = begin(ctx);
  const [timeZone, outlets] = await Promise.all([
    attendanceTimezone(rawDb, ctx),
    staffDb(rawDb, ctx).outlet.findMany({ where: { organizationId }, orderBy: { name: "asc" }, select: { id: true, name: true, isActive: true } }),
  ]);
  return { timeZone, outlets };
}

// ---------------------------------------------------------------------------
// Headcount
// ---------------------------------------------------------------------------
export async function getHeadcountReport(rawDb: Db, ctx: AuthContext, period: ReportPeriod, outletId: string | null): Promise<HeadcountReport> {
  const organizationId = begin(ctx);
  const outlet = outletOf(outletId);
  const rows = capped(await staffDb(rawDb, ctx).employee.findMany({
    where: {
      organizationId, joinedOn: { lte: dayValue(period.to) }, OR: [{ exitedOn: null }, { exitedOn: { gte: dayValue(period.from) } }],
      ...(outlet ? { outletId: outlet } : {}),
    },
    select: { id: true, joinedOn: true, exitedOn: true, employmentType: true, outlet: { select: { name: true } }, department: { select: { name: true } } },
    take,
  }));
  return summariseHeadcount(rows.map((e) => ({
    id: e.id, joinedOn: dayText(e.joinedOn), exitedOn: e.exitedOn ? dayText(e.exitedOn) : null, employmentType: e.employmentType as EmploymentType,
    outlet: e.outlet?.name ?? null, department: e.department?.name ?? null,
  })), period);
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------
export async function getAttendanceReport(rawDb: Db, ctx: AuthContext, period: ReportPeriod, outletId: string | null, now: Date): Promise<AttendanceRow[]> {
  const organizationId = begin(ctx);
  const timeZone = await attendanceTimezone(rawDb, ctx);
  const { start, end } = periodRange(period, timeZone);
  const outlet = outletOf(outletId);
  return staffDb(rawDb, ctx).$transaction(async (tx) => {
    const people = await peopleOf(tx, organizationId);
    const shifts = capped(await tx.shift.findMany({
      where: { organizationId, startsAt: { gte: start, lt: end }, ...(outlet ? { outletId: outlet } : {}) },
      select: { id: true, employeeId: true, startsAt: true, endsAt: true, status: true, breakMinutes: true, records: { select: { status: true } } },
      take,
    }));
    const records = capped(await tx.attendanceRecord.findMany({
      where: { organizationId, clockInAt: { gte: start, lt: end }, ...(outlet ? { outletId: outlet } : {}) },
      select: {
        employeeId: true, shiftId: true, status: true, clockInAt: true, clockOutAt: true, breakMinutes: true,
        breaks: { select: { startsAt: true, endsAt: true } }, shift: { select: { startsAt: true, endsAt: true, breakMinutes: true } },
      },
      take,
    }));
    // Approved leave covering the period's days, for "on leave" rather than "missed" (as the day screen does).
    const leave = capped(await tx.leaveRequest.findMany({
      where: { organizationId, status: "APPROVED", startDay: { lte: dayValue(period.to) }, endDay: { gte: dayValue(period.from) } },
      select: { employeeId: true, startDay: true, endDay: true },
      take,
    }));
    const leaveDays = new Set<string>();
    for (const l of leave) {
      const first = dayText(l.startDay) > period.from ? dayText(l.startDay) : period.from;
      const last = dayText(l.endDay) < period.to ? dayText(l.endDay) : period.to;
      for (let d = first; d <= last; d = addDays(d, 1)) leaveDays.add(`${l.employeeId}|${d}`);
    }
    return summariseAttendance(people, shifts.map((s) => ({ ...s, status: s.status as "PLANNED" | "CANCELLED" })), records, leaveDays, timeZone, now);
  }, { timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// Leave: balances for one year, and the days of approved requests that start in the period.
// ---------------------------------------------------------------------------
export type LeaveRow = { employeeId: string; name: string; code: string; balances: (BalanceView & { takenInPeriod: number })[] };
export type LeaveReport = { year: number; types: { id: string; code: string; name: string; paid: boolean }[]; rows: LeaveRow[]; requests: Record<string, number> };

export async function getLeaveReport(rawDb: Db, ctx: AuthContext, year: number, period: ReportPeriod, outletId: string | null): Promise<LeaveReport> {
  const organizationId = begin(ctx);
  const outlet = outletOf(outletId);
  const employee = outlet ? { employee: { outletId: outlet } } : {};
  return staffDb(rawDb, ctx).$transaction(async (tx) => {
    const types = (await tx.leaveType.findMany({ where: { organizationId }, orderBy: { code: "asc" }, select: typeSelect })).map(toTypeView);
    const people = capped(await tx.employee.findMany({
      where: { organizationId, ...(outlet ? { outletId: outlet } : {}), joinedOn: { lte: dayValue(`${year}-12-31`) },
        OR: [{ exitedOn: null }, { exitedOn: { gte: dayValue(`${year}-01-01`) } }] },
      orderBy: { fullName: "asc" }, select: { id: true, fullName: true, employeeCode: true }, take,
    }));
    const ids = people.map((p) => p.id);
    // Summed per person, type and kind: balancesOf only adds lines up, so sums give the same balances, and the row limit
    // then depends on the number of people, not on how many credits each one has had.
    const ledger = (await tx.leaveLedgerEntry.groupBy({
      by: ["employeeId", "leaveTypeId", "kind"], _sum: { days: true }, where: { organizationId, year, employeeId: { in: ids } },
    })).map((l) => ({ employeeId: l.employeeId, leaveTypeId: l.leaveTypeId, year, kind: l.kind, days: l._sum.days ?? new Prisma.Decimal(0) }));
    const pending = capped(await tx.leaveRequest.findMany({
      where: { organizationId, status: "PENDING", employeeId: { in: ids }, startDay: { gte: dayValue(`${year}-01-01`), lte: dayValue(`${year}-12-31`) } },
      select: { employeeId: true, leaveTypeId: true, startDay: true, days: true }, take,
    }));
    // Approved requests that start in the period, with their charged days.
    const taken = capped(await tx.leaveRequest.findMany({
      where: { organizationId, status: "APPROVED", employeeId: { in: ids }, startDay: { gte: dayValue(period.from), lte: dayValue(period.to) } },
      select: { employeeId: true, leaveTypeId: true, days: true }, take,
    }));
    const requests = await tx.leaveRequest.groupBy({
      by: ["status"], _count: { _all: true },
      where: { organizationId, startDay: { lte: dayValue(period.to) }, endDay: { gte: dayValue(period.from) }, ...employee },
    });
    const takenBy = new Map<string, number>();
    for (const t of taken) {
      const k = `${t.employeeId}|${t.leaveTypeId}`;
      takenBy.set(k, (takenBy.get(k) ?? 0) + Number(t.days));
    }
    const group = <T extends { employeeId: string }>(xs: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of xs) m.set(x.employeeId, [...(m.get(x.employeeId) ?? []), x]);
      return m;
    };
    const ledgerBy = group(ledger);
    const pendingBy = group(pending);
    const rows = people.map((p) => ({
      employeeId: p.id, name: p.fullName, code: p.employeeCode,
      balances: balancesOf(types, [year], ledgerBy.get(p.id) ?? [], pendingBy.get(p.id) ?? [])
        .map((b) => ({ ...b, takenInPeriod: takenBy.get(`${p.id}|${b.typeId}`) ?? 0 })),
    }));
    return {
      year,
      types: types.filter((t) => t.isActive || rows.some((r) => r.balances.some((b) => b.typeId === t.id))).map((t) => ({ id: t.id, code: t.code, name: t.name, paid: t.paid })),
      rows,
      requests: Object.fromEntries(requests.map((r) => [r.status, r._count._all])),
    };
  }, { timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// Hiring: counts per job and stage. Archived jobs are left out.
// ---------------------------------------------------------------------------
export async function getHiringReport(rawDb: Db, ctx: AuthContext, period: ReportPeriod): Promise<HiringReport> {
  const organizationId = begin(ctx);
  const timeZone = await attendanceTimezone(rawDb, ctx);
  const range = periodRange(period, timeZone);
  return staffDb(rawDb, ctx).$transaction(async (tx) => {
    const jobs = capped(await tx.jobOpening.findMany({ where: { organizationId, status: { not: "ARCHIVED" } }, select: { id: true, title: true }, take }));
    const jobIds = jobs.map((j) => j.id);
    const applications = capped(await tx.application.findMany({ where: { organizationId, jobId: { in: jobIds } }, select: { jobId: true, stage: true, appliedAt: true }, take }));
    const history = capped(await tx.applicationStatusHistory.findMany({
      where: { organizationId, createdAt: { gte: range.start, lt: range.end }, application: { jobId: { in: jobIds } } },
      select: { applicationId: true, toStage: true, createdAt: true, application: { select: { jobId: true } } }, take,
    }));
    return summariseHiring(
      jobs,
      applications.map((a) => ({ ...a, stage: a.stage as AnyStage })),
      history.map((h) => ({ jobId: h.application.jobId, applicationId: h.applicationId, toStage: h.toStage as AnyStage, createdAt: h.createdAt })),
      range,
    );
  }, { timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// Tasks (by deadline in the period). Ratings appear here for HR only.
// ---------------------------------------------------------------------------
export async function getTaskReport(rawDb: Db, ctx: AuthContext, period: ReportPeriod, outletId: string | null, now: Date): Promise<TaskRow[]> {
  const organizationId = begin(ctx);
  const timeZone = await attendanceTimezone(rawDb, ctx);
  const outlet = outletOf(outletId);
  return staffDb(rawDb, ctx).$transaction(async (tx) => {
    const people = await peopleOf(tx, organizationId);
    const tasks = capped(await tx.task.findMany({
      where: { organizationId, dueOn: { gte: dayValue(period.from), lte: dayValue(period.to) }, ...(outlet ? { outletId: outlet } : {}) },
      select: {
        ownerEmployeeId: true, status: true, dueOn: true, dueTime: true, submittedAt: true, rating: true,
        _count: { select: { events: { where: { kind: "CHANGES_REQUESTED" } } } },
      },
      take,
    }));
    return summariseTasks(people, tasks.map((t) => ({
      ownerEmployeeId: t.ownerEmployeeId, status: t.status as TaskStatus, dueOn: dayText(t.dueOn), dueTime: timeText(t.dueTime),
      submittedAt: t.submittedAt, rating: t.rating, changesRequested: t._count.events,
    })), timeZone, now);
  }, { timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// CSV export. Every export is audited (which report and filters, never the figures).
// ---------------------------------------------------------------------------
export type ReportDeps = { db: Db; now: Date; writeAudit: AuditWriter; client: { ipAddress: string | null; userAgent: string | null } };
export type ReportFilters = { period: ReportPeriod; outletId: string | null; year: number };
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

async function csvOf(deps: ReportDeps, ctx: AuthContext, kind: ReportKind, f: ReportFilters): Promise<string> {
  const { db, now } = deps;
  switch (kind) {
    case "headcount": {
      const r = await getHeadcountReport(db, ctx, f.period, f.outletId);
      const rows: CsvCell[][] = [
        ["Summary", "Employed on first day", r.atStart], ["Summary", "Employed on last day", r.atEnd], ["Summary", "Joined", r.joiners],
        ["Summary", "Left", r.leavers], ["Summary", "Turnover %", r.turnoverPercent],
        ...r.byOutlet.map((c) => ["Outlet", c.name, c.count]), ...r.byDepartment.map((c) => ["Department", c.name, c.count]),
        ...r.byType.map((c) => ["Employment type", c.name, c.count]),
      ];
      return toCsv(["Group", "Item", "Count"], rows);
    }
    case "attendance": {
      const rows = await getAttendanceReport(db, ctx, f.period, f.outletId, now);
      return toCsv(
        ["Employee code", "Name", "Planned shifts", "Attended", "Missed", "On leave", "Upcoming", "Late arrivals", "Minutes late", "Left early",
          "Missing clock-outs", "Unplanned records", "Hours worked", "Worked (h:m)"],
        rows.map((r) => [r.code, r.name, r.planned, r.attended, r.missed, r.onLeave, r.upcoming, r.late, r.lateMinutes, r.early, r.missingOut, r.unplanned,
          hours(r.workedMinutes), formatMinutes(r.workedMinutes)]),
      );
    }
    case "leave": {
      const r = await getLeaveReport(db, ctx, f.year, f.period, f.outletId);
      return toCsv(
        ["Employee code", "Name", "Leave type", "Paid", "Year", "Credited", "Taken in year", "Balance", "Pending", "Available", "Approved days starting in period"],
        r.rows.flatMap((p) => p.balances.map((b) => [p.code, p.name, `${b.typeCode} ${b.typeName}`, b.paid ? "Yes" : "No", b.year, b.credited, b.taken,
          b.balance, b.pending, b.available, b.takenInPeriod])),
      );
    }
    case "hiring": {
      const r = await getHiringReport(db, ctx, f.period);
      return toCsv(
        ["Job", "Applications received", "Interviews scheduled", "Selected", "Offers accepted", "Joined", "Rejected"],
        r.jobs.map((j) => [j.title, j.received, j.interviewing, j.selected, j.offerAccepted, j.joined, j.rejected]),
      );
    }
    case "tasks": {
      const rows = await getTaskReport(db, ctx, f.period, f.outletId, now);
      return toCsv(
        ["Employee code", "Name", "Tasks due", "Approved", "Approved on time", "Overdue", "Changes requested", "Average rating"],
        rows.map((r) => [r.code, r.name, r.assigned, r.approved, r.onTime, r.overdue, r.changesRequested, r.averageRating]),
      );
    }
  }
}

export async function exportReportCsv(deps: ReportDeps, ctx: AuthContext, kind: ReportKind, f: ReportFilters): Promise<{ filename: string; csv: string }> {
  const organizationId = begin(ctx);
  const csv = await csvOf(deps, ctx, kind, f);
  const outletId = kind === "hiring" ? null : outletOf(f.outletId); // hiring has no outlet filter
  await deps.writeAudit(staffDb(deps.db, ctx), {
    organizationId, actorUserId: ctx.user.id, action: "report.exported", entityType: "report", entityId: null,
    metadata: { report: kind, from: f.period.from, to: f.period.to, outletId, ...(kind === "leave" ? { year: f.year } : {}) },
    ...deps.client, now: deps.now,
  });
  const name = kind === "leave" ? `leave-${f.year}` : `${kind}-${f.period.from}-to-${f.period.to}`;
  return { filename: `${name}.csv`, csv };
}
