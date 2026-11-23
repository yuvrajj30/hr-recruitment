// Tasks: pure rules (no database). Input parsing for the screens, labels, "overdue", and the messages for the
// database's refusals. The task functions (migrations 20261124000000_tasks, 20261124000100_task_functions,
// 20261124000200_task_fixes) check everything again; these checks only give people a clear message first.
import { isDay, isUuid, type Parsed } from "@/lib/attendance/rules";
import { zonedInputToDate } from "@/lib/interviews/rules";

// Uploads must fit the app's 6 MB request limit (next.config.ts serverActions.bodySizeLimit, kept by the owner on
// 24 Nov 2026): at most 3 files, 5 MB each and 5 MB in total per submission. The database allows more (5 files of
// 10 MB) as an outer limit; these are the limits people meet.
export const TASK_LIMITS = {
  titleMax: 120, descriptionMax: 2000, noteMax: 1000, textMax: 4000, linkMax: 500,
  fileMaxBytes: 5 * 1024 * 1024, filesMax: 3, uploadTotalMaxBytes: 5 * 1024 * 1024, resourceFilesMax: 5, resourceLinksMax: 10,
} as const;

export const TASK_STATUSES = ["ASSIGNED", "IN_PROGRESS", "SUBMITTED", "CHANGES_REQUESTED", "APPROVED", "CANCELLED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  ASSIGNED: "Assigned", IN_PROGRESS: "In progress", SUBMITTED: "Waiting for review", CHANGES_REQUESTED: "Changes requested",
  APPROVED: "Approved", CANCELLED: "Cancelled",
};
export const OPEN_STATUSES: readonly TaskStatus[] = ["ASSIGNED", "IN_PROGRESS", "SUBMITTED", "CHANGES_REQUESTED"];
// Statuses in which the owner still has to act (a submitted task waits for HR, so it is never "overdue").
const OWNER_TURN: readonly TaskStatus[] = ["ASSIGNED", "IN_PROGRESS", "CHANGES_REQUESTED"];

export const TASK_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };

export const PROOF_KINDS = ["PHOTO", "DOCUMENT", "TEXT"] as const;
export type TaskProofKind = (typeof PROOF_KINDS)[number];
export const PROOF_LABELS: Record<TaskProofKind, string> = { PHOTO: "Photo", DOCUMENT: "Document (PDF)", TEXT: "Written explanation" };

export type TaskRating = 1 | 2 | 3 | 4 | 5;
export const RATING_LABELS: Record<TaskRating, string> = { 1: "Poor", 2: "Below expectations", 3: "Meets expectations", 4: "Good", 5: "Excellent" };

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------------------
// Assigning and editing
// ---------------------------------------------------------------------------
export type TaskInput = {
  ownerId: string; outletId: string; title: string; description: string; dueOn: string; dueTime: string | null; priority: TaskPriority; proof: TaskProofKind[];
};
export type TaskFields = { [K in keyof TaskInput]?: unknown };

// today: the organisation's local date (YYYY-MM-DD). proof: a list, or one value. When editing, pass the task's
// current deadline: keeping it (even if it has passed) is allowed, so an overdue task can still be edited or moved.
export function parseTaskInput(raw: TaskFields, today: string, opts: { currentDueOn?: string } = {}): Parsed<TaskInput> {
  const errors: Record<string, string> = {};
  const ownerId = text(raw.ownerId);
  if (!isUuid(ownerId)) errors.ownerId = "Choose the employee.";
  const outletId = text(raw.outletId);
  if (!isUuid(outletId)) errors.outletId = "Choose the outlet where the work happens.";
  const title = text(raw.title);
  if (!title || title.length > TASK_LIMITS.titleMax) errors.title = `Give a title of up to ${TASK_LIMITS.titleMax} characters.`;
  const description = text(raw.description);
  if (!description || description.length > TASK_LIMITS.descriptionMax) errors.description = `Describe the task in up to ${TASK_LIMITS.descriptionMax} characters.`;
  const dueOn = text(raw.dueOn);
  if (!isDay(dueOn)) errors.dueOn = "Enter the deadline.";
  else if (dueOn < today && dueOn !== opts.currentDueOn) errors.dueOn = "The deadline cannot be in the past.";
  const dueTime = text(raw.dueTime);
  if (dueTime && !TIME.test(dueTime)) errors.dueTime = "Enter the time as HH:MM, or leave it empty.";
  const priority = (text(raw.priority) || "NORMAL") as TaskPriority;
  if (!TASK_PRIORITIES.includes(priority)) errors.priority = "Choose a priority.";
  const proofRaw = Array.isArray(raw.proof) ? raw.proof : raw.proof === undefined || raw.proof === "" ? [] : [raw.proof];
  const proof = [...new Set(proofRaw.map(text))] as TaskProofKind[];
  if (!proof.length) errors.proof = "Choose at least one kind of proof.";
  else if (proof.some((p) => !PROOF_KINDS.includes(p))) errors.proof = "Choose photo, document or written explanation.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { ownerId, outletId, title, description, dueOn, dueTime: dueTime || null, priority, proof } };
}

