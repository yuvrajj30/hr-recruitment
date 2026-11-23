// Attendance: pure rules (no database, no server-only code), shared by the server and the screens.
// The database enforces its own limits again (migrations 20261122000000..20261122000200); the numbers below must
// match those migrations.
import { dateToZonedInput, zonedInputToDate } from "@/lib/interviews/rules";

export const ATTENDANCE_LIMITS = {
  lateGraceMinutes: 5, // arriving up to 5 minutes after the planned start is not "late"
  earlyGraceMinutes: 5,
  abandonAfterHours: 20, // an OPEN record older than this is "missing its clock-out" (database: att_is_abandoned)
  abandonAfterShiftEndHours: 4, // ... or this long after the end of its shift
  maxShiftHours: 16,
  maxRecordHours: 24,
  maxShiftBreakMinutes: 240,
  requestDaysBack: 31,
  deviceRetentionDays: 90,
  reasonMax: 500,
} as const;

export type AttendanceStatus = "OPEN" | "CLOSED" | "MISSING_OUT" | "VOID";
export type AttendanceSource = "SELF" | "HR" | "CORRECTION";
export type ChangeKind = "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END" | "HR_RECORDED" | "CORRECTED" | "MARKED_MISSING_OUT" | "VOIDED";
export type RequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "SUPERSEDED";

export const STATUS_LABELS: Record<AttendanceStatus, string> = { OPEN: "Clocked in", CLOSED: "Complete", MISSING_OUT: "Missing clock-out", VOID: "Void" };
export const SOURCE_LABELS: Record<AttendanceSource, string> = { SELF: "Self", HR: "HR", CORRECTION: "Correction" };
export const CHANGE_LABELS: Record<ChangeKind, string> = {
  CLOCK_IN: "Clocked in", CLOCK_OUT: "Clocked out", BREAK_START: "Break started", BREAK_END: "Break ended",
  HR_RECORDED: "Recorded by HR", CORRECTED: "Corrected", MARKED_MISSING_OUT: "Marked as missing clock-out", VOIDED: "Voided",
};
export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  PENDING: "Waiting for HR", APPROVED: "Approved", REJECTED: "Rejected", WITHDRAWN: "Withdrawn", SUPERSEDED: "Replaced by a newer change",
};

// ---------------------------------------------------------------------------
// Worked time and flags
// ---------------------------------------------------------------------------
export type BreakLike = { startsAt: Date; endsAt: Date | null };
export type RecordLike = {
  status: AttendanceStatus;
  clockInAt: Date;
  clockOutAt: Date | null;
  breakMinutes: number | null;
  breaks: BreakLike[];
  shift: { startsAt: Date; endsAt: Date; breakMinutes: number } | null;
};

const MIN = 60_000;

// Break minutes: the number HR or a correction set, else the sum of the recorded breaks (an open break up to `now`).
export function breakMinutesOf(r: Pick<RecordLike, "breakMinutes" | "breaks">, now: Date): number {
  if (r.breakMinutes !== null) return r.breakMinutes;
  const ms = r.breaks.reduce((sum, b) => sum + Math.max(0, (b.endsAt ?? now).getTime() - b.startsAt.getTime()), 0);
  return Math.floor(ms / MIN);
}

// Worked minutes of a finished record (null while open, missing its clock-out or void).
export function workedMinutes(r: RecordLike, now: Date): number | null {
  if (r.status !== "CLOSED" || !r.clockOutAt) return null;
  return Math.max(0, Math.floor((r.clockOutAt.getTime() - r.clockInAt.getTime()) / MIN) - breakMinutesOf(r, now));
}

// An OPEN record that was left behind (the database applies the same rule at the next clock-in / clock-out).
export function isAbandoned(r: Pick<RecordLike, "status" | "clockInAt" | "shift">, now: Date): boolean {
  if (r.status !== "OPEN") return false;
  if (now.getTime() - r.clockInAt.getTime() > ATTENDANCE_LIMITS.abandonAfterHours * 60 * MIN) return true;
  return Boolean(r.shift && now.getTime() > r.shift.endsAt.getTime() + ATTENDANCE_LIMITS.abandonAfterShiftEndHours * 60 * MIN);
}

