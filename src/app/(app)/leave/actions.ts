"use server";

import { refresh } from "next/cache";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { isUuid, localDay, parseRequiredReason } from "@/lib/attendance/rules";
import { actionFailure, signedInAction, singleString } from "@/lib/recruitment/action-helpers";
import type { FormState } from "@/lib/recruitment/form-state";
import { adjustLeave, cancelLeave, decideLeave, hrRecordLeave, listLeaveTypes, removeHoliday, requestLeave, saveHoliday, saveLeaveType, withdrawLeave } from "@/lib/leave/leave";
import { parseAdjustment, parseHoliday, parseLeaveRequest, parseLeaveType } from "@/lib/leave/rules";

// Entry points for the Leave screens. Each one checks the session itself, reads only the fields it expects, takes
// "today" from the server in the organisation's time zone, and leaves every decision (permission, whose leave,
// what may change) to the service in src/lib/leave and to the database. Who is acting never comes from the form.

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

const REQUEST_KEYS = ["typeId", "start", "end", "startHalf", "endHalf", "note"] as const;
const TYPE_KEYS = ["code", "name", "paid", "accrual", "daysPerYear", "carryOverMax", "noteRequired", "isActive"] as const;

// ---------------------------------------------------------------------------
// Self-service
// ---------------------------------------------------------------------------
export async function requestLeaveAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, REQUEST_KEYS);
  try {
    const { ctx, deps } = await signedInAction();
    const today = localDay(deps.now, await attendanceTimezone(deps.db, ctx));
    const parsed = parseLeaveRequest(values, today);
    if (!parsed.ok) return invalidFields(parsed.errors, values);
    await requestLeave(deps, ctx, parsed.value);
  } catch (error) {
    return actionFailure(error, "leave.request", values);
  }
  refresh();
  return done(prev, "Request sent.");
}

export async function withdrawLeaveAction(prev: FormState, formData: FormData): Promise<FormState> {
  const requestId = singleString(formData, "requestId");
  if (!requestId) return NOT_POSSIBLE;
  try {
    const { ctx, deps } = await signedInAction();
    await withdrawLeave(deps, ctx, requestId);
  } catch (error) {
    return actionFailure(error, "leave.withdraw");
  }
  refresh();
  return done(prev);
}

// Employees cancel their own approved leave before it starts; HR at any time. The database decides which.
export async function cancelLeaveAction(prev: FormState, formData: FormData): Promise<FormState> {
  const requestId = singleString(formData, "requestId");
  const values = { reason: singleString(formData, "reason") ?? "" };
  if (!requestId) return NOT_POSSIBLE;
  const reason = parseRequiredReason(values.reason);
  if (!reason.ok) return invalidFields(reason.errors, values);
  try {
    const { ctx, deps } = await signedInAction();
    await cancelLeave(deps, ctx, requestId, reason.value);
  } catch (error) {
    return actionFailure(error, "leave.cancel", values);
  }
  refresh();
  return done(prev, "Leave cancelled.");
}

// ---------------------------------------------------------------------------
// HR: decisions, paper leave, adjustments
// ---------------------------------------------------------------------------

// decision = approve | reject (the name of the button pressed). Rejecting needs a note.
export async function decideLeaveAction(prev: FormState, formData: FormData): Promise<FormState> {
  const requestId = singleString(formData, "requestId");
  const decision = singleString(formData, "decision");
  const values = { note: singleString(formData, "note") ?? "" };
  if (!requestId || (decision !== "approve" && decision !== "reject")) return NOT_POSSIBLE;
  let note: string | null = null;
  if (decision === "reject") {
    const parsed = parseRequiredReason(values.note);
    if (!parsed.ok) return { message: "Give a note when rejecting a request.", fieldErrors: { note: "Give a note when rejecting a request." }, values };
    note = parsed.value;
  } else if (values.note.trim()) {
    note = values.note.trim().slice(0, 500);
  }
  try {
    const { ctx, deps } = await signedInAction();
    await decideLeave(deps, ctx, requestId, decision === "approve", note);
  } catch (error) {
    return actionFailure(error, "leave.decide", values);
  }
  refresh();
  return done(prev);
}