// ---------------------------------------------------------------------------
// Reviewing, links
// ---------------------------------------------------------------------------
export function parseReview(raw: { decision?: unknown; rating?: unknown; note?: unknown }): Parsed<{ approve: boolean; rating: TaskRating | null; note: string | null }> {
  const errors: Record<string, string> = {};
  const decision = text(raw.decision);
  const note = text(raw.note);
  if (note.length > TASK_LIMITS.noteMax) errors.note = `Keep it under ${TASK_LIMITS.noteMax} characters.`;
  if (decision === "approve") {
    const rating = Number(text(raw.rating));
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.rating = "Rate the work from 1 to 5 to approve it.";
    if (Object.keys(errors).length) return { ok: false, errors };
    return { ok: true, value: { approve: true, rating: rating as TaskRating, note: note || null } };
  }
  if (decision === "changes") {
    if (!note) errors.note = "Say what needs to change.";
    if (Object.keys(errors).length) return { ok: false, errors };
    return { ok: true, value: { approve: false, rating: null, note } };
  }
  return { ok: false, errors: { decision: "Approve the task or request changes." } };
}

export function parseLink(raw: unknown): Parsed<string> {
  const url = text(raw);
  if (!/^https:\/\/\S+$/.test(url) || url.length > TASK_LIMITS.linkMax) {
    return { ok: false, errors: { url: `Enter a link starting with https:// (up to ${TASK_LIMITS.linkMax} characters).` } };
  }
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !u.hostname) throw new Error("bad");
  } catch {
    return { ok: false, errors: { url: "Enter a complete link, for example https://example.com/guide." } };
  }
  return { ok: true, value: url };
}

// ---------------------------------------------------------------------------
// Overdue
// ---------------------------------------------------------------------------
// Overdue while it is the owner's turn and the deadline (the due time, or the end of the due day) has passed, in the
// organisation's time zone.
export function isOverdue(task: { status: TaskStatus; dueOn: string; dueTime: string | null }, now: Date, timeZone: string): boolean {
  if (!OWNER_TURN.includes(task.status)) return false;
  const deadline = task.dueTime
    ? zonedInputToDate(`${task.dueOn}T${task.dueTime.slice(0, 5)}`, timeZone)
    : zonedInputToDate(`${nextDay(task.dueOn)}T00:00`, timeZone);
  return deadline !== null && now.getTime() > deadline.getTime();
}
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Database refusals -> messages for people
// ---------------------------------------------------------------------------
export const TASK_DB_MESSAGES: Record<string, string> = {
  not_found: "That task was not found.",
  task_not_open: "This task is closed and can no longer change.",
  task_bad_transition: "That step is not possible for this task right now. Reload the page to see its current state.",
  task_not_owner: "Only the person the task is assigned to can start or submit it.",
  employee_not_active: "This employee is not active (they may have left).",
  employee_no_login: "This employee has no active account. Link their account before giving them a task.",
  outlet_not_active: "Choose an active outlet.",
  task_due_in_past: "The deadline cannot be in the past.",
  task_proof_missing: "Add every kind of proof this task asks for.",
  task_too_many_files: `Attach at most ${TASK_LIMITS.filesMax} files.`,
  task_bad_file: "Attach photos (JPEG, PNG, WebP, HEIC) or PDF files of up to 5 MB.",
  own_task: "Someone else must review your own task.",
  note_required: "Add a note.",
  reason_required: "Give a reason.",
  text_too_long: "That text is too long.",
  text_required: "Give a title and a description.",
  rating_required: "Rate the work from 1 to 5 to approve it.",
  rating_not_allowed: "A rating is given only when approving.",
  bad_link: "Enter a link starting with https://.",
  too_many_resources: "This task already has the most resources it can have.",
};

const CODES = Object.keys(TASK_DB_MESSAGES).sort((a, b) => b.length - a.length);
export function taskRefusal(message: string): string | null {
  for (const code of CODES) if (new RegExp(`\\b${code}\\b`).test(message)) return code;
  return null;
}
