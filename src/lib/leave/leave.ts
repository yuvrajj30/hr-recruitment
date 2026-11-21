import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { AttendanceDeps } from "@/lib/attendance/attendance";
import { addDays, databaseMessage, isDay, isUuid } from "@/lib/attendance/rules";
import { type AuthContext, requireAnyPermission, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import type { Db } from "@/lib/db";
import { staffDb } from "@/lib/db-context";
import { conflict, invalid, notFound, RecruitmentError } from "@/lib/recruitment/errors";
import {
  type LeaveAccrual, type LeaveLedgerKind, type LeaveRequestInput, type LeaveRequestStatus, type LeaveTypeInput, type HolidayInput,
  LEAVE_DB_MESSAGES, leaveRefusal, splitAtYearEnd,
} from "./rules";

// Leave: types, holidays, balances (a ledger), requests and HR decisions.
//
// Who may do what is decided twice: here by permission key (self:leave_read / self:leave_apply for one's own,
// leave:read / leave:approve / leave:manage for HR), and again by PostgreSQL (migrations 20261123000000_leave and
// 20261123000100_leave_functions). The app account only READS the ledger and the requests; every change to them is
// a call to a database function (app_request_leave, app_decide_leave, ...), which finds out who is asking from the
// session and writes the ledger itself. Leave types and holidays are written as rows: row-level security decides.

export type LeaveDeps = AttendanceDeps;
type Tx = Prisma.TransactionClient;
type Meta = Record<string, string | number | boolean | null>;

// Database refusals -> messages for people; anything else is passed on unchanged. Only PostgreSQL's own message is
// read (a whole Prisma error can echo what a user typed, e.g. a note).
const CONFLICTS = new Set([
  "leave_overlap", "leave_requests_no_overlap", "request_not_pending", "own_request", "leave_already_started", "leave_insufficient_balance",
  "holidays_organization_id_outlet_day_key", "leave_types_organization_id_code_key",
]);
function friendly(error: unknown): Error {
  if (error instanceof RecruitmentError) return error;
  const msg = databaseMessage(error);
  if (!msg) return error as Error;
  if (/deadlock detected|could not serialize/i.test(msg)) return conflict("Someone else changed this at the same moment. Please try again.");
  const code = leaveRefusal(msg);
  if (!code) return error as Error;
  if (code === "not_found") return notFound("That leave record");
  return CONFLICTS.has(code) ? conflict(LEAVE_DB_MESSAGES[code]!) : invalid(LEAVE_DB_MESSAGES[code]!);
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw friendly(e);
  }
}

async function audit(deps: LeaveDeps, tx: Tx, ctx: AuthContext, organizationId: string, action: string, entityType: string, entityId: string, metadata: Meta = {}) {
  await deps.writeAudit(tx, { organizationId, actorUserId: ctx.user.id, action, entityType, entityId, metadata, ...deps.client, now: deps.now });
}

const dayText = (d: Date): string => d.toISOString().slice(0, 10); // DATE columns arrive as UTC midnight
const dayValue = (s: string): Date => new Date(`${s}T00:00:00Z`);
const num = (v: Prisma.Decimal | number | string | null): number | null => (v === null ? null : Number(v));

// ---------------------------------------------------------------------------
// Shapes handed to the screens
// ---------------------------------------------------------------------------
export type LeaveTypeView = {
  id: string; code: string; name: string; paid: boolean; accrual: LeaveAccrual; daysPerYear: number; carryOverMax: number;
  noteRequired: boolean; configured: boolean; isActive: boolean;
};
const typeSelect = {
  id: true, code: true, name: true, paid: true, accrual: true, daysPerYear: true, carryOverMax: true, noteRequired: true, configured: true, isActive: true,
} satisfies Prisma.LeaveTypeSelect;
const toTypeView = (t: Prisma.LeaveTypeGetPayload<{ select: typeof typeSelect }>): LeaveTypeView => ({
  ...t, accrual: t.accrual as LeaveAccrual, daysPerYear: Number(t.daysPerYear), carryOverMax: Number(t.carryOverMax),
});

