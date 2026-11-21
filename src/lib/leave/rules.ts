// Leave: pure rules (no database). Input parsing for the screens, the year-end split, display helpers and the
// messages for the database's refusals. The database functions (migration 20261123000100_leave_functions) check
// everything again; these checks only give people a clear message before the database is asked.
import { addDays, isDay, isUuid, type Parsed } from "@/lib/attendance/rules";

export const LEAVE_LIMITS = { daysBack: 31, daysAhead: 365, reasonMax: 500 } as const;

export const LEAVE_ACCRUALS = ["NONE", "YEARLY", "MONTHLY"] as const;
export type LeaveAccrual = (typeof LEAVE_ACCRUALS)[number];
export const ACCRUAL_LABELS: Record<LeaveAccrual, string> = { NONE: "No balance (credited by HR)", YEARLY: "Granted each January", MONTHLY: "Builds up monthly" };

export type LeaveRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "CANCELLED";
export const LEAVE_STATUS_LABELS: Record<LeaveRequestStatus, string> = {
  PENDING: "Waiting", APPROVED: "Approved", REJECTED: "Rejected", WITHDRAWN: "Withdrawn", CANCELLED: "Cancelled",
};
export type LeaveLedgerKind = "GRANT" | "ACCRUAL" | "TAKEN" | "RESTORED" | "ADJUSTMENT" | "CARRY_OVER" | "EXPIRED";
export const LEDGER_KIND_LABELS: Record<LeaveLedgerKind, string> = {
  GRANT: "Yearly grant", ACCRUAL: "Monthly accrual", TAKEN: "Leave taken", RESTORED: "Days returned", ADJUSTMENT: "HR adjustment",
  CARRY_OVER: "Carried over", EXPIRED: "Expired at year end",
};

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const flag = (v: unknown): boolean => v === true || v === "on" || v === "true" || v === "1";
// A number of days in half-day steps, or null when it is not one.
function halfSteps(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : text(v);
  if (!/^-?\d{1,3}(\.\d)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n * 2) ? n : null;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
export type LeaveRequestInput = { typeId: string; start: string; end: string; startHalf: boolean; endHalf: boolean; note: string | null };
export type LeaveRequestFields = { typeId?: unknown; start?: unknown; end?: unknown; startHalf?: unknown; endHalf?: unknown; note?: unknown };

// today: the organisation's local date (YYYY-MM-DD).
export function parseLeaveRequest(raw: LeaveRequestFields, today: string): Parsed<LeaveRequestInput> {
  const errors: Record<string, string> = {};
  const typeId = text(raw.typeId);
  if (!isUuid(typeId)) errors.typeId = "Choose a leave type.";
  const start = text(raw.start);
  const end = text(raw.end);
  if (!isDay(start)) errors.start = "Enter the first day.";
  if (!isDay(end)) errors.end = "Enter the last day.";
  if (!errors.start && !errors.end && end < start) errors.end = "The last day must be on or after the first day.";
  if (!errors.start && start < addDays(today, -LEAVE_LIMITS.daysBack)) errors.start = `Leave can be entered at most ${LEAVE_LIMITS.daysBack} days back.`;
  if (!errors.end && end > addDays(today, LEAVE_LIMITS.daysAhead)) errors.end = `Leave can be requested at most ${LEAVE_LIMITS.daysAhead} days ahead.`;
  const note = text(raw.note);
  if (note.length > LEAVE_LIMITS.reasonMax) errors.note = `Keep the note under ${LEAVE_LIMITS.reasonMax} characters.`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { typeId, start, end, startHalf: flag(raw.startHalf), endHalf: flag(raw.endHalf), note: note || null } };
}

// The database never lets one request cross a year (balances are per calendar year), so a range over 31 December
// becomes one part per year.
export function splitAtYearEnd(start: string, end: string): [string, string][] {
  const parts: [string, string][] = [];
  let from = start;
  while (from.slice(0, 4) < end.slice(0, 4)) {
    const yearEnd = `${from.slice(0, 4)}-12-31`;
    parts.push([from, yearEnd]);
    from = addDays(yearEnd, 1);
  }
  parts.push([from, end]);
  return parts;
}

// 1.5 -> "1½ days", 0.5 -> "½ day", 1 -> "1 day".
export function formatDays(n: number): string {
  const abs = Math.abs(n);
  const whole = Math.floor(abs);
  const half = abs - whole >= 0.5;
  const num = `${n < 0 ? "−" : ""}${whole || !half ? whole : ""}${half ? "½" : ""}`;
  return `${num} ${abs > 0 && abs <= 1 ? "day" : "days"}`;
}

// ---------------------------------------------------------------------------
// HR set-up: leave types, holidays, adjustments
// ---------------------------------------------------------------------------
export type LeaveTypeInput = {
  code: string; name: string; paid: boolean; accrual: LeaveAccrual; daysPerYear: number; carryOverMax: number; noteRequired: boolean; isActive: boolean;
};
export type LeaveTypeFields = Partial<Record<keyof LeaveTypeInput, unknown>>;

