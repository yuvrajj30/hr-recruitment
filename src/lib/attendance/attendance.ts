import "server-only";
import type { AuditWriter } from "@/lib/auth/audit";
import { type AuthContext, requireAnyPermission, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { staffDb } from "@/lib/db-context";
import { conflict, invalid, notFound, RecruitmentError } from "@/lib/recruitment/errors";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";
import {
  ATTENDANCE_LIMITS, type AttendanceSource, type AttendanceStatus, type ChangeKind, DB_MESSAGES, databaseMessage, dayRange, dbRefusal, isAbandoned,
  isMissedShift, isUuid, type OutletHoursInput, type PeriodInput, type RecordFlag, recordFlags, type RequestStatus, type ShiftInput, shiftByDays,
  type StandardInput, type StandardShift, dateToTime, timeToDate, workedMinutes,
} from "./rules";

// Attendance: the planned rota, worked time, breaks, corrections.
//
// Who may do what is decided twice: here by permission key (attendance:read / attendance:manage for HR,
// self:attendance_read / self:attendance_clock for one's own), and again by PostgreSQL. The app account can only
// READ attendance; every change is a call to one of the database functions (app_clock_in, app_hr_correct_attendance,
// ...), which find out who is asking from the session, use the database's own clock for punches, and write the
// history themselves (migration 20261122000100_attendance_records). Shifts are written as rows: row-level security
// and the shifts trigger decide (20261122000000_attendance_shifts).

export type AttendanceDeps = {
  db: Db;
  now: Date;
  writeAudit: AuditWriter;
  client: { ipAddress: string | null; userAgent: string | null };
};
type Tx = Prisma.TransactionClient;
type Meta = Record<string, string | number | boolean | null>;

// Database refusals -> messages for people; anything else is passed on unchanged. Only PostgreSQL's own message is
// read (a whole Prisma error can echo what a user typed, e.g. a note containing "shift_over").
function friendly(error: unknown): Error {
  if (error instanceof RecruitmentError) return error;
  const msg = databaseMessage(error);
  if (!msg) return error as Error;
  if (/deadlock detected|could not serialize/i.test(msg)) return conflict("Someone else changed this at the same moment. Please try again.");
  const code = dbRefusal(msg);
  if (!code) return error as Error;
  if (code === "not_found") return notFound("That record");
  if (["already_clocked_in", "not_clocked_in", "already_on_break", "not_on_break", "request_pending", "request_not_pending", "attendance_void",
       "shift_started", "shift_over", "shift_cancelled", "own_request", "attendance_overlap", "shifts_no_overlap"].includes(code)) {
    return conflict(DB_MESSAGES[code]!);
  }
  return invalid(DB_MESSAGES[code]!);
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw friendly(e);
  }
}

async function audit(deps: AttendanceDeps, tx: Tx, ctx: AuthContext, organizationId: string, action: string, entityType: string, entityId: string, metadata: Meta = {}) {
  await deps.writeAudit(tx, { organizationId, actorUserId: ctx.user.id, action, entityType, entityId, metadata, ...deps.client, now: deps.now });
}

export async function attendanceTimezone(rawDb: Db, ctx: AuthContext): Promise<string> {
  return (await getOrganizationSettings(rawDb, ctx)).timezone;
}

// ---------------------------------------------------------------------------
// Shapes handed to the screens (plain values; device details only where stated)
// ---------------------------------------------------------------------------
export type BreakView = { startsAt: Date; endsAt: Date | null };
export type ShiftView = {
  id: string; employeeId: string; employeeName: string; employeeCode: string; outletId: string; outlet: string; startsAt: Date; endsAt: Date;
  breakMinutes: number; note: string | null; status: "PLANNED" | "CANCELLED"; cancelReason: string | null;
  // STANDARD: filled in from the standard; edited: a person changed it since.
  source: "MANUAL" | "STANDARD"; standardShift: StandardShift | null; edited: boolean;
};
export type RecordView = {
  id: string; employeeId: string; employeeName: string; employeeCode: string; outletId: string | null; outlet: string | null; status: AttendanceStatus;
  clockInAt: Date; clockOutAt: Date | null; inSource: AttendanceSource; outSource: AttendanceSource | null;
  breakMinutes: number | null; breaks: BreakView[];
  shift: { id: string; startsAt: Date; endsAt: Date; breakMinutes: number } | null;
  worked: number | null; flags: RecordFlag[];
};
export type RequestView = {
  id: string; employeeId: string; employeeName: string; employeeCode: string; recordId: string | null;
  current: { clockInAt: Date; clockOutAt: Date | null; status: AttendanceStatus } | null;
  proposedClockInAt: Date; proposedClockOutAt: Date; proposedBreakMinutes: number | null; reason: string;
  status: RequestStatus; decisionNote: string | null; decidedAt: Date | null; createdAt: Date;
};