export type HolidayView = { id: string; day: string; name: string; outletId: string | null; outlet: string | null };

// One leave type in one year. credited: grants, accruals, carry-over, adjustments and expiry; taken: days taken less
// days returned; available: what a new request may use (balance less requests waiting). Unpaid types have none.
export type BalanceView = {
  typeId: string; typeCode: string; typeName: string; paid: boolean; year: number;
  credited: number; taken: number; balance: number; pending: number; available: number | null;
};

export type LeaveRequestView = {
  id: string; employeeId: string; employeeName: string; employeeCode: string; typeId: string; typeCode: string; typeName: string; paid: boolean;
  start: string; end: string; startHalf: boolean; endHalf: boolean; days: number; note: string | null; status: LeaveRequestStatus;
  decisionNote: string | null; decidedAt: Date | null; selfDecided: boolean; cancelReason: string | null; cancelledAt: Date | null; createdAt: Date;
};
const requestSelect = {
  id: true, employeeId: true, leaveTypeId: true, startDay: true, endDay: true, startHalf: true, endHalf: true, days: true, note: true, status: true,
  decisionNote: true, decidedAt: true, selfDecided: true, cancelReason: true, cancelledAt: true, createdAt: true,
  employee: { select: { fullName: true, employeeCode: true } }, leaveType: { select: { code: true, name: true, paid: true } },
} satisfies Prisma.LeaveRequestSelect;
const toRequestView = (q: Prisma.LeaveRequestGetPayload<{ select: typeof requestSelect }>): LeaveRequestView => ({
  id: q.id, employeeId: q.employeeId, employeeName: q.employee.fullName, employeeCode: q.employee.employeeCode, typeId: q.leaveTypeId,
  typeCode: q.leaveType.code, typeName: q.leaveType.name, paid: q.leaveType.paid, start: dayText(q.startDay), end: dayText(q.endDay),
  startHalf: q.startHalf, endHalf: q.endHalf, days: Number(q.days), note: q.note, status: q.status as LeaveRequestStatus, decisionNote: q.decisionNote,
  decidedAt: q.decidedAt, selfDecided: q.selfDecided, cancelReason: q.cancelReason, cancelledAt: q.cancelledAt, createdAt: q.createdAt,
});

// HR's queue adds the recount (owner test 3): the count with today's holidays and pattern, and what it leaves.
export type HrRequestView = LeaveRequestView & { currentDays: number | null; available: number | null; availableAfter: number | null };
export type PreviewView = { currentDays: number; available: number | null; availableAfter: number | null };

