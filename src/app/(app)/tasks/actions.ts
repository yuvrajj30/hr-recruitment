"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { isUuid, localDay } from "@/lib/attendance/rules";
import { markAllRead, markRead } from "@/lib/notifications/notifications";
import { actionFailure, signedInAction, singleString } from "@/lib/recruitment/action-helpers";
import { readUploads } from "@/lib/tasks/form-files";
import type { FormState } from "@/lib/recruitment/form-state";
import {
  addTaskNote, addTaskResource, assignTask, cancelTask, editTask, getTask, removeTaskResource, reviewTask, startTask, submitTask,
} from "@/lib/tasks/tasks";
import { parseLink, parseReview, parseTaskInput, TASK_LIMITS } from "@/lib/tasks/rules";

// Entry points for the Tasks and Notifications screens. Each one checks the session itself, reads only the fields it
// expects, takes "today" from the server in the organisation's time zone, and leaves every decision (permission, whose
// task, which step is possible) to the service in src/lib/tasks and to the database. Who is acting never comes from the form.

const done = (prev: FormState, message: string | null = null): FormState => ({ message, fieldErrors: {}, done: (prev.done ?? 0) + 1 });
const NOT_POSSIBLE: FormState = { message: "That change is not possible. Reload the page and try again.", fieldErrors: {} };

const invalidFields = (errors: Record<string, string>, values: Record<string, string>): FormState => ({
  message: "Check the highlighted fields.",
  fieldErrors: errors,
  values,
});

const TASK_KEYS = ["ownerId", "outletId", "title", "description", "dueOn", "dueTime", "priority"] as const;

// The task fields as typed, with the proof kinds kept as one comma-separated value so a rejected form keeps them.
function taskValues(formData: FormData): { values: Record<string, string>; proof: string[] } {
  const values: Record<string, string> = {};
  for (const k of TASK_KEYS) values[k] = singleString(formData, k) ?? "";
  const proof = formData.getAll("proof").filter((p): p is string => typeof p === "string");
  values.proof = proof.join(",");
  return { values, proof };
}

// ---------------------------------------------------------------------------
// HR: assign, edit, review, cancel, resources
// ---------------------------------------------------------------------------
export async function assignTaskAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { values, proof } = taskValues(formData);
  values.link = singleString(formData, "link") ?? "";
  let taskId: string;
  try {
    const { ctx, deps } = await signedInAction();
    const today = localDay(deps.now, await attendanceTimezone(deps.db, ctx));
    const parsed = parseTaskInput({ ...values, proof }, today);
    const errors: Record<string, string> = parsed.ok ? {} : { ...parsed.errors };
    const link = values.link.trim();
    if (link) {
      const checked = parseLink(link);
      if (!checked.ok) errors.link = checked.errors.url!;
    }
    if (!parsed.ok || Object.keys(errors).length) return invalidFields(errors, values);
    taskId = await assignTask(deps, ctx, parsed.value);
    if (link) {
      // The task exists now. If the link cannot be saved the person can add it again on the task page.
      await addTaskResource(deps, ctx, taskId, { url: link }).catch(() => undefined);
    }
  } catch (error) {
    return actionFailure(error, "task.assign", values);
  }
  redirect(`/tasks/${taskId}`);
}

export async function editTaskAction(prev: FormState, formData: FormData): Promise<FormState> {
  const taskId = singleString(formData, "taskId");
  if (!taskId || !isUuid(taskId)) return NOT_POSSIBLE;
  const { values, proof } = taskValues(formData);
  values.reason = singleString(formData, "reason") ?? "";
  try {
    const { ctx, deps } = await signedInAction();
    const today = localDay(deps.now, await attendanceTimezone(deps.db, ctx));
    const current = await getTask(deps.db, ctx, taskId);
    const parsed = parseTaskInput({ ...values, proof }, today, { currentDueOn: current.dueOn });
    const reason = values.reason.trim();
    const errors: Record<string, string> = parsed.ok ? {} : { ...parsed.errors };
    if (reason.length > TASK_LIMITS.noteMax) errors.reason = `Keep the reason under ${TASK_LIMITS.noteMax} characters.`;
    if (!parsed.ok || Object.keys(errors).length) return invalidFields(errors, values);
    await editTask(deps, ctx, taskId, parsed.value, reason || null);
  } catch (error) {
    return actionFailure(error, "task.edit", values);
  }
  refresh();
  return done(prev, "Changes saved.");
}

export async function reviewTaskAction(prev: FormState, formData: FormData): Promise<FormState> {
  const taskId = singleString(formData, "taskId");
  if (!taskId || !isUuid(taskId)) return NOT_POSSIBLE;
  const values = {
    decision: singleString(formData, "decision") ?? "",
    rating: singleString(formData, "rating") ?? "",
    note: singleString(formData, "note") ?? "",
  };
  const parsed = parseReview(values);
  if (!parsed.ok) return invalidFields(parsed.errors, values);
  try {
    const { ctx, deps } = await signedInAction();
    await reviewTask(deps, ctx, taskId, parsed.value.approve, parsed.value.rating, parsed.value.note);
  } catch (error) {
    return actionFailure(error, "task.review", values);
  }
  refresh();
  return done(prev, parsed.value.approve ? "Task approved." : "Changes requested.");
}