const recordSelect = {
  id: true, employeeId: true, outletId: true, status: true, clockInAt: true, clockOutAt: true, inSource: true, outSource: true, breakMinutes: true,
  employee: { select: { fullName: true, employeeCode: true } },
  outlet: { select: { name: true } },
  shift: { select: { id: true, startsAt: true, endsAt: true, breakMinutes: true } },
  breaks: { select: { startsAt: true, endsAt: true }, orderBy: { startsAt: "asc" as const } },
} satisfies Prisma.AttendanceRecordSelect;
type RecordRow = Prisma.AttendanceRecordGetPayload<{ select: typeof recordSelect }>;

function toRecordView(r: RecordRow, now: Date): RecordView {
  const base = { status: r.status as AttendanceStatus, clockInAt: r.clockInAt, clockOutAt: r.clockOutAt, breakMinutes: r.breakMinutes, breaks: r.breaks, shift: r.shift };
  return {
    id: r.id, employeeId: r.employeeId, employeeName: r.employee.fullName, employeeCode: r.employee.employeeCode, outletId: r.outletId, outlet: r.outlet?.name ?? null,
    status: r.status as AttendanceStatus, clockInAt: r.clockInAt, clockOutAt: r.clockOutAt, inSource: r.inSource as AttendanceSource,
    outSource: (r.outSource as AttendanceSource | null) ?? null, breakMinutes: r.breakMinutes, breaks: r.breaks, shift: r.shift,
    worked: workedMinutes(base, now), flags: recordFlags(base, now),
  };
}

const shiftSelect = {
  id: true, employeeId: true, outletId: true, startsAt: true, endsAt: true, breakMinutes: true, note: true, status: true, cancelReason: true,
  source: true, standardShift: true, edited: true,
  employee: { select: { fullName: true, employeeCode: true } }, outlet: { select: { name: true } },
} satisfies Prisma.ShiftSelect;
const toShiftView = (s: Prisma.ShiftGetPayload<{ select: typeof shiftSelect }>): ShiftView => ({
  id: s.id, employeeId: s.employeeId, employeeName: s.employee.fullName, employeeCode: s.employee.employeeCode, outletId: s.outletId,
  outlet: s.outlet.name, startsAt: s.startsAt, endsAt: s.endsAt, breakMinutes: s.breakMinutes, note: s.note, status: s.status, cancelReason: s.cancelReason,
  source: s.source, standardShift: s.standardShift, edited: s.edited,
});

const requestSelect = {
  id: true, employeeId: true, recordId: true, proposedClockInAt: true, proposedClockOutAt: true, proposedBreakMinutes: true, reason: true,
  status: true, decisionNote: true, decidedAt: true, createdAt: true,
  employee: { select: { fullName: true, employeeCode: true } },
  record: { select: { clockInAt: true, clockOutAt: true, status: true } },
} satisfies Prisma.AttendanceCorrectionRequestSelect;
const toRequestView = (q: Prisma.AttendanceCorrectionRequestGetPayload<{ select: typeof requestSelect }>): RequestView => ({
  id: q.id, employeeId: q.employeeId, employeeName: q.employee.fullName, employeeCode: q.employee.employeeCode, recordId: q.recordId,
  current: q.record ? { clockInAt: q.record.clockInAt, clockOutAt: q.record.clockOutAt, status: q.record.status as AttendanceStatus } : null,
  proposedClockInAt: q.proposedClockInAt, proposedClockOutAt: q.proposedClockOutAt, proposedBreakMinutes: q.proposedBreakMinutes,
  reason: q.reason, status: q.status as RequestStatus, decisionNote: q.decisionNote, decidedAt: q.decidedAt, createdAt: q.createdAt,
});