function balancesOf(
  types: LeaveTypeView[], years: number[],
  ledger: { leaveTypeId: string; year: number; kind: string; days: Prisma.Decimal }[],
  pending: { leaveTypeId: string; startDay: Date; days: Prisma.Decimal }[],
): BalanceView[] {
  const out: BalanceView[] = [];
  for (const year of years) {
    for (const t of types) {
      const lines = ledger.filter((l) => l.leaveTypeId === t.id && l.year === year);
      const waiting = pending.filter((p) => p.leaveTypeId === t.id && p.startDay.getUTCFullYear() === year);
      if (!t.isActive && !lines.length && !waiting.length) continue;
      const sum = (xs: { days: Prisma.Decimal }[]) => xs.reduce((s, x) => s + Number(x.days), 0);
      const balance = sum(lines);
      const taken = -sum(lines.filter((l) => l.kind === "TAKEN" || l.kind === "RESTORED"));
      const pend = sum(waiting);
      out.push({
        typeId: t.id, typeCode: t.code, typeName: t.name, paid: t.paid, year,
        credited: balance + taken, taken, balance, pending: pend, available: t.paid ? balance - pend : null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// My leave
// ---------------------------------------------------------------------------
export type MyLeave = {
  linked: boolean;
  hasStandard: boolean; // false: no working days set, so every day that is not a holiday counts
  canApply: boolean;
  types: LeaveTypeView[];
  balances: BalanceView[];
  requests: LeaveRequestView[];
  holidays: HolidayView[];
  notConfigured: string[]; // codes of paid types HR has not set up yet
};

async function myEmployeeId(db: Db | Tx): Promise<string | null> {
  const rows = await db.$queryRaw<{ id: string | null }[]>`SELECT app_my_employee_id()::text AS id`;
  return rows[0]?.id ?? null;
}

// today: the organisation's local date.
export async function getMyLeave(rawDb: Db, ctx: AuthContext, today: string): Promise<MyLeave> {
  requirePermission(ctx, "self:leave_read");
  const organizationId = requireOrganizationId(ctx);
  const canApply = ctx.permissions.has("self:leave_apply");
  const year = Number(today.slice(0, 4));
  return staffDb(rawDb, ctx).$transaction(async (tx) => {
    const types = (await tx.leaveType.findMany({ where: { organizationId }, orderBy: { code: "asc" }, select: typeSelect })).map(toTypeView);
    const notConfigured = types.filter((t) => t.isActive && t.paid && !t.configured).map((t) => t.code);
    const employeeId = await myEmployeeId(tx);
    if (!employeeId) {
      return { linked: false, hasStandard: false, canApply, types, balances: [], requests: [], holidays: [], notConfigured };
    }
    const me = await tx.employee.findFirst({ where: { id: employeeId }, select: { outletId: true } });
    const [pattern, ledger, pending, requests, holidays] = [
      await tx.employeeShiftPattern.findFirst({ where: { employeeId }, select: { id: true } }),
      await tx.leaveLedgerEntry.findMany({ where: { employeeId, year: { in: [year, year + 1] } }, select: { leaveTypeId: true, year: true, kind: true, days: true } }),
      await tx.leaveRequest.findMany({ where: { employeeId, status: "PENDING" }, select: { leaveTypeId: true, startDay: true, days: true } }),
      await tx.leaveRequest.findMany({
        where: { employeeId, OR: [{ status: "PENDING" }, { endDay: { gte: dayValue(`${year - 1}-01-01`) } }] },
        orderBy: { startDay: "desc" }, take: 100, select: requestSelect,
      }),
      await tx.holiday.findMany({
        where: { organizationId, day: { gte: dayValue(today), lte: dayValue(addDays(today, 366)) }, OR: [{ outletId: null }, ...(me?.outletId ? [{ outletId: me.outletId }] : [])] },
        orderBy: { day: "asc" }, take: 30, select: { id: true, day: true, name: true, outletId: true, outlet: { select: { name: true } } },
      }),
    ];
    const years = [...new Set([year, ...ledger.map((l) => l.year), ...pending.map((p) => p.startDay.getUTCFullYear())])].filter((y) => y >= year).sort();
    return {
      linked: true,
      hasStandard: Boolean(pattern),
      canApply,
      types,
      balances: balancesOf(types, years, ledger, pending),
      requests: requests.map(toRequestView),
      holidays: holidays.map((h) => ({ id: h.id, day: dayText(h.day), name: h.name, outletId: h.outletId, outlet: h.outlet?.name ?? null })),
      notConfigured,
    };
  });
}

// One request per calendar year (the database refuses requests that cross one). The half-day flags stay at the
// very first and very last day. All parts are made, or none.
async function requestParts(tx: Tx, input: LeaveRequestInput, call: (tx: Tx, start: string, end: string, startHalf: boolean, endHalf: boolean) => Promise<string>) {
  const parts = splitAtYearEnd(input.start, input.end);
  const ids: string[] = [];
  for (const [i, [start, end]] of parts.entries()) {
    ids.push(await call(tx, start, end, i === 0 && input.startHalf, i === parts.length - 1 && input.endHalf));
  }
  return ids;
}

export async function requestLeave(deps: LeaveDeps, ctx: AuthContext, input: LeaveRequestInput): Promise<string[]> {
  requirePermission(ctx, "self:leave_apply");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(input.typeId)) throw invalid("Choose a leave type.");
  return run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    const ids = await requestParts(tx, input, async (t, start, end, sh, eh) => {
      const rows = await t.$queryRaw<{ id: string }[]>`
        SELECT app_request_leave(${input.typeId}::uuid, ${start}::date, ${end}::date, ${sh}, ${eh}, ${input.note})::text AS id`;
      return rows[0]!.id;
    });
    for (const id of ids) await audit(deps, tx, ctx, organizationId, "leave.requested", "leave_request", id);
    return ids;
  }));
}

export async function withdrawLeave(deps: LeaveDeps, ctx: AuthContext, requestId: string): Promise<void> {
  requirePermission(ctx, "self:leave_apply");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(requestId)) throw notFound("That leave request");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    await tx.$queryRaw`SELECT app_withdraw_leave(${requestId}::uuid)::text AS done`;
    await audit(deps, tx, ctx, organizationId, "leave.withdrawn", "leave_request", requestId);
  }));
}

