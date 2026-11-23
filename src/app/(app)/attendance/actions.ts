"use server";

import { refresh } from "next/cache";
import {
  attendanceTimezone,
  cancelShift,
  clockIn,
  clockOut,
  confirmShift,
  copyWeek,
  createShift,
  decideRequest,
  getRecord,
  hrCorrect,
  hrRecord,
  applyStandard,
  hrVoid,
  setEmployeeStandard,
  setOutletHours,
  requestCorrection,
  takeBreak,
  updateShift,
  withdrawRequest,
} from "@/lib/attendance/attendance";
import {
  ATTENDANCE_LIMITS,
  addDays,
  dayStart,
  isDay,
  isUuid,
  parseOutletHours,
  parsePeriodInput,
  parseRequiredReason,
  parseShiftInput,
  parseStandard,
  weekStart,
} from "@/lib/attendance/rules";
import { actionFailure, signedInAction, singleString } from "@/lib/recruitment/action-helpers";
import type { FormState } from "@/lib/recruitment/form-state";

// Entry points for the Attendance screens. Each one checks the session itself, reads only the fields it expects,
// takes "now" and the time zone from the server, and leaves every decision (permission, whose record, what may
// change) to the service in src/lib/attendance and to the database. Nothing about who is acting comes from the form.

const done = (prev: FormState, message: string | null = null): FormState => ({ message, fieldErrors: {}, done: (prev.done ?? 0) + 1 });
const NOT_POSSIBLE: FormState = { message: "That change is not possible.", fieldErrors: {} };

function fields<K extends string>(formData: FormData, keys: readonly K[]): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of keys) out[k] = singleString(formData, k) ?? "";
  return out;
}

const invalidFields = (errors: Record<string, string>, values: Record<string, string>): FormState => ({
  message: "Check the highlighted fields.",
  fieldErrors: errors,
  values,
});

const PERIOD_KEYS = ["day", "start", "end", "breakMinutes", "reason"] as const;

// ---------------------------------------------------------------------------
// Self-service
// ---------------------------------------------------------------------------

// op = in | out | break_start | break_end. The person and the time are never taken from the form.
export async function clockAction(prev: FormState, formData: FormData): Promise<FormState> {
  const op = singleString(formData, "op");
  if (op !== "in" && op !== "out" && op !== "break_start" && op !== "break_end") return NOT_POSSIBLE;
  try {
    const { ctx, deps } = await signedInAction();
    if (op === "in") await clockIn(deps, ctx);
    else if (op === "out") {
      if ((await clockOut(deps, ctx)) === "missing_out") {
        refresh();
        return done(prev, "Your clock-in was left open too long and is marked as missing its clock-out. Ask for a correction below.");
      }
    } else await takeBreak(deps, ctx, op === "break_start");
  } catch (error) {
    return actionFailure(error, "attendance.clock");
  }
  refresh();
  return done(prev);
}

// Ask HR to correct one of my records (recordId given), or to add time I forgot to clock (no recordId).
export async function requestCorrectionAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, [...PERIOD_KEYS, "recordId"] as const);
  try {
    const { ctx, deps } = await signedInAction();
    const timezone = await attendanceTimezone(deps.db, ctx);
    const parsed = parsePeriodInput(values, timezone, deps.now, { reasonRequired: true, maxDaysBack: ATTENDANCE_LIMITS.requestDaysBack });
    if (!parsed.ok) return invalidFields(parsed.errors, values);
    await requestCorrection(deps, ctx, values.recordId === "" ? null : values.recordId, parsed.value);
  } catch (error) {
    return actionFailure(error, "attendance.request", values);
  }
  refresh();
  return done(prev);
}

export async function withdrawRequestAction(prev: FormState, formData: FormData): Promise<FormState> {
  const requestId = singleString(formData, "requestId");
  if (!requestId) return NOT_POSSIBLE;
  try {
    const { ctx, deps } = await signedInAction();
    await withdrawRequest(deps, ctx, requestId);
  } catch (error) {
    return actionFailure(error, "attendance.withdraw");
  }
  refresh();
  return done(prev);
}

// ---------------------------------------------------------------------------
// HR: worked time
// ---------------------------------------------------------------------------

