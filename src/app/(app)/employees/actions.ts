"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import {
  createEmployee,
  createStructureItem,
  getEmployee,
  linkEmployeeAccount,
  markEmployeeExited,
  type StructureKind,
  updateEmployee,
  updateStructureItem,
} from "@/lib/employees/employees";
import { formDataToEmployeeFields, parseEmployeeInput, parseExitDate, parseStructureInput } from "@/lib/employees/rules";
import { actionFailure, signedInAction, singleString } from "@/lib/recruitment/action-helpers";
import type { FormState } from "@/lib/recruitment/form-state";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";

// Entry points for the Employee Management screens. Each one checks the session itself, reads only the fields
// it expects, and leaves every decision (permission, organisation, what may change) to the service in
// src/lib/employees and to the database.

const done = (prev: FormState): FormState => ({ message: null, fieldErrors: {}, done: (prev.done ?? 0) + 1 });

// Today's date (YYYY-MM-DD) in the organisation's time zone.
function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export async function createEmployeeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = formDataToEmployeeFields(formData);
  let id: string;
  try {
    const { ctx, deps } = await signedInAction();
    const { timezone } = await getOrganizationSettings(deps.db, ctx);
    const parsed = parseEmployeeInput(values, todayIn(timezone, deps.now));
    if (!parsed.ok) return { message: "Check the highlighted fields.", fieldErrors: parsed.errors, values };
    id = (await createEmployee(deps, ctx, parsed.value)).id;
  } catch (error) {
    return actionFailure(error, "employee.create", values);
  }
  redirect(`/employees/${id}?saved=created`);
}

export async function updateEmployeeAction(employeeId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const values = formDataToEmployeeFields(formData);
  try {
    const { ctx, deps } = await signedInAction();
    const { timezone } = await getOrganizationSettings(deps.db, ctx);
    const parsed = parseEmployeeInput(values, todayIn(timezone, deps.now));
    if (!parsed.ok) return { message: "Check the highlighted fields.", fieldErrors: parsed.errors, values };
    await updateEmployee(deps, ctx, employeeId, parsed.value);
  } catch (error) {
    return actionFailure(error, "employee.update", values);
  }
  redirect(`/employees/${employeeId}?saved=updated`);
}

export async function markLeftAction(prev: FormState, formData: FormData): Promise<FormState> {
  const employeeId = singleString(formData, "employeeId");
  const exitedOn = singleString(formData, "exitedOn") ?? "";
  if (!employeeId) return { message: "That change is not possible.", fieldErrors: {} };
  try {
    const { ctx, deps } = await signedInAction();
    const { timezone } = await getOrganizationSettings(deps.db, ctx);
    const employee = await getEmployee(deps.db, ctx, employeeId);
    const parsed = parseExitDate(exitedOn, employee.joinedOn, todayIn(timezone, deps.now));
    if (!parsed.ok) return { message: parsed.errors.exitedOn ?? "Check the date.", fieldErrors: parsed.errors, values: { exitedOn } };
    await markEmployeeExited(deps, ctx, employeeId, parsed.value);
  } catch (error) {
    return actionFailure(error, "employee.exit", { exitedOn });
  }
  refresh();
  return done(prev);
}

// Link a staff account to the employee (op=link), or unlink it (op=unlink).
export async function linkAccountAction(prev: FormState, formData: FormData): Promise<FormState> {
  const employeeId = singleString(formData, "employeeId");
  const op = singleString(formData, "op");
  const memberId = singleString(formData, "memberId") ?? "";
  if (!employeeId || (op !== "link" && op !== "unlink")) return { message: "That change is not possible.", fieldErrors: {} };
  if (op === "link" && !memberId) return { message: "Choose an account to link.", fieldErrors: { memberId: "Choose an account." }, values: { memberId } };
  try {
    const { ctx, deps } = await signedInAction();
    await linkEmployeeAccount(deps, ctx, employeeId, op === "link" ? memberId : null);
  } catch (error) {
    return actionFailure(error, "employee.link", { memberId });
  }
  refresh();
  return done(prev);
}

// Add, rename, or deactivate / activate an outlet, department or designation.
export async function structureAction(prev: FormState, formData: FormData): Promise<FormState> {
  const kind = singleString(formData, "kind");
  const op = singleString(formData, "op");
  const id = singleString(formData, "id");
  if ((kind !== "outlet" && kind !== "department" && kind !== "designation") || (op !== "create" && op !== "rename" && op !== "activate" && op !== "deactivate")) {
    return { message: "That change is not possible.", fieldErrors: {} };
  }
  const k: StructureKind = kind;
  const values = { name: singleString(formData, "name") ?? "", address: singleString(formData, "address") ?? "" };
  try {
    const { ctx, deps } = await signedInAction();
    if (op === "create" || op === "rename") {
      const parsed = parseStructureInput(values, k === "outlet");
      if (!parsed.ok) return { message: parsed.errors.name ?? parsed.errors.address ?? "Check the highlighted fields.", fieldErrors: parsed.errors, values };
      if (op === "create") await createStructureItem(deps, ctx, k, parsed.value);
      else {
        if (!id) return { message: "That change is not possible.", fieldErrors: {} };
        await updateStructureItem(deps, ctx, k, id, { input: parsed.value });
      }
    } else {
      if (!id) return { message: "That change is not possible.", fieldErrors: {} };
      await updateStructureItem(deps, ctx, k, id, { isActive: op === "activate" });
    }
  } catch (error) {
    // Only the create / rename forms have fields to refill; the (de)activate button sends no name.
    return actionFailure(error, `structure.${op}`, op === "create" || op === "rename" ? values : undefined);
  }
  refresh();
  return done(prev);
}