// Approved leave: the employee may cancel it before it starts; HR at any time. Days not yet taken come back.
export async function cancelLeave(deps: LeaveDeps, ctx: AuthContext, requestId: string, reason: string): Promise<void> {
  requireAnyPermission(ctx, ["self:leave_apply", "leave:approve"]);
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(requestId)) throw notFound("That leave request");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    await tx.$queryRaw`SELECT app_cancel_leave(${requestId}::uuid, ${reason})::text AS done`;
    await audit(deps, tx, ctx, organizationId, "leave.cancelled", "leave_request", requestId);
  }));
}

// ---------------------------------------------------------------------------
// HR: decisions, paper requests, adjustments
// ---------------------------------------------------------------------------
export async function decideLeave(deps: LeaveDeps, ctx: AuthContext, requestId: string, approve: boolean, note: string | null): Promise<void> {
  requirePermission(ctx, "leave:approve");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(requestId)) throw notFound("That leave request");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    await tx.$queryRaw`SELECT app_decide_leave(${requestId}::uuid, ${approve}, ${note})::text AS done`;
    await audit(deps, tx, ctx, organizationId, approve ? "leave.approved" : "leave.rejected", "leave_request", requestId);
  }));
}

// A paper request (or a person without a login): entered as approved, with the same day count and balance checks.
export async function hrRecordLeave(deps: LeaveDeps, ctx: AuthContext, employeeId: string, input: LeaveRequestInput): Promise<string[]> {
  requirePermission(ctx, "leave:approve");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(employeeId)) throw notFound("That employee");
  if (!isUuid(input.typeId)) throw invalid("Choose a leave type.");
  return run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    const ids = await requestParts(tx, input, async (t, start, end, sh, eh) => {
      const rows = await t.$queryRaw<{ id: string }[]>`
        SELECT app_hr_record_leave(${employeeId}::uuid, ${input.typeId}::uuid, ${start}::date, ${end}::date, ${sh}, ${eh}, ${input.note})::text AS id`;
      return rows[0]!.id;
    });
    for (const id of ids) await audit(deps, tx, ctx, organizationId, "leave.recorded", "leave_request", id, { employeeId });
    return ids;
  }));
}

export async function adjustLeave(deps: LeaveDeps, ctx: AuthContext, employeeId: string, typeId: string, year: number, days: number, reason: string): Promise<void> {
  requirePermission(ctx, "leave:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(employeeId)) throw notFound("That employee");
  if (!isUuid(typeId)) throw invalid("Choose a leave type.");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    await tx.$queryRaw`SELECT app_adjust_leave(${employeeId}::uuid, ${typeId}::uuid, ${year}::int, ${days}::numeric, ${reason})::text AS done`;
    await audit(deps, tx, ctx, organizationId, "leave.adjusted", "employee", employeeId, { typeId, year, days });
  }));
}

// ---------------------------------------------------------------------------
// HR: views
// ---------------------------------------------------------------------------
async function previewOf(tx: Tx, requestId: string): Promise<PreviewView> {
  const rows = await tx.$queryRaw<{ current_days: Prisma.Decimal; available: Prisma.Decimal | null; available_after: Prisma.Decimal | null }[]>`
    SELECT current_days, available, available_after FROM app_leave_preview(${requestId}::uuid)`;
  const r = rows[0]!;
  return { currentDays: Number(r.current_days), available: num(r.available), availableAfter: num(r.available_after) };
}