// ---------------------------------------------------------------------------
// Self-service
// ---------------------------------------------------------------------------
export type MyAttendance = {
  linked: boolean;
  canClock: boolean;
  open: (RecordView & { onBreak: boolean; abandoned: boolean }) | null;
  upcoming: ShiftView[];
  history: RecordView[];
  requests: RequestView[];
};

async function myEmployeeId(db: Db): Promise<string | null> {
  const rows = await db.$queryRaw<{ id: string | null }[]>`SELECT app_my_employee_id()::text AS id`;
  return rows[0]?.id ?? null;
}

export async function getMyAttendance(rawDb: Db, ctx: AuthContext, now: Date): Promise<MyAttendance> {
  requirePermission(ctx, "self:attendance_read");
  requireOrganizationId(ctx);
  const db = staffDb(rawDb, ctx);
  const canClock = ctx.permissions.has("self:attendance_clock");
  const employeeId = await myEmployeeId(db);
  if (!employeeId) return { linked: false, canClock, open: null, upcoming: [], history: [], requests: [] };
  const since = new Date(now.getTime() - ATTENDANCE_LIMITS.requestDaysBack * 86_400_000);
  const [records, shifts, requests] = await db.$transaction(async (tx) => [
    await tx.attendanceRecord.findMany({ where: { employeeId, OR: [{ clockInAt: { gte: since } }, { status: { in: ["OPEN", "MISSING_OUT"] } }] }, orderBy: { clockInAt: "desc" }, take: 200, select: recordSelect }),
    await tx.shift.findMany({ where: { employeeId, status: "PLANNED", endsAt: { gt: now } }, orderBy: { startsAt: "asc" }, take: 30, select: shiftSelect }),
    await tx.attendanceCorrectionRequest.findMany({ where: { employeeId, OR: [{ status: "PENDING" }, { createdAt: { gte: since } }] }, orderBy: { createdAt: "desc" }, take: 50, select: requestSelect }),
  ] as const);
  const views = records.map((r) => toRecordView(r, now));
  const openRow = views.find((r) => r.status === "OPEN") ?? null;
  return {
    linked: true,
    canClock,
    open: openRow ? { ...openRow, onBreak: openRow.breaks.some((b) => b.endsAt === null), abandoned: isAbandoned(openRow, now) } : null,
    upcoming: shifts.map(toShiftView),
    history: views,
    requests: requests.map(toRequestView),
  };
}

export async function clockIn(deps: AttendanceDeps, ctx: AuthContext): Promise<void> {
  requirePermission(ctx, "self:attendance_clock");
  await run(() => staffDb(deps.db, ctx).$queryRaw`SELECT app_clock_in(${deps.client.ipAddress}, ${deps.client.userAgent})::text AS id`);
}

// "closed", or "missing_out" when the clock-in had been left open too long (the employee then asks for a correction).
export async function clockOut(deps: AttendanceDeps, ctx: AuthContext): Promise<"closed" | "missing_out"> {
  requirePermission(ctx, "self:attendance_clock");
  const rows = await run(() => staffDb(deps.db, ctx).$queryRaw<{ s: string }[]>`SELECT app_clock_out(${deps.client.ipAddress}, ${deps.client.userAgent}) AS s`);
  return rows[0]?.s === "missing_out" ? "missing_out" : "closed";
}

export async function takeBreak(deps: AttendanceDeps, ctx: AuthContext, start: boolean): Promise<void> {
  requirePermission(ctx, "self:attendance_clock");
  await run(() => staffDb(deps.db, ctx).$queryRaw`SELECT app_break(${start})::text AS done`);
}

// Ask HR to correct one of my records (recordId), or to add a period I forgot to clock (recordId null).
export async function requestCorrection(deps: AttendanceDeps, ctx: AuthContext, recordId: string | null, input: PeriodInput): Promise<void> {
  requirePermission(ctx, "self:attendance_clock");
  if (recordId !== null && !isUuid(recordId)) throw notFound("That record");
  if (!input.end || !input.reason) throw invalid("Give the start, the end and a reason.");
  await run(() => staffDb(deps.db, ctx).$queryRaw`
    SELECT app_request_attendance_correction(${recordId}::uuid, ${input.start}::timestamptz, ${input.end}::timestamptz, ${input.breakMinutes}::int, ${input.reason})::text AS id`);
}