export async function cancelTaskAction(prev: FormState, formData: FormData): Promise<FormState> {
  const taskId = singleString(formData, "taskId");
  if (!taskId || !isUuid(taskId)) return NOT_POSSIBLE;
  const values = { reason: singleString(formData, "reason") ?? "" };
  const reason = values.reason.trim();
  if (!reason) return invalidFields({ reason: "Say why the task is cancelled." }, values);
  if (reason.length > 500) return invalidFields({ reason: "Keep the reason under 500 characters." }, values);
  try {
    const { ctx, deps } = await signedInAction();
    await cancelTask(deps, ctx, taskId, reason);
  } catch (error) {
    return actionFailure(error, "task.cancel", values);
  }
  refresh();
  return done(prev, "Task cancelled.");
}

export async function addResourceLinkAction(prev: FormState, formData: FormData): Promise<FormState> {
  const taskId = singleString(formData, "taskId");
  if (!taskId || !isUuid(taskId)) return NOT_POSSIBLE;
  const values = { url: singleString(formData, "url") ?? "" };
  const link = parseLink(values.url);
  if (!link.ok) return invalidFields(link.errors, values);
  try {
    const { ctx, deps } = await signedInAction();
    await addTaskResource(deps, ctx, taskId, { url: link.value });
  } catch (error) {
    return actionFailure(error, "task.resource_link", values);
  }
  refresh();
  return done(prev, "Link added.");
}

export async function addResourceFileAction(prev: FormState, formData: FormData): Promise<FormState> {
  const taskId = singleString(formData, "taskId");
  if (!taskId || !isUuid(taskId)) return NOT_POSSIBLE;
  const files = await readFiles(formData, "file");
  if (!files.ok) return { message: files.message, fieldErrors: { file: files.message } };
  if (files.files.length !== 1) return { message: "Choose one file.", fieldErrors: { file: "Choose one file." } };
  try {
    const { ctx, deps } = await signedInAction();
    await addTaskResource(deps, ctx, taskId, { file: files.files[0]! });
  } catch (error) {
    return actionFailure(error, "task.resource_file");
  }
  refresh();
  return done(prev, "File added.");
}

export async function removeResourceAction(prev: FormState, formData: FormData): Promise<FormState> {
  const resourceId = singleString(formData, "resourceId");
  if (!resourceId || !isUuid(resourceId)) return NOT_POSSIBLE;
  try {
    const { ctx, deps } = await signedInAction();
    await removeTaskResource(deps, ctx, resourceId);
  } catch (error) {
    return actionFailure(error, "task.resource_remove");
  }
  refresh();
  return done(prev);
}

// ---------------------------------------------------------------------------
// The owner: start, note, submit
// ---------------------------------------------------------------------------
export async function startTaskAction(prev: FormState, formData: FormData): Promise<FormState> {
  const taskId = singleString(formData, "taskId");
  if (!taskId || !isUuid(taskId)) return NOT_POSSIBLE;
  try {
    const { ctx, deps } = await signedInAction();
    await startTask(deps, ctx, taskId);
  } catch (error) {
    return actionFailure(error, "task.start");
  }
  refresh();
  return done(prev);
}

export async function addNoteAction(prev: FormState, formData: FormData): Promise<FormState> {
  const taskId = singleString(formData, "taskId");
  if (!taskId || !isUuid(taskId)) return NOT_POSSIBLE;
  const values = { note: singleString(formData, "note") ?? "" };
  const note = values.note.trim();
  if (!note) return invalidFields({ note: "Write a note." }, values);
  if (note.length > TASK_LIMITS.noteMax) return invalidFields({ note: `Keep the note under ${TASK_LIMITS.noteMax} characters.` }, values);
  try {
    const { ctx, deps } = await signedInAction();
    await addTaskNote(deps, ctx, taskId, note);
  } catch (error) {
    return actionFailure(error, "task.note", values);
  }
  refresh();
  return done(prev, "Note added.");
}

export async function submitTaskAction(prev: FormState, formData: FormData): Promise<FormState> {
  const taskId = singleString(formData, "taskId");
  if (!taskId || !isUuid(taskId)) return NOT_POSSIBLE;
  const values = { text: singleString(formData, "text") ?? "" };
  const text = values.text.trim();
  if (text.length > TASK_LIMITS.textMax) return invalidFields({ text: `Keep it under ${TASK_LIMITS.textMax} characters.` }, values);
  const files = await readFiles(formData, "files");
  if (!files.ok) return { message: files.message, fieldErrors: { files: files.message }, values };
  try {
    const { ctx, deps } = await signedInAction();
    await submitTask(deps, ctx, taskId, text || null, files.files);
  } catch (error) {
    return actionFailure(error, "task.submit", values);
  }
  refresh();
  return done(prev, "Submitted for review.");
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
export async function markNotificationReadAction(prev: FormState, formData: FormData): Promise<FormState> {
  const id = singleString(formData, "notificationId");
  if (!id || !isUuid(id)) return NOT_POSSIBLE;
  try {
    const { ctx, deps } = await signedInAction();
    await markRead(deps.db, ctx, id);
  } catch (error) {
    return actionFailure(error, "notification.read");
  }
  refresh();
  return done(prev);
}

export async function markAllNotificationsReadAction(prev: FormState): Promise<FormState> {
  try {
    const { ctx, deps } = await signedInAction();
    await markAllRead(deps.db, ctx);
  } catch (error) {
    return actionFailure(error, "notification.read_all");
  }
  refresh();
  return done(prev);
}

// Files from a form: see src/lib/tasks/form-files.ts (empty file boxes are skipped; count and size checked first).
const readFiles = (formData: FormData, key: string) => readUploads(formData.getAll(key));