export async function listLeaveRequests(rawDb: Db, ctx: AuthContext, status: "PENDING" | "DECIDED"): Promise<HrRequestView[]> {
  requirePermission(ctx, "leave:read");
  const organizationId = requireOrganizationId(ctx);
  return staffDb(rawDb, ctx).$transaction(async (tx) => {
    const rows = await tx.leaveRequest.findMany({
      where: { organizationId, ...(status === "PENDING" ? { status: "PENDING" } : { status: { not: "PENDING" } }) },
      orderBy: status === "PENDING" ? [{ startDay: "asc" }, { createdAt: "asc" }] : [{ updatedAt: "desc" }],
      take: status === "PENDING" ? 500 : 200,
      select: requestSelect,
    });
    const out: HrRequestView[] = [];
    for (const r of rows) {
      const view = toRequestView(r);
      const preview = status === "PENDING" ? await previewOf(tx, r.id) : null;
      out.push({ ...view, currentDays: preview?.currentDays ?? null, available: preview?.available ?? null, availableAfter: preview?.availableAfter ?? null });
    }
    return out;
  }, { timeout: 30_000, maxWait: 10_000 });
}

export type LeaveRequestDetail = LeaveRequestView & {
  preview: PreviewView | null; // HR, waiting requests only
  // Shifts cancelled because of this leave. Standard shifts nobody changed come back by themselves if the leave is
  // cancelled; hand-planned or changed ones (comesBack false) do not, and HR plans them again if needed.
  cancelledShifts: { id: string; startsAt: Date; endsAt: Date; outlet: string; source: "MANUAL" | "STANDARD"; edited: boolean; comesBack: boolean }[];
};

// HR (leave:read) any request of the organisation; an employee their own (row-level security).
export async function getLeaveRequest(rawDb: Db, ctx: AuthContext, requestId: string): Promise<LeaveRequestDetail> {
  requireAnyPermission(ctx, ["self:leave_read", "leave:read"]);
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(requestId)) throw notFound("That leave request");
  return run(() => staffDb(rawDb, ctx).$transaction(async (tx) => {
    const r = await tx.leaveRequest.findFirst({ where: { id: requestId, organizationId }, select: requestSelect });
    if (!r) throw notFound("That leave request");
    const isHr = ctx.permissions.has("leave:read");
    const preview = isHr && r.status === "PENDING" ? await previewOf(tx, r.id) : null;
    const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } });
    const shifts = await tx.$queryRaw<{ id: string; startsAt: Date; endsAt: Date; outlet: string; source: "MANUAL" | "STANDARD"; edited: boolean }[]>`
      SELECT s.id::text AS id, s.starts_at AS "startsAt", s.ends_at AS "endsAt", o.name AS outlet, s.source::text AS source, s.edited
      FROM shifts s JOIN outlets o ON o.id = s.outlet_id
      WHERE s.employee_id = ${r.employeeId}::uuid AND s.organization_id = ${organizationId}::uuid AND s.status = 'CANCELLED' AND s.cancel_reason = 'On leave'
        AND COALESCE(s.standard_day, (s.starts_at AT TIME ZONE ${org?.timezone ?? "UTC"})::date) BETWEEN ${dayText(r.startDay)}::date AND ${dayText(r.endDay)}::date
      ORDER BY s.starts_at`;
    const cancelledShifts = shifts.map((s) => ({ ...s, comesBack: s.source === "STANDARD" && !s.edited }));
    return { ...toRequestView(r), preview, cancelledShifts };
  }));
}