export async function withdrawRequest(deps: AttendanceDeps, ctx: AuthContext, requestId: string): Promise<void> {
  requirePermission(ctx, "self:attendance_clock");
  if (!isUuid(requestId)) throw notFound("That request");
  await run(() => staffDb(deps.db, ctx).$queryRaw`SELECT app_withdraw_attendance_correction(${requestId}::uuid)::text AS done`);
}

// ---------------------------------------------------------------------------
// HR: one day (planned versus actual), what needs attention, requests, one record's history
// ---------------------------------------------------------------------------
export type DayRow = { employeeId: string; employeeName: string; employeeCode: string; shifts: (ShiftView & { missed: boolean })[]; records: RecordView[] };
export type DayView = { day: string; rows: DayRow[]; attention: RecordView[]; pendingRequests: number };

export async function getDay(rawDb: Db, ctx: AuthContext, day: string, timeZone: string, now: Date, outletId: string | null): Promise<DayView> {
  requirePermission(ctx, "attendance:read");
  const organizationId = requireOrganizationId(ctx);
  const { start, end } = dayRange(day, timeZone);
  const outlet = outletId && isUuid(outletId) ? outletId : null;
  const db = staffDb(rawDb, ctx);
  const since = new Date(now.getTime() - ATTENDANCE_LIMITS.requestDaysBack * 86_400_000);
  const [shifts, records, attention, pendingRequests] = await db.$transaction(async (tx) => [
    await tx.shift.findMany({
      where: { organizationId, startsAt: { gte: start, lt: end }, ...(outlet ? { outletId: outlet } : {}) },
      orderBy: { startsAt: "asc" },
      select: { ...shiftSelect, records: { select: { status: true } } },
    }),
    await tx.attendanceRecord.findMany({
      where: { organizationId, clockInAt: { gte: start, lt: end }, ...(outlet ? { outletId: outlet } : {}) },
      orderBy: { clockInAt: "asc" },
      select: recordSelect,
    }),
    await tx.attendanceRecord.findMany({
      where: { organizationId, clockInAt: { gte: since }, status: { in: ["OPEN", "MISSING_OUT"] } },
      orderBy: { clockInAt: "asc" },
      take: 100,
      select: recordSelect,
    }),
    await tx.attendanceCorrectionRequest.count({ where: { organizationId, status: "PENDING" } }),
  ] as const);
  const byEmployee = new Map<string, DayRow>();
  const row = (id: string, name: string, code: string) => {
    let r = byEmployee.get(id);
    if (!r) byEmployee.set(id, (r = { employeeId: id, employeeName: name, employeeCode: code, shifts: [], records: [] }));
    return r;
  };
  for (const s of shifts) row(s.employeeId, s.employee.fullName, s.employee.employeeCode).shifts.push({ ...toShiftView(s), missed: isMissedShift(s, s.records as { status: AttendanceStatus }[], now) });
  for (const r of records) row(r.employeeId, r.employee.fullName, r.employee.employeeCode).records.push(toRecordView(r, now));
  return {
    day,
    rows: [...byEmployee.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName)),
    attention: attention.map((r) => toRecordView(r, now)).filter((r) => r.flags.includes("missing_out")),
    pendingRequests,
  };
}

export async function listRequests(rawDb: Db, ctx: AuthContext, status: "PENDING" | "DECIDED"): Promise<RequestView[]> {
  requirePermission(ctx, "attendance:read");
  const organizationId = requireOrganizationId(ctx);
  const rows = await staffDb(rawDb, ctx).attendanceCorrectionRequest.findMany({
    where: { organizationId, ...(status === "PENDING" ? { status: "PENDING" } : { status: { not: "PENDING" } }) },
    orderBy: { createdAt: status === "PENDING" ? "asc" : "desc" },
    take: 100,
    select: requestSelect,
  });
  return rows.map(toRequestView);
}

export type RecordDetail = RecordView & {
  // The record is the signed-in person's own (they may ask HR for a correction).
  mine: boolean;
  device: { inIp: string | null; inUserAgent: string | null; outIp: string | null; outUserAgent: string | null };
  history: { kind: ChangeKind; at: Date; by: string | null; reason: string | null; selfEdit: boolean; before: Record<string, unknown> | null; after: Record<string, unknown> }[];
  requests: RequestView[];
};