export type RecordFlag = "late" | "early" | "unplanned" | "missing_out";
export const FLAG_LABELS: Record<RecordFlag | "missed", string> = {
  late: "Late",
  early: "Left early",
  unplanned: "Not on the rota",
  missing_out: "Missing clock-out",
  missed: "Missed shift",
};

// What HR should look at for one record. Void records have none.
export function recordFlags(r: RecordLike, now: Date): RecordFlag[] {
  if (r.status === "VOID") return [];
  const flags: RecordFlag[] = [];
  if (r.status === "MISSING_OUT" || isAbandoned(r, now)) flags.push("missing_out");
  if (!r.shift) flags.push("unplanned");
  else {
    if (r.clockInAt.getTime() > r.shift.startsAt.getTime() + ATTENDANCE_LIMITS.lateGraceMinutes * MIN) flags.push("late");
    if (r.clockOutAt && r.clockOutAt.getTime() < r.shift.endsAt.getTime() - ATTENDANCE_LIMITS.earlyGraceMinutes * MIN) flags.push("early");
  }
  return flags;
}

// Minutes late (0 when on time or unplanned).
export function minutesLate(r: Pick<RecordLike, "clockInAt" | "shift">): number {
  if (!r.shift) return 0;
  return Math.max(0, Math.floor((r.clockInAt.getTime() - r.shift.startsAt.getTime()) / MIN));
}

// A planned shift that is over and has no (non-void) record linked to it.
export function isMissedShift(shift: { status: "PLANNED" | "CANCELLED"; endsAt: Date }, linkedRecords: { status: AttendanceStatus }[], now: Date): boolean {
  return shift.status === "PLANNED" && shift.endsAt.getTime() <= now.getTime() && !linkedRecords.some((r) => r.status !== "VOID");
}