// The "who is off" calendar: approved leave, and (marked) requests still waiting, for HR only. Names, leave type
// and halves; never the note or HR's decision note.
export type WhoIsOffEntry = {
  requestId: string; employeeId: string; employeeName: string; employeeCode: string; typeCode: string; typeName: string;
  start: string; end: string; startHalf: boolean; endHalf: boolean; days: number; status: "APPROVED" | "PENDING";
};
export async function getWhoIsOff(rawDb: Db, ctx: AuthContext, from: string, to: string): Promise<WhoIsOffEntry[]> {
  requirePermission(ctx, "leave:read");
  const organizationId = requireOrganizationId(ctx);
  if (!isDay(from) || !isDay(to) || to < from || to > addDays(from, 62)) throw invalid("Choose a period of up to two months.");
  const rows = await staffDb(rawDb, ctx).leaveRequest.findMany({
    where: { organizationId, status: { in: ["APPROVED", "PENDING"] }, startDay: { lte: dayValue(to) }, endDay: { gte: dayValue(from) } },
    orderBy: [{ startDay: "asc" }, { createdAt: "asc" }],
    take: 1000,
    select: {
      id: true, employeeId: true, startDay: true, endDay: true, startHalf: true, endHalf: true, days: true, status: true,
      employee: { select: { fullName: true, employeeCode: true } }, leaveType: { select: { code: true, name: true } },
    },
  });
  return rows.map((r) => ({
    requestId: r.id, employeeId: r.employeeId, employeeName: r.employee.fullName, employeeCode: r.employee.employeeCode, typeCode: r.leaveType.code,
    typeName: r.leaveType.name, start: dayText(r.startDay), end: dayText(r.endDay), startHalf: r.startHalf, endHalf: r.endHalf, days: Number(r.days),
    status: r.status as "APPROVED" | "PENDING",
  }));
}

export type LedgerLine = {
  id: string; typeCode: string; year: number; kind: LeaveLedgerKind; days: number; month: number | null; requestId: string | null;
  reason: string | null; createdBy: string | null; createdAt: Date;
};
export type EmployeeLeave = {
  employee: { id: string; name: string; code: string; status: string };
  year: number; types: LeaveTypeView[]; balances: BalanceView[]; ledger: LedgerLine[]; requests: LeaveRequestView[];
};

export async function getEmployeeLeave(rawDb: Db, ctx: AuthContext, employeeId: string, year: number): Promise<EmployeeLeave> {
  requirePermission(ctx, "leave:read");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(employeeId)) throw notFound("That employee");
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw invalid("Choose a leave year.");
  return staffDb(rawDb, ctx).$transaction(async (tx) => {
    const e = await tx.employee.findFirst({ where: { id: employeeId, organizationId }, select: { id: true, fullName: true, employeeCode: true, status: true } });
    if (!e) throw notFound("That employee");
    const types = (await tx.leaveType.findMany({ where: { organizationId }, orderBy: { code: "asc" }, select: typeSelect })).map(toTypeView);
    const ledger = await tx.leaveLedgerEntry.findMany({
      where: { organizationId, employeeId, year },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, leaveTypeId: true, year: true, kind: true, days: true, month: true, requestId: true, reason: true, createdAt: true, leaveType: { select: { code: true } }, createdBy: { select: { name: true } } },
    });
    const pending = await tx.leaveRequest.findMany({ where: { organizationId, employeeId, status: "PENDING" }, select: { leaveTypeId: true, startDay: true, days: true } });
    const requests = await tx.leaveRequest.findMany({
      where: { organizationId, employeeId, startDay: { lte: dayValue(`${year}-12-31`) }, endDay: { gte: dayValue(`${year}-01-01`) } },
      orderBy: { startDay: "desc" }, take: 200, select: requestSelect,
    });
    return {
      employee: { id: e.id, name: e.fullName, code: e.employeeCode, status: e.status },
      year,
      types,
      balances: balancesOf(types, [year], ledger, pending),
      ledger: ledger.map((l) => ({
        id: l.id, typeCode: l.leaveType.code, year: l.year, kind: l.kind as LeaveLedgerKind, days: Number(l.days), month: l.month, requestId: l.requestId,
        reason: l.reason, createdBy: l.createdBy?.name ?? null, createdAt: l.createdAt,
      })),
      requests: requests.map(toRequestView),
    };
  });
}