// One record with its full history: HR of the organisation, or the employee it belongs to (the database shows
// nothing else). Device details: HR and the employee themselves (within the 90-day retention).
export async function getRecord(rawDb: Db, ctx: AuthContext, recordId: string, now: Date): Promise<RecordDetail> {
  requireAnyPermission(ctx, ["attendance:read", "self:attendance_read"]);
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(recordId)) throw notFound("That record");
  const db = staffDb(rawDb, ctx);
  const r = await db.attendanceRecord.findFirst({
    where: { id: recordId, organizationId },
    select: {
      ...recordSelect, inIp: true, inUserAgent: true, outIp: true, outUserAgent: true,
      changes: { orderBy: { createdAt: "asc" }, select: { kind: true, createdAt: true, reason: true, selfEdit: true, before: true, after: true, changedBy: { select: { name: true } } } },
      requests: { orderBy: { createdAt: "desc" }, select: requestSelect },
    },
  });
  if (!r) throw notFound("That record");
  const mine = r.employeeId === (await myEmployeeId(db));
  return {
    ...toRecordView(r, now),
    mine,
    device: { inIp: r.inIp, inUserAgent: r.inUserAgent, outIp: r.outIp, outUserAgent: r.outUserAgent },
    history: r.changes.map((c) => ({
      kind: c.kind as ChangeKind, at: c.createdAt, by: c.changedBy?.name ?? null, reason: c.reason, selfEdit: c.selfEdit,
      before: (c.before as Record<string, unknown> | null) ?? null, after: c.after as Record<string, unknown>,
    })),
    requests: r.requests.map(toRequestView),
  };
}