export function parseLeaveType(raw: LeaveTypeFields): Parsed<LeaveTypeInput> {
  const errors: Record<string, string> = {};
  const code = text(raw.code).toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(code)) errors.code = "Use 2 to 10 letters or digits, starting with a letter (for example CL).";
  const name = text(raw.name);
  if (!name || name.length > 60) errors.name = "Give a name of up to 60 characters.";
  const paid = flag(raw.paid);
  const accrual = text(raw.accrual) as LeaveAccrual;
  if (!LEAVE_ACCRUALS.includes(accrual)) errors.accrual = "Choose how the days are credited.";
  const daysPerYear = halfSteps(raw.daysPerYear);
  if (daysPerYear === null || daysPerYear < 0 || daysPerYear > 366) errors.daysPerYear = "Enter 0 to 366 days, in half days.";
  const carryOverMax = halfSteps(raw.carryOverMax);
  if (carryOverMax === null || carryOverMax < 0 || carryOverMax > 366) errors.carryOverMax = "Enter 0 to 366 days, in half days.";
  if (!paid && !errors.accrual && !errors.daysPerYear && !errors.carryOverMax && (accrual !== "NONE" || daysPerYear !== 0 || carryOverMax !== 0)) {
    errors.daysPerYear = "Unpaid leave has no balance: choose no balance, with 0 days and no carry-over.";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: { code, name, paid, accrual, daysPerYear: daysPerYear!, carryOverMax: carryOverMax!, noteRequired: flag(raw.noteRequired), isActive: flag(raw.isActive) },
  };
}

export type HolidayInput = { day: string; name: string; outletId: string | null };
export function parseHoliday(raw: { day?: unknown; name?: unknown; outletId?: unknown }): Parsed<HolidayInput> {
  const errors: Record<string, string> = {};
  const day = text(raw.day);
  if (!isDay(day)) errors.day = "Enter the day.";
  const name = text(raw.name);
  if (!name || name.length > 80) errors.name = "Give a name of up to 80 characters.";
  const outlet = text(raw.outletId);
  if (outlet && !isUuid(outlet)) errors.outletId = "Choose an outlet, or all outlets.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { day, name, outletId: outlet || null } };
}

export type AdjustmentInput = { typeId: string; year: number; days: number; reason: string };
export function parseAdjustment(raw: { typeId?: unknown; year?: unknown; days?: unknown; reason?: unknown }): Parsed<AdjustmentInput> {
  const errors: Record<string, string> = {};
  const typeId = text(raw.typeId);
  if (!isUuid(typeId)) errors.typeId = "Choose a leave type.";
  const year = Number(text(raw.year));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) errors.year = "Enter the leave year.";
  const days = halfSteps(raw.days);
  if (days === null || days === 0 || Math.abs(days) > 366) errors.days = "Enter the days to add (or, with a minus, to take away), in half days.";
  const reason = text(raw.reason);
  if (!reason) errors.reason = "Give a reason. It is kept with the balance.";
  else if (reason.length > LEAVE_LIMITS.reasonMax) errors.reason = `Keep it under ${LEAVE_LIMITS.reasonMax} characters.`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { typeId, year, days: days!, reason } };
}

// ---------------------------------------------------------------------------
// Database refusals -> messages for people
// ---------------------------------------------------------------------------
export const LEAVE_DB_MESSAGES: Record<string, string> = {
  leave_type_inactive: "This leave type is no longer in use.",
  leave_type_not_configured: "HR has not set up this leave type yet. Choose another type, or ask HR.",
  leave_type_fixed_fields: "A leave type's code and whether it is paid cannot change. Add a new type instead.",
  leave_type_unpaid: "Unpaid leave has no balance to adjust.",
  leave_bad_period: "Check the days: the last day must be on or after the first.",
  leave_crosses_year: "A request cannot cross 31 December. Split it into one request per year.",
  leave_too_far_back: `Leave can be entered at most ${LEAVE_LIMITS.daysBack} days back.`,
  leave_too_far_ahead: `Leave can be requested at most ${LEAVE_LIMITS.daysAhead} days ahead.`,
  leave_note_required: "This leave type needs a note.",
  leave_zero_days: "Those days are all holidays or weekly offs, so there is nothing to take.",
  leave_insufficient_balance: "Not enough leave left for this (requests still waiting count too).",
  leave_overlap: "This overlaps another leave request that is waiting or approved.",
  leave_already_started: "This leave has started. Ask HR to cancel it.",
  employee_not_active: "This person is not employed on those days (not joined yet, or already left).",
  no_employee_record: "Your account is not linked to an employee record yet. Ask HR to link it.",
  request_not_pending: "This request has already been dealt with.",
  own_request: "Someone else must decide your own leave request.",
  decision_note_required: "Give a note when rejecting a request.",
  reason_required: "Give a reason.",
  adjust_bad_days: "Enter the days in half-day steps, not zero.",
  adjust_negative_balance: "That would make the balance negative.",
  on_leave: "You are on leave today. Ask HR if that is wrong.",
  not_found: "That record was not found.",
  holidays_organization_id_outlet_day_key: "There is already a holiday on that day for those outlets.",
  leave_types_organization_id_code_key: "A leave type with that code already exists.",
  leave_types_unpaid_check: "Unpaid leave has no balance: choose no balance, with 0 days and no carry-over.",
  leave_types_days_check: "Enter 0 to 366 days, in half days.",
  leave_types_name_check: "Give a name of up to 60 characters.",
  holidays_name_check: "Give a name of up to 80 characters.",
  leave_requests_text_check: `Keep notes and reasons under ${LEAVE_LIMITS.reasonMax} characters.`,
  leave_requests_no_overlap: "This overlaps another leave request that is waiting or approved.",
};

// The refusal code in PostgreSQL's own message, or null. Longest codes first, so "leave_type_unpaid" never hides
// behind a shorter code that is part of it.
const CODES = Object.keys(LEAVE_DB_MESSAGES).sort((a, b) => b.length - a.length);
export function leaveRefusal(message: string): string | null {
  for (const code of CODES) if (new RegExp(`\\b${code}\\b`).test(message)) return code;
  return null;
}