export async function hrRecordAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, [...PERIOD_KEYS, "employeeId", "outletId"] as const);
  try {
    const { ctx, deps } = await signedInAction();
    const timezone = await attendanceTimezone(deps.db, ctx);
    const parsed = parsePeriodInput(values, timezone, deps.now, { endOptional: true, reasonRequired: false });
    const errors: Record<string, string> = parsed.ok ? {} : { ...parsed.errors };
    if (!isUuid(values.employeeId)) errors.employeeId = "Choose the employee.";
    if (!parsed.ok || Object.keys(errors).length) return invalidFields(errors, values);
    await hrRecord(deps, ctx, values.employeeId, values.outletId === "" ? null : values.outletId, parsed.value);
  } catch (error) {
    return actionFailure(error, "attendance.record", values);
  }
  refresh();
  return done(prev);
}

// "Worked as planned" for a missed shift.
export async function confirmShiftAction(prev: FormState, formData: FormData): Promise<FormState> {
  const shiftId = singleString(formData, "shiftId");
  if (!shiftId) return NOT_POSSIBLE;
  try {
    const { ctx, deps } = await signedInAction();
    await confirmShift(deps, ctx, shiftId);
  } catch (error) {
    return actionFailure(error, "attendance.confirm_shift");
  }
  refresh();
  return done(prev);
}

export async function hrCorrectAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, [...PERIOD_KEYS, "recordId", "outletId", "setBreak"] as const);
  try {
    const { ctx, deps } = await signedInAction();
    const timezone = await attendanceTimezone(deps.db, ctx);
    // The end may only be left empty while the record is still open (the service shows the record to HR only).
    const record = await getRecord(deps.db, ctx, values.recordId, deps.now);
    const parsed = parsePeriodInput(values, timezone, deps.now, { endOptional: record.status === "OPEN", reasonRequired: true });
    if (!parsed.ok) return invalidFields(parsed.errors, values);
    await hrCorrect(deps, ctx, record.id, parsed.value, { outletId: values.outletId === "" ? null : values.outletId, setBreak: values.setBreak !== "" });
  } catch (error) {
    return actionFailure(error, "attendance.correct", values);
  }
  refresh();
  return done(prev);
}

export async function hrVoidAction(prev: FormState, formData: FormData): Promise<FormState> {
  const recordId = singleString(formData, "recordId");
  const values = { reason: singleString(formData, "reason") ?? "" };
  if (!recordId) return NOT_POSSIBLE;
  const reason = parseRequiredReason(values.reason);
  if (!reason.ok) return invalidFields(reason.errors, values);
  try {
    const { ctx, deps } = await signedInAction();
    await hrVoid(deps, ctx, recordId, reason.value);
  } catch (error) {
    return actionFailure(error, "attendance.void", values);
  }
  refresh();
  return done(prev);
}

// decision = approve | reject (the name of the button pressed). Rejecting needs a note.
export async function decideRequestAction(prev: FormState, formData: FormData): Promise<FormState> {
  const requestId = singleString(formData, "requestId");
  const decision = singleString(formData, "decision");
  const values = { note: singleString(formData, "note") ?? "" };
  if (!requestId || (decision !== "approve" && decision !== "reject")) return NOT_POSSIBLE;
  let note: string | null = null;
  if (decision === "reject") {
    const parsed = parseRequiredReason(values.note);
    if (!parsed.ok) return { message: "Give a note when rejecting a request.", fieldErrors: { note: "Give a note when rejecting a request." }, values };
    note = parsed.value;
  }
  try {
    const { ctx, deps } = await signedInAction();
    await decideRequest(deps, ctx, requestId, decision === "approve", note);
  } catch (error) {
    return actionFailure(error, "attendance.decide", values);
  }
  refresh();
  return done(prev);
}

// ---------------------------------------------------------------------------
// HR: rota
// ---------------------------------------------------------------------------

const SHIFT_KEYS = ["employeeId", "outletId", "day", "start", "end", "breakMinutes", "note"] as const;

export async function createShiftAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, SHIFT_KEYS);
  try {
    const { ctx, deps } = await signedInAction();
    const timezone = await attendanceTimezone(deps.db, ctx);
    const parsed = parseShiftInput(values, timezone, deps.now);
    if (!parsed.ok) return invalidFields(parsed.errors, values);
    await createShift(deps, ctx, parsed.value);
  } catch (error) {
    return actionFailure(error, "attendance.shift_create", values);
  }
  refresh();
  return done(prev);
}