// ---------------------------------------------------------------------------
// HR changes to worked time (each one an audit row too; the database keeps the history itself)
// ---------------------------------------------------------------------------
export async function hrRecord(deps: AttendanceDeps, ctx: AuthContext, employeeId: string, outletId: string | null, input: PeriodInput): Promise<{ id: string }> {
  requirePermission(ctx, "attendance:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(employeeId) || (outletId !== null && !isUuid(outletId))) throw notFound("That employee");
  return run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT app_hr_record_attendance(${employeeId}::uuid, ${outletId}::uuid, ${input.start}::timestamptz, ${input.end}::timestamptz, ${input.breakMinutes}::int, ${input.reason})::text AS id`;
    const id = rows[0]!.id;
    await audit(deps, tx, ctx, organizationId, "attendance.recorded", "attendance_record", id, { open: input.end === null });
    return { id };
  }));
}

// "Worked as planned": records the shift's own times and break for a planned shift that is over.
export async function confirmShift(deps: AttendanceDeps, ctx: AuthContext, shiftId: string): Promise<{ id: string }> {
  requirePermission(ctx, "attendance:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(shiftId)) throw notFound("That shift");
  const s = await staffDb(deps.db, ctx).shift.findFirst({ where: { id: shiftId, organizationId, status: "PLANNED" }, select: { employeeId: true, outletId: true, startsAt: true, endsAt: true, breakMinutes: true } });
  if (!s) throw notFound("That shift");
  if (s.endsAt.getTime() > deps.now.getTime()) throw invalid("This shift is not over yet.");
  return hrRecord(deps, ctx, s.employeeId, s.outletId, { start: s.startsAt, end: s.endsAt, breakMinutes: s.breakMinutes, reason: "Worked as planned (rota)" });
}

export async function hrCorrect(deps: AttendanceDeps, ctx: AuthContext, recordId: string, input: PeriodInput, opts: { outletId: string | null; setBreak: boolean }): Promise<void> {
  requirePermission(ctx, "attendance:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(recordId) || (opts.outletId !== null && !isUuid(opts.outletId))) throw notFound("That record");
  if (!input.reason) throw invalid("Give a reason.", { reason: "Give a reason." });
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    await tx.$queryRaw`SELECT app_hr_correct_attendance(${recordId}::uuid, ${input.start}::timestamptz, ${input.end}::timestamptz, ${opts.outletId}::uuid,
                                                        ${opts.setBreak}, ${input.breakMinutes}::int, ${input.reason})::text AS done`;
    await audit(deps, tx, ctx, organizationId, "attendance.corrected", "attendance_record", recordId);
  }));
}

export async function hrVoid(deps: AttendanceDeps, ctx: AuthContext, recordId: string, reason: string): Promise<void> {
  requirePermission(ctx, "attendance:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(recordId)) throw notFound("That record");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    await tx.$queryRaw`SELECT app_hr_void_attendance(${recordId}::uuid, ${reason})::text AS done`;
    await audit(deps, tx, ctx, organizationId, "attendance.voided", "attendance_record", recordId);
  }));
}

export async function decideRequest(deps: AttendanceDeps, ctx: AuthContext, requestId: string, approve: boolean, note: string | null): Promise<void> {
  requirePermission(ctx, "attendance:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(requestId)) throw notFound("That request");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    await tx.$queryRaw`SELECT app_decide_attendance_correction(${requestId}::uuid, ${approve}, ${note})::text AS done`;
    await audit(deps, tx, ctx, organizationId, approve ? "attendance.request_approved" : "attendance.request_rejected", "attendance_request", requestId);
  }));
}

// ---------------------------------------------------------------------------
// Rota
// ---------------------------------------------------------------------------
export type RotaView = {
  weekStart: Date;
  weekEnd: Date;
  shifts: ShiftView[];
  employees: { id: string; fullName: string; employeeCode: string; outletId: string | null }[];
  outlets: { id: string; name: string }[];
};

export async function getRota(rawDb: Db, ctx: AuthContext, range: { start: Date; end: Date }, outletId: string | null): Promise<RotaView> {
  requirePermission(ctx, "attendance:read");
  const organizationId = requireOrganizationId(ctx);
  const outlet = outletId && isUuid(outletId) ? outletId : null;
  const db = staffDb(rawDb, ctx);
  const [shifts, employees, outlets] = await db.$transaction(async (tx) => [
    await tx.shift.findMany({ where: { organizationId, startsAt: { gte: range.start, lt: range.end }, ...(outlet ? { outletId: outlet } : {}) }, orderBy: { startsAt: "asc" }, select: shiftSelect }),
    await tx.employee.findMany({ where: { organizationId, status: "ACTIVE" }, orderBy: { fullName: "asc" }, take: 500, select: { id: true, fullName: true, employeeCode: true, outletId: true } }),
    await tx.outlet.findMany({ where: { organizationId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ] as const);
  return { weekStart: range.start, weekEnd: range.end, shifts: shifts.map(toShiftView), employees, outlets };
}

export async function createShift(deps: AttendanceDeps, ctx: AuthContext, input: ShiftInput): Promise<{ id: string }> {
  requirePermission(ctx, "attendance:manage");
  const organizationId = requireOrganizationId(ctx);
  return run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    const s = await tx.shift.create({
      data: { organizationId, employeeId: input.employeeId, outletId: input.outletId, startsAt: input.startsAt, endsAt: input.endsAt, breakMinutes: input.breakMinutes, note: input.note },
      select: { id: true },
    });
    await audit(deps, tx, ctx, organizationId, "shift.created", "shift", s.id);
    return s;
  }));
}

export async function updateShift(deps: AttendanceDeps, ctx: AuthContext, shiftId: string, input: Omit<ShiftInput, "employeeId">): Promise<void> {
  requirePermission(ctx, "attendance:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(shiftId)) throw notFound("That shift");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    const r = await tx.shift.updateMany({
      where: { id: shiftId, organizationId, status: "PLANNED" },
      data: { outletId: input.outletId, startsAt: input.startsAt, endsAt: input.endsAt, breakMinutes: input.breakMinutes, note: input.note },
    });
    if (r.count !== 1) throw notFound("That shift");
    await audit(deps, tx, ctx, organizationId, "shift.updated", "shift", shiftId);
  }));
}

export async function cancelShift(deps: AttendanceDeps, ctx: AuthContext, shiftId: string, reason: string): Promise<void> {
  requirePermission(ctx, "attendance:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(shiftId)) throw notFound("That shift");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    const r = await tx.shift.updateMany({ where: { id: shiftId, organizationId, status: "PLANNED" }, data: { status: "CANCELLED", cancelReason: reason } });
    if (r.count !== 1) throw notFound("That shift");
    await audit(deps, tx, ctx, organizationId, "shift.cancelled", "shift", shiftId);
  }));
}

// Copies the planned shifts of one week (optionally one outlet) to the next week, at the same local wall-clock times.
// Shifts the rules refuse (in the past, overlapping, employee left, outlet closed, a time that does not exist after a
// clock change) are skipped and counted; any other failure stops the copy and is reported.
export async function copyWeek(deps: AttendanceDeps, ctx: AuthContext, from: { start: Date; end: Date }, outletId: string | null, timeZone: string): Promise<{ created: number; skipped: number }> {
  requirePermission(ctx, "attendance:manage");
  const organizationId = requireOrganizationId(ctx);
  const outlet = outletId && isUuid(outletId) ? outletId : null;
  const db = staffDb(deps.db, ctx);
  const source = await db.shift.findMany({ where: { organizationId, status: "PLANNED", startsAt: { gte: from.start, lt: from.end }, ...(outlet ? { outletId: outlet } : {}) }, select: { employeeId: true, outletId: true, startsAt: true, endsAt: true, breakMinutes: true, note: true } });
  if (source.length > 300) throw invalid("That week has too many shifts to copy at once.");
  let created = 0;
  let skipped = 0;
  try {
    for (const s of source) {
      const moved = shiftByDays(s.startsAt, s.endsAt, 7, timeZone);
      if (!moved) {
        skipped++;
        continue;
      }
      try {
        await createShift(deps, ctx, { employeeId: s.employeeId, outletId: s.outletId, startsAt: moved.start, endsAt: moved.end, breakMinutes: s.breakMinutes, note: s.note });
        created++;
      } catch (e) {
        if (e instanceof RecruitmentError && (e.code === "conflict" || e.code === "invalid")) skipped++;
        else throw e;
      }
    }
  } finally {
    if (created + skipped > 0) await db.$transaction(async (tx) => audit(deps, tx, ctx, organizationId, "rota.copied", "shift", organizationId, { created, skipped }));
  }
  return { created, skipped };
}

// ---------------------------------------------------------------------------
// Standard shifts: outlet hours, each employee's standard, filling the rota, and shift history
// ---------------------------------------------------------------------------
export type StandardsView = {
  outlets: { id: string; name: string; opening: string | null; changeover: string | null; closing: string | null; breakMinutes: number }[];
  employees: { id: string; fullName: string; employeeCode: string; outletId: string | null; outlet: string | null; standardShift: StandardShift | null; workDays: number[] }[];
};

export async function getStandards(rawDb: Db, ctx: AuthContext): Promise<StandardsView> {
  requirePermission(ctx, "attendance:read");
  const organizationId = requireOrganizationId(ctx);
  const [outlets, employees] = await staffDb(rawDb, ctx).$transaction(async (tx) => [
    await tx.outlet.findMany({ where: { organizationId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, openingTime: true, changeoverTime: true, closingTime: true, shiftBreakMinutes: true } }),
    await tx.employee.findMany({
      where: { organizationId, status: "ACTIVE" },
      orderBy: { fullName: "asc" },
      take: 500,
      select: { id: true, fullName: true, employeeCode: true, outletId: true, outlet: { select: { name: true } }, shiftPatterns: { select: { standardShift: true, workDays: true } } },
    }),
  ] as const);
  return {
    outlets: outlets.map((o) => ({ id: o.id, name: o.name, opening: dateToTime(o.openingTime), changeover: dateToTime(o.changeoverTime), closing: dateToTime(o.closingTime), breakMinutes: o.shiftBreakMinutes })),
    employees: employees.map((e) => ({
      id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, outletId: e.outletId, outlet: e.outlet?.name ?? null,
      standardShift: e.shiftPatterns[0]?.standardShift ?? null, workDays: e.shiftPatterns[0]?.workDays ?? [],
    })),
  };
}

// Brings the next 14 days of the rota in line with the standard now (the daily job does the same every morning).
// Days HR changed or added by hand are left alone. Returns how many shifts were added.
export async function applyStandard(deps: AttendanceDeps, ctx: AuthContext): Promise<number> {
  requirePermission(ctx, "attendance:manage");
  // It may wait for the daily run (one fill per organisation at a time), so it gets more than Prisma's default 5 s.
  const rows = await run(() => staffDb(deps.db, ctx).$transaction(
    async (tx) => tx.$queryRaw<{ n: number }[]>`SELECT app_apply_standard_shifts() AS n`,
    { timeout: 30_000, maxWait: 10_000 },
  ));
  return Number(rows[0]?.n ?? 0);
}

// After a save: fill the rota now. The save itself has already succeeded, so a failure here is reported as such
// (null), not as "nothing was saved"; the daily run fills the rota again anyway.
async function applyAfterSave(deps: AttendanceDeps, ctx: AuthContext): Promise<number | null> {
  try {
    return await applyStandard(deps, ctx);
  } catch {
    return null;
  }
}

// Sets (or clears, with null) an outlet's standard hours, then applies the standard (null: saved, not applied).
export async function setOutletHours(deps: AttendanceDeps, ctx: AuthContext, outletId: string, hours: OutletHoursInput | null): Promise<number | null> {
  requirePermission(ctx, "attendance:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(outletId)) throw notFound("That outlet");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    const r = await tx.outlet.updateMany({
      where: { id: outletId, organizationId },
      data: hours
        ? { openingTime: timeToDate(hours.opening), changeoverTime: timeToDate(hours.changeover), closingTime: timeToDate(hours.closing), shiftBreakMinutes: hours.breakMinutes }
        : { openingTime: null, changeoverTime: null, closingTime: null },
    });
    if (r.count !== 1) throw notFound("That outlet");
    await audit(deps, tx, ctx, organizationId, "outlet.hours_set", "outlet", outletId, hours ? { ...hours } : { cleared: true });
  }));
  return applyAfterSave(deps, ctx);
}

// Sets (or clears, with null) an employee's standard shift and working days, then applies the standard
// (null: saved, not applied).
export async function setEmployeeStandard(deps: AttendanceDeps, ctx: AuthContext, employeeId: string, standard: StandardInput | null): Promise<number | null> {
  requirePermission(ctx, "attendance:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(employeeId)) throw notFound("That employee");
  const save = () => run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    const employee = await tx.employee.findFirst({ where: { id: employeeId, organizationId, status: "ACTIVE" }, select: { id: true } });
    if (!employee) throw notFound("That employee");
    if (standard) {
      const updated = await tx.employeeShiftPattern.updateMany({ where: { employeeId, organizationId }, data: { standardShift: standard.standardShift, workDays: standard.workDays } });
      if (updated.count === 0) await tx.employeeShiftPattern.create({ data: { organizationId, employeeId, standardShift: standard.standardShift, workDays: standard.workDays }, select: { id: true } });
    } else {
      await tx.employeeShiftPattern.deleteMany({ where: { employeeId, organizationId } });
    }
    await audit(deps, tx, ctx, organizationId, "employee.standard_set", "employee", employeeId, standard ? { standardShift: standard.standardShift, workDays: standard.workDays.join(",") } : { cleared: true });
  }));
  try {
    await save();
  } catch (e) {
    // Two saves of a first standard at the same moment: the other one created the row first. Save again (an update now).
    if ((e as { code?: unknown })?.code === "P2002" || /employee_shift_patterns_employee_id_key/.test(String((e as Error)?.message ?? ""))) await save();
    else throw e;
  }
  return applyAfterSave(deps, ctx);
}

export type ShiftHistoryItem = { kind: "CREATED" | "CHANGED" | "CANCELLED"; at: Date; by: string | null; system: boolean; before: Record<string, unknown> | null; after: Record<string, unknown> };

// Every change of one shift, oldest first (HR only; the database keeps it, nobody can edit it).
export async function getShiftHistory(rawDb: Db, ctx: AuthContext, shiftId: string): Promise<ShiftHistoryItem[]> {
  requirePermission(ctx, "attendance:read");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(shiftId)) throw notFound("That shift");
  const db = staffDb(rawDb, ctx);
  // A missing shift, or one of another organisation (hidden by row-level security), is "not found", not "no history".
  if (!(await db.shift.findFirst({ where: { id: shiftId, organizationId }, select: { id: true } }))) throw notFound("That shift");
  const rows = await db.shiftChange.findMany({
    where: { shiftId, organizationId },
    orderBy: { createdAt: "asc" },
    select: { kind: true, createdAt: true, before: true, after: true, changedById: true, changedBy: { select: { name: true } } },
  });
  return rows.map((c) => ({
    kind: c.kind, at: c.createdAt, by: c.changedBy?.name ?? null, system: c.changedById === null,
    before: (c.before as Record<string, unknown> | null) ?? null, after: c.after as Record<string, unknown>,
  }));
}