// ---------------------------------------------------------------------------
// Set-up: leave types and holidays (readable by every member; changed by leave:manage)
// ---------------------------------------------------------------------------
export async function listLeaveTypes(rawDb: Db, ctx: AuthContext): Promise<LeaveTypeView[]> {
  requireAnyPermission(ctx, ["self:leave_read", "leave:read"]);
  const organizationId = requireOrganizationId(ctx);
  return (await staffDb(rawDb, ctx).leaveType.findMany({ where: { organizationId }, orderBy: { code: "asc" }, select: typeSelect })).map(toTypeView);
}

// id null: a new type. Saving marks a type as set up. A type's code and whether it is paid never change (history
// depends on them): for an existing type they are ignored here, and the database refuses them too.
export async function saveLeaveType(deps: LeaveDeps, ctx: AuthContext, typeId: string | null, input: LeaveTypeInput): Promise<string> {
  requirePermission(ctx, "leave:manage");
  const organizationId = requireOrganizationId(ctx);
  if (typeId !== null && !isUuid(typeId)) throw notFound("That leave type");
  return run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    const settings = {
      name: input.name, accrual: input.accrual, daysPerYear: input.daysPerYear, carryOverMax: input.carryOverMax,
      noteRequired: input.noteRequired, isActive: input.isActive, configured: true,
    };
    let id: string;
    if (typeId) {
      const r = await tx.leaveType.updateMany({ where: { id: typeId, organizationId }, data: settings });
      if (r.count !== 1) throw notFound("That leave type");
      id = typeId;
    } else {
      id = (await tx.leaveType.create({ data: { organizationId, code: input.code, paid: input.paid, ...settings }, select: { id: true } })).id;
    }
    await audit(deps, tx, ctx, organizationId, typeId ? "leave_type.updated" : "leave_type.created", "leave_type", id, {
      code: input.code, daysPerYear: input.daysPerYear, carryOverMax: input.carryOverMax, accrual: input.accrual, isActive: input.isActive,
    });
    return id;
  }));
}

export async function listHolidays(rawDb: Db, ctx: AuthContext, year: number): Promise<HolidayView[]> {
  requireAnyPermission(ctx, ["self:leave_read", "leave:read"]);
  const organizationId = requireOrganizationId(ctx);
  const rows = await staffDb(rawDb, ctx).holiday.findMany({
    where: { organizationId, day: { gte: dayValue(`${year}-01-01`), lte: dayValue(`${year}-12-31`) } },
    orderBy: [{ day: "asc" }, { name: "asc" }],
    select: { id: true, day: true, name: true, outletId: true, outlet: { select: { name: true } } },
  });
  return rows.map((h) => ({ id: h.id, day: dayText(h.day), name: h.name, outletId: h.outletId, outlet: h.outlet?.name ?? null }));
}

// A holiday added later never changes leave already approved (its stored count is final); waiting requests show
// the recount to HR before the decision.
export async function saveHoliday(deps: LeaveDeps, ctx: AuthContext, input: HolidayInput): Promise<string> {
  requirePermission(ctx, "leave:manage");
  const organizationId = requireOrganizationId(ctx);
  if (input.outletId !== null && !isUuid(input.outletId)) throw invalid("Choose an outlet, or all outlets.");
  return run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    const { id } = await tx.holiday.create({ data: { organizationId, outletId: input.outletId, day: dayValue(input.day), name: input.name }, select: { id: true } });
    await audit(deps, tx, ctx, organizationId, "holiday.added", "holiday", id, { day: input.day, outletId: input.outletId });
    return id;
  }));
}

export async function removeHoliday(deps: LeaveDeps, ctx: AuthContext, holidayId: string): Promise<void> {
  requirePermission(ctx, "leave:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(holidayId)) throw notFound("That holiday");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    const r = await tx.holiday.deleteMany({ where: { id: holidayId, organizationId } });
    if (r.count !== 1) throw notFound("That holiday");
    await audit(deps, tx, ctx, organizationId, "holiday.removed", "holiday", holidayId);
  }));
}