// The employee of a shift cannot change: its id comes along only so the shared parser accepts the form.
export async function updateShiftAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, [...SHIFT_KEYS, "shiftId"] as const);
  try {
    const { ctx, deps } = await signedInAction();
    const timezone = await attendanceTimezone(deps.db, ctx);
    const parsed = parseShiftInput(values, timezone, deps.now);
    if (!parsed.ok) return invalidFields(parsed.errors, values);
    const { outletId, startsAt, endsAt, breakMinutes, note } = parsed.value;
    await updateShift(deps, ctx, values.shiftId, { outletId, startsAt, endsAt, breakMinutes, note });
  } catch (error) {
    return actionFailure(error, "attendance.shift_update", values);
  }
  refresh();
  return done(prev);
}

export async function cancelShiftAction(prev: FormState, formData: FormData): Promise<FormState> {
  const shiftId = singleString(formData, "shiftId");
  const values = { reason: singleString(formData, "reason") ?? "" };
  if (!shiftId) return NOT_POSSIBLE;
  const reason = parseRequiredReason(values.reason);
  if (!reason.ok) return invalidFields(reason.errors, values);
  try {
    const { ctx, deps } = await signedInAction();
    await cancelShift(deps, ctx, shiftId, reason.value);
  } catch (error) {
    return actionFailure(error, "attendance.shift_cancel", values);
  }
  refresh();
  return done(prev);
}

export async function copyWeekAction(prev: FormState, formData: FormData): Promise<FormState> {
  const week = singleString(formData, "week") ?? "";
  const outlet = singleString(formData, "outlet") ?? "";
  if (!isDay(week)) return NOT_POSSIBLE;
  try {
    const { ctx, deps } = await signedInAction();
    const timezone = await attendanceTimezone(deps.db, ctx);
    const monday = weekStart(week);
    const range = { start: dayStart(monday, timezone), end: dayStart(addDays(monday, 7), timezone) };
    const result = await copyWeek(deps, ctx, range, outlet === "" ? null : outlet, timezone);
    refresh();
    return done(prev, `${result.created} copied, ${result.skipped} skipped.`);
  } catch (error) {
    return actionFailure(error, "attendance.copy_week");
  }
}

// ---------------------------------------------------------------------------
// HR: standard shifts
// ---------------------------------------------------------------------------

// null: saved, but filling the rota right away failed (the daily run tries again).
const addedMessage = (n: number | null): string =>
  n === null ? "Saved. The rota could not be updated right now; it will be filled in at the next daily run." : `Saved. ${n} shift(s) added to the rota.`;

// Sets an outlet's standard hours; the button with intent=clear removes them.
export async function setOutletHoursAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, ["outletId", "opening", "changeover", "closing", "breakMinutes"] as const);
  const clear = singleString(formData, "intent") === "clear";
  try {
    const { ctx, deps } = await signedInAction();
    let added: number | null;
    if (clear) added = await setOutletHours(deps, ctx, values.outletId, null);
    else {
      const parsed = parseOutletHours(values);
      if (!parsed.ok) return invalidFields(parsed.errors, values);
      added = await setOutletHours(deps, ctx, values.outletId, parsed.value);
    }
    refresh();
    return done(prev, addedMessage(added));
  } catch (error) {
    return actionFailure(error, "attendance.outlet_hours", values);
  }
}

export async function setEmployeeStandardAction(prev: FormState, formData: FormData): Promise<FormState> {
  const employeeId = singleString(formData, "employeeId") ?? "";
  const standardShift = singleString(formData, "standardShift") ?? "";
  const workDays = formData.getAll("workDays").filter((v): v is string => typeof v === "string");
  const values = { employeeId, standardShift };
  const parsed = parseStandard({ standardShift, workDays });
  if (!parsed.ok) return invalidFields(parsed.errors, values);
  try {
    const { ctx, deps } = await signedInAction();
    const added = await setEmployeeStandard(deps, ctx, employeeId, parsed.value);
    refresh();
    return done(prev, addedMessage(added));
  } catch (error) {
    return actionFailure(error, "attendance.employee_standard", values);
  }
}

export async function applyStandardAction(prev: FormState): Promise<FormState> {
  try {
    const { ctx, deps } = await signedInAction();
    const added = await applyStandard(deps, ctx);
    refresh();
    return done(prev, `${added} shift(s) added to the rota.`);
  } catch (error) {
    return actionFailure(error, "attendance.apply_standard");
  }
}