export async function hrRecordLeaveAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, [...REQUEST_KEYS, "employeeId"] as const);
  try {
    const { ctx, deps } = await signedInAction();
    const today = localDay(deps.now, await attendanceTimezone(deps.db, ctx));
    const parsed = parseLeaveRequest(values, today);
    const errors: Record<string, string> = parsed.ok ? {} : { ...parsed.errors };
    if (!isUuid(values.employeeId)) errors.employeeId = "Choose the employee.";
    if (!parsed.ok || Object.keys(errors).length) return invalidFields(errors, values);
    await hrRecordLeave(deps, ctx, values.employeeId, parsed.value);
  } catch (error) {
    return actionFailure(error, "leave.record", values);
  }
  refresh();
  return done(prev, "Leave recorded as approved.");
}

export async function adjustLeaveAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, ["employeeId", "typeId", "year", "days", "reason"] as const);
  const parsed = parseAdjustment(values);
  const errors: Record<string, string> = parsed.ok ? {} : { ...parsed.errors };
  if (!isUuid(values.employeeId)) return NOT_POSSIBLE;
  if (!parsed.ok) return invalidFields(errors, values);
  try {
    const { ctx, deps } = await signedInAction();
    await adjustLeave(deps, ctx, values.employeeId, parsed.value.typeId, parsed.value.year, parsed.value.days, parsed.value.reason);
  } catch (error) {
    return actionFailure(error, "leave.adjust", values);
  }
  refresh();
  return done(prev, "Adjustment added.");
}

// ---------------------------------------------------------------------------
// HR: set-up
// ---------------------------------------------------------------------------

// typeId empty: a new type. For an existing type the code and "paid" are ignored by the service; the form does not send them.
export async function saveLeaveTypeAction(prev: FormState, formData: FormData): Promise<FormState> {
  const typeId = singleString(formData, "typeId") ?? "";
  const values = fields(formData, TYPE_KEYS);
  if (typeId !== "" && !isUuid(typeId)) return NOT_POSSIBLE;
  try {
    const { ctx, deps } = await signedInAction();
    let raw: Record<string, string> = values;
    if (typeId !== "") {
      // The code and paid flag of an existing type never change; read them from the service's own list so the parser has them.
      const existing = (await listLeaveTypes(deps.db, ctx)).find((t) => t.id === typeId);
      if (!existing) return NOT_POSSIBLE;
      raw = { ...values, code: existing.code, paid: existing.paid ? "on" : "" };
      if (!existing.paid) raw = { ...raw, accrual: "NONE", daysPerYear: "0", carryOverMax: "0" };
    }
    const parsed = parseLeaveType(raw);
    if (!parsed.ok) return invalidFields(parsed.errors, values);
    await saveLeaveType(deps, ctx, typeId === "" ? null : typeId, parsed.value);
  } catch (error) {
    return actionFailure(error, "leave.type_save", values);
  }
  refresh();
  return done(prev, typeId === "" ? "Leave type added." : "Settings saved.");
}

export async function saveHolidayAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, ["day", "name", "outletId"] as const);
  const parsed = parseHoliday(values);
  if (!parsed.ok) return invalidFields(parsed.errors, values);
  try {
    const { ctx, deps } = await signedInAction();
    await saveHoliday(deps, ctx, parsed.value);
  } catch (error) {
    return actionFailure(error, "leave.holiday_save", values);
  }
  refresh();
  return done(prev, "Holiday added.");
}

export async function removeHolidayAction(prev: FormState, formData: FormData): Promise<FormState> {
  const holidayId = singleString(formData, "holidayId");
  if (!holidayId) return NOT_POSSIBLE;
  try {
    const { ctx, deps } = await signedInAction();
    await removeHoliday(deps, ctx, holidayId);
  } catch (error) {
    return actionFailure(error, "leave.holiday_remove");
  }
  refresh();
  return done(prev);
}