export function formatMinutes(total: number | null): string {
  if (total === null) return "—";
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// Local days (the organisation's time zone). A record or shift belongs to the day it STARTS on.
// ---------------------------------------------------------------------------
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isDay(s: string): boolean {
  if (!DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const localDay = (moment: Date, timeZone: string): string => dateToZonedInput(moment, timeZone).slice(0, 10);
export const localTime = (moment: Date, timeZone: string): string => dateToZonedInput(moment, timeZone).slice(11, 16);

// The first moment of a local day. Midnight can be missing on a DST change: then the first real minute after it.
export function dayStart(day: string, timeZone: string): Date {
  for (let minutes = 0; minutes < 180; minutes += 15) {
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    const d = zonedInputToDate(`${day}T${hh}:${mm}`, timeZone);
    if (d) return d;
  }
  throw new Error(`No start of day for ${day} in ${timeZone}`);
}

// [start of `day`, start of the next day): 23, 24 or 25 hours long.
export const dayRange = (day: string, timeZone: string) => ({ start: dayStart(day, timeZone), end: dayStart(addDays(day, 1), timeZone) });

// Monday of the week that contains `day`.
export function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------
export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };
const text = (v: unknown): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

// A period given as a local day, a start time and an end time. An end at or before the start is the next day
// (night work). `endOptional`: an empty end time means "still working" (HR opening a record).
export type PeriodFields = { day?: string; start?: string; end?: string };
export function parsePeriod(raw: PeriodFields, timeZone: string, opts: { endOptional?: boolean; maxHours: number }): Parsed<{ start: Date; end: Date | null }> {
  const errors: Record<string, string> = {};
  const day = text(raw.day);
  const start = text(raw.start);
  const end = text(raw.end);
  if (!isDay(day)) errors.day = "Choose the day.";
  if (!TIME.test(start)) errors.start = "Enter the start time, e.g. 09:00.";
  if (end === "" && !opts.endOptional) errors.end = "Enter the end time.";
  else if (end !== "" && !TIME.test(end)) errors.end = "Enter the end time, e.g. 17:30.";
  if (Object.keys(errors).length) return { ok: false, errors };
  const s = zonedInputToDate(`${day}T${start}`, timeZone);
  if (!s) return { ok: false, errors: { start: "That time does not exist on this day (clock change)." } };
  if (end === "") return { ok: true, value: { start: s, end: null } };
  const endDay = end <= start ? addDays(day, 1) : day;
  const e = zonedInputToDate(`${endDay}T${end}`, timeZone);
  if (!e) return { ok: false, errors: { end: "That time does not exist on this day (clock change)." } };
  if (e.getTime() - s.getTime() > opts.maxHours * 60 * MIN) return { ok: false, errors: { end: `A period can be at most ${opts.maxHours} hours.` } };
  return { ok: true, value: { start: s, end: e } };
}

function parseBreak(raw: unknown, errors: Record<string, string>, max: number): number | null {
  const v = text(raw);
  if (v === "") return null;
  if (!/^\d{1,3}$/.test(v) || Number(v) > max) {
    errors.breakMinutes = `Enter the break in minutes (0 to ${max}).`;
    return null;
  }
  return Number(v);
}

function parseReason(raw: unknown, errors: Record<string, string>, required: boolean): string | null {
  const v = text(raw);
  if (!v) {
    if (required) errors.reason = "Give a reason.";
    return null;
  }
  if (v.length > ATTENDANCE_LIMITS.reasonMax) errors.reason = `Keep it under ${ATTENDANCE_LIMITS.reasonMax} characters.`;
  return v;
}

export type ShiftInput = { employeeId: string; outletId: string; startsAt: Date; endsAt: Date; breakMinutes: number; note: string | null };
export type ShiftFields = PeriodFields & { employeeId?: string; outletId?: string; breakMinutes?: string; note?: string };
export function parseShiftInput(raw: ShiftFields, timeZone: string, now: Date): Parsed<ShiftInput> {
  const errors: Record<string, string> = {};
  if (!isUuid(text(raw.employeeId))) errors.employeeId = "Choose the employee.";
  if (!isUuid(text(raw.outletId))) errors.outletId = "Choose the outlet.";
  const period = parsePeriod(raw, timeZone, { maxHours: ATTENDANCE_LIMITS.maxShiftHours });
  if (!period.ok) Object.assign(errors, period.errors);
  const breakMinutes = parseBreak(raw.breakMinutes, errors, ATTENDANCE_LIMITS.maxShiftBreakMinutes) ?? 0;
  const note = text(raw.note) || null;
  if (note && note.length > 500) errors.note = "Keep the note under 500 characters.";
  if (period.ok) {
    const { start, end } = period.value;
    if (end!.getTime() <= now.getTime()) errors.end = "This shift is already over. Record the time worked instead.";
    if (breakMinutes * MIN >= end!.getTime() - start.getTime()) errors.breakMinutes = "The break must be shorter than the shift.";
  }
  if (Object.keys(errors).length || !period.ok) return { ok: false, errors };
  return { ok: true, value: { employeeId: text(raw.employeeId), outletId: text(raw.outletId), startsAt: period.value.start, endsAt: period.value.end!, breakMinutes, note } };
}

// A worked period recorded by HR, a correction by HR, or an employee's correction request.
export type PeriodInput = { start: Date; end: Date | null; breakMinutes: number | null; reason: string | null };
export type PeriodInputFields = PeriodFields & { breakMinutes?: string; reason?: string };
export function parsePeriodInput(
  raw: PeriodInputFields,
  timeZone: string,
  now: Date,
  opts: { endOptional?: boolean; reasonRequired: boolean; maxDaysBack?: number },
): Parsed<PeriodInput> {
  const errors: Record<string, string> = {};
  const period = parsePeriod(raw, timeZone, { endOptional: opts.endOptional, maxHours: ATTENDANCE_LIMITS.maxRecordHours });
  if (!period.ok) Object.assign(errors, period.errors);
  const breakMinutes = parseBreak(raw.breakMinutes, errors, 600);
  const reason = parseReason(raw.reason, errors, opts.reasonRequired);
  if (period.ok) {
    const { start, end } = period.value;
    if (start.getTime() > now.getTime()) errors.start = "The start cannot be in the future.";
    if (end && end.getTime() > now.getTime()) errors.end = "The end cannot be in the future.";
    if (opts.maxDaysBack && start.getTime() < now.getTime() - opts.maxDaysBack * 24 * 60 * MIN) errors.day = `Only the last ${opts.maxDaysBack} days can be changed this way.`;
    if (breakMinutes !== null && (!end || breakMinutes * MIN >= end.getTime() - start.getTime())) errors.breakMinutes = "The break must be shorter than the time worked.";
  }
  if (Object.keys(errors).length || !period.ok) return { ok: false, errors };
  return { ok: true, value: { start: period.value.start, end: period.value.end, breakMinutes, reason } };
}

// ---------------------------------------------------------------------------
// Standard shifts: outlet hours and an employee's standard
// ---------------------------------------------------------------------------
export const STANDARD_SHIFTS = ["MORNING", "EVENING"] as const;
export type StandardShift = (typeof STANDARD_SHIFTS)[number];
export const STANDARD_SHIFT_LABELS: Record<StandardShift, string> = { MORNING: "Morning", EVENING: "Evening" };
export const WEEKDAYS = [
  { n: 1, short: "Mon" }, { n: 2, short: "Tue" }, { n: 3, short: "Wed" }, { n: 4, short: "Thu" },
  { n: 5, short: "Fri" }, { n: 6, short: "Sat" }, { n: 7, short: "Sun" },
] as const;
export const STANDARD_DAYS_AHEAD = 14; // the database fills this many days (app_apply_standard_shifts)

// "HH:MM" <-> the Date Prisma uses for a TIME column (1970-01-01, UTC).
export const timeToDate = (hhmm: string): Date => new Date(`1970-01-01T${hhmm}:00Z`);
export const dateToTime = (d: Date | null): string | null => (d ? d.toISOString().slice(11, 16) : null);

export type OutletHoursInput = { opening: string; changeover: string; closing: string; breakMinutes: number };
export function parseOutletHours(raw: { opening?: string; changeover?: string; closing?: string; breakMinutes?: string }): Parsed<OutletHoursInput> {
  const errors: Record<string, string> = {};
  const opening = text(raw.opening);
  const changeover = text(raw.changeover);
  const closing = text(raw.closing);
  if (!TIME.test(opening)) errors.opening = "Enter the opening time, e.g. 08:00.";
  if (!TIME.test(changeover)) errors.changeover = "Enter the time the evening shift starts, e.g. 15:00.";
  if (!TIME.test(closing)) errors.closing = "Enter the closing time, e.g. 23:00 (00:00 for midnight).";
  const breakMinutes = parseBreak(raw.breakMinutes, errors, ATTENDANCE_LIMITS.maxShiftBreakMinutes) ?? 0;
  if (!Object.keys(errors).length) {
    if (changeover <= opening) errors.changeover = "The evening shift must start after opening time.";
    else if (closing === changeover) errors.closing = "Closing must differ from the evening start.";
    else {
      const minutes = (a: string, b: string) => {
        const [ah, am] = a.split(":").map(Number);
        const [bh, bm] = b.split(":").map(Number);
        const d = bh! * 60 + bm! - (ah! * 60 + am!);
        return d > 0 ? d : d + 24 * 60;
      };
      if (minutes(changeover, closing) > ATTENDANCE_LIMITS.maxShiftHours * 60) errors.closing = `The evening shift can be at most ${ATTENDANCE_LIMITS.maxShiftHours} hours.`;
      if (minutes(opening, changeover) > ATTENDANCE_LIMITS.maxShiftHours * 60) errors.changeover = `The morning shift can be at most ${ATTENDANCE_LIMITS.maxShiftHours} hours.`;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { opening, changeover, closing, breakMinutes } };
}

export type StandardInput = { standardShift: StandardShift; workDays: number[] };
export function parseStandard(raw: { standardShift?: string; workDays?: string[] }): Parsed<StandardInput | null> {
  const shift = text(raw.standardShift);
  if (shift === "" || shift === "NONE") return { ok: true, value: null };
  if (!(STANDARD_SHIFTS as readonly string[]).includes(shift)) return { ok: false, errors: { standardShift: "Choose Morning, Evening or none." } };
  const days = [...new Set((raw.workDays ?? []).map((d) => Number(d)))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort();
  if (!days.length) return { ok: false, errors: { workDays: "Choose at least one working day." } };
  return { ok: true, value: { standardShift: shift as StandardShift, workDays: days } };
}

export function parseRequiredReason(raw: unknown): Parsed<string> {
  const errors: Record<string, string> = {};
  const reason = parseReason(raw, errors, true);
  return reason && !Object.keys(errors).length ? { ok: true, value: reason } : { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Database refusals (raised by the attendance functions) -> messages for people
// ---------------------------------------------------------------------------
export const DB_MESSAGES: Record<string, string> = {
  no_employee_record: "Your account is not linked to an employee record yet. Ask HR to link it.",
  employee_not_active: "This employee cannot work on that day (not joined yet, or already left).",
  already_clocked_in: "You are already clocked in.",
  not_clocked_in: "You are not clocked in.",
  already_on_break: "You are already on a break.",
  not_on_break: "You are not on a break.",
  too_many_breaks: "That is the most breaks one clock-in can have. Ask HR if something is wrong.",
  too_many_punches: "Too many clock-ins in the last 24 hours. Ask HR to check your attendance.",
  attendance_overlap: "That time overlaps another attendance record of this employee.",
  attendance_bad_period: "Check the times: the end must be after the start, both in the past, at most 24 hours apart.",
  attendance_outside_employment: "That time is outside this person's employment (before joining or after leaving).",
  attendance_bad_break: "The break must be shorter than the time worked.",
  attendance_breaks_outside: "Recorded breaks fall outside the new times. Enter the break minutes as well.",
  attendance_void: "This record was voided and can no longer be changed.",
  record_not_correctable: "Only your finished records (or ones missing a clock-out) can be corrected.",
  request_pending: "There is already a correction request waiting for this record.",
  too_many_requests: "You have 10 requests waiting. Wait for HR to decide some first.",
  request_not_pending: "This request has already been dealt with.",
  own_request: "Someone else in HR must decide your own correction request.",
  decision_note_required: "Give a note when rejecting a request.",
  reason_required: "Give a reason.",
  reason_too_long: "Keep the reason under 500 characters.",
  invalid_timezone: "The organisation's time zone is not set correctly. Ask a Super Admin to fix it in settings.",
  shift_in_past: "Shifts can only be planned for the future.",
  shift_started: "This shift has started: its start and outlet can no longer change.",
  shift_over: "This shift is over and can no longer change.",
  shift_cancelled: "This shift was cancelled and can no longer change.",
  shift_cancel_only: "Cancelling a shift changes nothing else.",
  shift_before_joining: "This shift is before the employee's joining date.",
  outlet_not_active: "Choose an active outlet.",
  shifts_no_overlap: "This employee already has a shift at that time.",
  outlets_hours_check: "Check the hours: the evening shift must start after opening, and closing must differ from it.",
  outlets_hours_length_check: "Each standard shift can be at most 16 hours.",
  employee_shift_patterns_days_check: "Choose at least one working day.",
  employee_clocked_in: "This employee is clocked in. Close their attendance record first.",
  employee_joined_after_attendance: "This employee has attendance or planned shifts before that joining date.",
  employee_attendance_after_exit: "This employee has attendance after that day. Choose a later last working day, or correct the attendance first.",
  on_leave: "You are on leave today. Ask HR if that is wrong.",
  not_found: "That record was not found.",
};

// The message PostgreSQL itself returned, out of a Prisma error ("... Message: `already_clocked_in`"), or null.
// Refusal codes are looked up in this only: a whole Prisma error can echo what a user typed (e.g. a note).
export function databaseMessage(error: unknown): string | null {
  const e = error as { message?: unknown; meta?: Record<string, unknown> } | null;
  const fromText = typeof e?.message === "string" ? /Message: `([^`]*)`/.exec(e.message)?.[1] : undefined;
  const adapter = e?.meta?.driverAdapterError as { cause?: { originalMessage?: unknown; message?: unknown } } | undefined;
  for (const m of [fromText, e?.meta?.message, adapter?.cause?.originalMessage, adapter?.cause?.message]) if (typeof m === "string" && m) return m;
  return null;
}

// The same wall-clock times some days later (a 09:00 shift stays at 09:00 across a clock change), or null when that
// local time does not exist on the new day.
export function shiftByDays(start: Date, end: Date, days: number, timeZone: string): { start: Date; end: Date } | null {
  const move = (d: Date) => zonedInputToDate(`${addDays(localDay(d, timeZone), days)}T${localTime(d, timeZone)}`, timeZone);
  const s = move(start);
  const e = move(end);
  return s && e && e.getTime() > s.getTime() ? { start: s, end: e } : null;
}

// The first known refusal code in a database message, if any.
export function dbRefusal(message: string): string | null {
  for (const code of Object.keys(DB_MESSAGES)) if (new RegExp(`\\b${code}\\b`).test(message)) return code;
  return null;
}
