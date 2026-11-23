import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { databaseMessage, isUuid } from "@/lib/attendance/rules";
import { type AuthContext, requireAnyPermission, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import type { Db } from "@/lib/db";
import { staffDb } from "@/lib/db-context";
import type { AppDeps } from "@/lib/recruitment/applications";
import { conflict, invalid, notFound, RecruitmentError } from "@/lib/recruitment/errors";
import { newStorageKey } from "@/lib/recruitment/storage";
import { checkEvidence } from "./evidence";
import {
  isOverdue, OPEN_STATUSES, parseLink, TASK_DB_MESSAGES, TASK_LIMITS, taskRefusal, type TaskInput, type TaskPriority, type TaskProofKind, type TaskStatus,
} from "./rules";

// Tasks: HR assigns an occasional task to one employee (with a linked, active login) at one outlet; the owner starts it
// and submits proof; HR approves it with a 1-5 rating or requests changes.
//
// Who may do what is decided twice: here by permission key (task:manage for HR, self:task for one's own tasks), and
// again by PostgreSQL (migrations 20261124000000_tasks, 20261124000100_task_functions, 20261124000200_task_fixes). The
// app account only READS the task tables; every change is a database function that takes the actor from the session and
// writes the history and the notifications. Files are stored here first (private store, tasks/ folder) and removed
// again if the database refuses.

export type TaskDeps = AppDeps;
type Tx = Prisma.TransactionClient;
type Meta = Record<string, string | number | boolean | null>;
type Upload = { name: string; size: number; bytes: Uint8Array };

const CONFLICTS = new Set(["task_bad_transition", "task_not_open", "own_task"]);
function friendly(error: unknown): Error {
  if (error instanceof RecruitmentError) return error;
  const msg = databaseMessage(error);
  if (!msg) return error as Error;
  if (/deadlock detected|could not serialize/i.test(msg)) return conflict("Someone else changed this task at the same moment. Please try again.");
  const code = taskRefusal(msg);
  if (!code) return error as Error;
  if (code === "not_found") return notFound("That task");
  return CONFLICTS.has(code) ? conflict(TASK_DB_MESSAGES[code]!) : invalid(TASK_DB_MESSAGES[code]!);
}
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw friendly(e);
  }
}
async function audit(deps: TaskDeps, tx: Tx, ctx: AuthContext, organizationId: string, action: string, entityId: string, metadata: Meta = {}) {
  await deps.writeAudit(tx, { organizationId, actorUserId: ctx.user.id, action, entityType: "task", entityId, metadata, ...deps.client, now: deps.now });
}
const dayText = (d: Date): string => d.toISOString().slice(0, 10); // DATE columns arrive as UTC midnight
const timeText = (d: Date | null): string | null => (d ? d.toISOString().slice(11, 16) : null); // TIME columns arrive on 1970-01-01 UTC

// ---------------------------------------------------------------------------
// Shapes handed to the screens (plain values)
// ---------------------------------------------------------------------------
export type TaskListItem = {
  id: string; title: string; status: TaskStatus; priority: TaskPriority; dueOn: string; dueTime: string | null; overdue: boolean;
  outletId: string; outlet: string; ownerId: string; ownerName: string; ownerCode: string; rating: number | null; updatedAt: Date;
};
export type TaskEventView = { id: string; kind: string; fromStatus: TaskStatus | null; toStatus: TaskStatus; note: string | null; changes: unknown; actor: string | null; at: Date };
export type EvidenceView = { id: string; name: string; mimeType: string; sizeBytes: number };
export type SubmissionView = { id: string; number: number; text: string | null; submittedBy: string | null; at: Date; evidence: EvidenceView[] };
export type ResourceView = { id: string; kind: "FILE" | "LINK"; name: string; url: string | null; mimeType: string | null; sizeBytes: number | null; addedAt: Date; removedAt: Date | null };
export type TaskDetail = TaskListItem & {
  description: string; proofKinds: TaskProofKind[]; createdAt: Date; createdBy: string | null; decisionNote: string | null; decidedBy: string | null;
  decidedAt: Date | null; ratingComment: string | null; selfReviewed: boolean; cancelReason: string | null;
  events: TaskEventView[]; submissions: SubmissionView[]; resources: ResourceView[];
  isOwner: boolean; canWork: boolean; canReview: boolean; canEdit: boolean;
};

const listSelect = {
  id: true, title: true, status: true, priority: true, dueOn: true, dueTime: true, outletId: true, ownerEmployeeId: true, rating: true, updatedAt: true,
  outlet: { select: { name: true } }, owner: { select: { fullName: true, employeeCode: true } },
} satisfies Prisma.TaskSelect;
type ListRow = Prisma.TaskGetPayload<{ select: typeof listSelect }>;
const toListItem = (t: ListRow, now: Date, timeZone: string): TaskListItem => {
  const status = t.status as TaskStatus;
  const dueOn = dayText(t.dueOn);
  const dueTime = timeText(t.dueTime);
  return {
    id: t.id, title: t.title, status, priority: t.priority as TaskPriority, dueOn, dueTime, overdue: isOverdue({ status, dueOn, dueTime }, now, timeZone),
    outletId: t.outletId, outlet: t.outlet.name, ownerId: t.ownerEmployeeId, ownerName: t.owner.fullName, ownerCode: t.owner.employeeCode,
    rating: t.rating, updatedAt: t.updatedAt,
  };
};

async function orgTimeZone(tx: Tx | ReturnType<typeof staffDb>, organizationId: string): Promise<string> {
  const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } });
  return org?.timezone ?? "UTC";
}
async function myEmployeeId(tx: Tx): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string | null }[]>`SELECT app_my_employee_id()::text AS id`;
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Lists and detail
// ---------------------------------------------------------------------------
export type TaskFilter = { status?: "OPEN" | "SUBMITTED" | "DONE" | "ALL"; ownerId?: string; outletId?: string };

export async function listTasks(rawDb: Db, ctx: AuthContext, filter: TaskFilter): Promise<TaskListItem[]> {
  requirePermission(ctx, "task:manage");
  const organizationId = requireOrganizationId(ctx);
  const status = filter.status ?? "OPEN";
  const where: Prisma.TaskWhereInput = {
    organizationId,
    ...(status === "OPEN" ? { status: { in: ["ASSIGNED", "IN_PROGRESS", "CHANGES_REQUESTED", "SUBMITTED"] } } : {}),
    ...(status === "SUBMITTED" ? { status: "SUBMITTED" } : {}),
    ...(status === "DONE" ? { status: { in: ["APPROVED", "CANCELLED"] } } : {}),
    ...(filter.ownerId && isUuid(filter.ownerId) ? { ownerEmployeeId: filter.ownerId } : {}),
    ...(filter.outletId && isUuid(filter.outletId) ? { outletId: filter.outletId } : {}),
  };
  return staffDb(rawDb, ctx).$transaction(async (tx) => {
    const tz = await orgTimeZone(tx, organizationId);
    const rows = await tx.task.findMany({ where, orderBy: [{ dueOn: "asc" }, { createdAt: "asc" }], take: 500, select: listSelect });
    const now = new Date();
    return rows.map((r) => toListItem(r, now, tz));
  });
}

export async function listMyTasks(rawDb: Db, ctx: AuthContext): Promise<TaskListItem[]> {
  requirePermission(ctx, "self:task");
  const organizationId = requireOrganizationId(ctx);
  return staffDb(rawDb, ctx).$transaction(async (tx) => {
    const me = await myEmployeeId(tx);
    if (!me) return [];
    const tz = await orgTimeZone(tx, organizationId);
    const rows = await tx.task.findMany({
      where: { organizationId, ownerEmployeeId: me }, orderBy: [{ dueOn: "asc" }, { createdAt: "asc" }], take: 300, select: listSelect,
    });
    const now = new Date();
    return rows.map((r) => toListItem(r, now, tz));
  });
}

// Approved tasks of one employee, with HR's rating, for a human review later. Nothing is totalled or averaged.
export async function listApprovedTasksForEmployee(rawDb: Db, ctx: AuthContext, employeeId: string): Promise<(TaskListItem & { ratingComment: string | null; decidedAt: Date | null })[]> {
  requirePermission(ctx, "task:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(employeeId)) return [];
  return staffDb(rawDb, ctx).$transaction(async (tx) => {
    const tz = await orgTimeZone(tx, organizationId);
    const rows = await tx.task.findMany({
      where: { organizationId, ownerEmployeeId: employeeId, status: "APPROVED" }, orderBy: { decidedAt: "desc" }, take: 200,
      select: { ...listSelect, ratingComment: true, decidedAt: true },
    });
    const now = new Date();
    return rows.map((r) => ({ ...toListItem(r, now, tz), ratingComment: r.ratingComment, decidedAt: r.decidedAt }));
  });
}

export async function getTask(rawDb: Db, ctx: AuthContext, taskId: string): Promise<TaskDetail> {
  requireAnyPermission(ctx, ["self:task", "task:manage"]);
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(taskId)) throw notFound("That task");
  const isHr = ctx.permissions.has("task:manage");
  return staffDb(rawDb, ctx).$transaction(async (tx) => {
    const t = await tx.task.findFirst({
      where: { id: taskId, organizationId },
      select: {
        ...listSelect, description: true, proofKinds: true, createdAt: true, decisionNote: true, decidedAt: true, ratingComment: true, selfReviewed: true,
        cancelReason: true, createdBy: { select: { name: true } }, decidedBy: { select: { name: true } },
        events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, kind: true, fromStatus: true, toStatus: true, note: true, changes: true, createdAt: true, actor: { select: { name: true } } } },
        submissions: { orderBy: { number: "asc" }, select: { id: true, number: true, text: true, createdAt: true, submittedBy: { select: { name: true } },
          evidence: { orderBy: { createdAt: "asc" }, select: { id: true, originalName: true, mimeType: true, sizeBytes: true } } } },
        resources: { orderBy: { addedAt: "asc" }, select: { id: true, kind: true, originalName: true, url: true, mimeType: true, sizeBytes: true, addedAt: true, removedAt: true } },
      },
    });
    if (!t) throw notFound("That task");
    const tz = await orgTimeZone(tx, organizationId);
    const me = ctx.permissions.has("self:task") ? await myEmployeeId(tx) : null;
    const item = toListItem(t, new Date(), tz);
    const isOwner = me !== null && me === t.ownerEmployeeId;
    const open = OPEN_STATUSES.includes(item.status);
    return {
      ...item,
      description: t.description, proofKinds: t.proofKinds as TaskProofKind[], createdAt: t.createdAt, createdBy: t.createdBy?.name ?? null,
      decisionNote: t.decisionNote, decidedBy: t.decidedBy?.name ?? null, decidedAt: t.decidedAt, ratingComment: t.ratingComment,
      selfReviewed: t.selfReviewed, cancelReason: t.cancelReason,
      // HR's reasons for editing or moving a task stay with HR (they may be about a previous owner): an owner sees that
      // the task changed and what changed, not why.
      events: t.events.map((e) => ({ id: e.id, kind: e.kind, fromStatus: e.fromStatus as TaskStatus | null, toStatus: e.toStatus as TaskStatus,
        note: !isHr && (e.kind === "EDITED" || e.kind === "REASSIGNED") ? null : e.note, changes: e.changes,
        actor: e.actor?.name ?? null, at: e.createdAt })),
      submissions: t.submissions.map((s) => ({ id: s.id, number: s.number, text: s.text, submittedBy: s.submittedBy?.name ?? null, at: s.createdAt,
        evidence: s.evidence.map((v) => ({ id: v.id, name: v.originalName, mimeType: v.mimeType, sizeBytes: v.sizeBytes })) })),
      resources: t.resources.filter((r) => isHr || r.removedAt === null).map((r) => ({ id: r.id, kind: r.kind as "FILE" | "LINK", name: r.originalName, url: r.url,
        mimeType: r.mimeType, sizeBytes: r.sizeBytes, addedAt: r.addedAt, removedAt: r.removedAt })),
      isOwner,
      canWork: isOwner && ["ASSIGNED", "IN_PROGRESS", "CHANGES_REQUESTED"].includes(item.status),
      canReview: isHr && item.status === "SUBMITTED",
      canEdit: isHr && open,
    };
  });
}

// ---------------------------------------------------------------------------
// HR: assign, edit, review, cancel, resources
// ---------------------------------------------------------------------------
export async function assignTask(deps: TaskDeps, ctx: AuthContext, input: TaskInput): Promise<string> {
  requirePermission(ctx, "task:manage");
  const organizationId = requireOrganizationId(ctx);
  return run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT app_assign_task(${input.ownerId}::uuid, ${input.outletId}::uuid, ${input.title}, ${input.description}, ${input.dueOn}::date,
        ${input.dueTime}::time, ${input.priority}::"TaskPriority", ${input.proof}::text[]::"TaskProofKind"[])::text AS id`;
    const id = rows[0]!.id;
    await audit(deps, tx, ctx, organizationId, "task.assigned", id, { ownerId: input.ownerId, outletId: input.outletId, dueOn: input.dueOn });
    return id;
  }));
}

// Moving a task to another person needs a reason, and puts it back to "Assigned" for them.
export async function editTask(deps: TaskDeps, ctx: AuthContext, taskId: string, input: TaskInput, reason: string | null): Promise<void> {
  requirePermission(ctx, "task:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(taskId)) throw notFound("That task");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT app_edit_task(${taskId}::uuid, ${input.title}, ${input.description}, ${input.dueOn}::date, ${input.dueTime}::time, ${input.priority}::"TaskPriority",
        ${input.proof}::text[]::"TaskProofKind"[], ${input.outletId}::uuid, ${input.ownerId}::uuid, ${reason})::text AS done`;
    await audit(deps, tx, ctx, organizationId, "task.edited", taskId);
  }));
}

export async function reviewTask(deps: TaskDeps, ctx: AuthContext, taskId: string, approve: boolean, rating: number | null, note: string | null): Promise<void> {
  requirePermission(ctx, "task:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(taskId)) throw notFound("That task");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    await tx.$queryRaw`SELECT app_review_task(${taskId}::uuid, ${approve}, ${rating}::smallint, ${note})::text AS done`;
    await audit(deps, tx, ctx, organizationId, approve ? "task.approved" : "task.changes_requested", taskId, approve ? { rating } : {});
  }));
}

export async function cancelTask(deps: TaskDeps, ctx: AuthContext, taskId: string, reason: string): Promise<void> {
  requirePermission(ctx, "task:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(taskId)) throw notFound("That task");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    await tx.$queryRaw`SELECT app_cancel_task(${taskId}::uuid, ${reason})::text AS done`;
    await audit(deps, tx, ctx, organizationId, "task.cancelled", taskId);
  }));
}

// A reference for the owner: a file (checked by content, stored privately) or an https link.
export async function addTaskResource(deps: TaskDeps, ctx: AuthContext, taskId: string, input: { file?: Upload; url?: string }): Promise<string> {
  requirePermission(ctx, "task:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(taskId)) throw notFound("That task");
  if (input.url !== undefined) {
    const link = parseLink(input.url);
    if (!link.ok) throw invalid(link.errors.url!);
    return run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT app_add_task_resource(${taskId}::uuid, 'LINK', NULL, ${link.value}, NULL, NULL, NULL, NULL)::text AS id`;
      await audit(deps, tx, ctx, organizationId, "task.resource_added", taskId, { kind: "LINK" });
      return rows[0]!.id;
    }));
  }
  if (!input.file) throw invalid("Choose a file or enter a link.");
  const check = checkEvidence(input.file, input.file.bytes);
  if (!check.ok) throw invalid(check.message);
  const key = newStorageKey("tasks", deps.now);
  await deps.storage.put(key, input.file.bytes);
  try {
    return await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT app_add_task_resource(${taskId}::uuid, 'FILE', ${key}, NULL, ${check.safeName}, ${check.kind.mimeType}, ${input.file!.bytes.length}::int,
          ${sha256(input.file!.bytes)})::text AS id`;
      await audit(deps, tx, ctx, organizationId, "task.resource_added", taskId, { kind: "FILE" });
      return rows[0]!.id;
    }));
  } catch (e) {
    await deps.storage.remove(key).catch(() => undefined);
    throw e;
  }
}

export async function removeTaskResource(deps: TaskDeps, ctx: AuthContext, resourceId: string): Promise<void> {
  requirePermission(ctx, "task:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(resourceId)) throw notFound("That resource");
  await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
    await tx.$queryRaw`SELECT app_remove_task_resource(${resourceId}::uuid)::text AS done`;
    await audit(deps, tx, ctx, organizationId, "task.resource_removed", resourceId);
  }));
}

// ---------------------------------------------------------------------------
// The owner: start, note, submit
// ---------------------------------------------------------------------------
export async function startTask(deps: TaskDeps, ctx: AuthContext, taskId: string): Promise<void> {
  requireAnyPermission(ctx, ["self:task", "task:manage"]);
  if (!isUuid(taskId)) throw notFound("That task");
  await run(() => staffDb(deps.db, ctx).$queryRaw`SELECT app_start_task(${taskId}::uuid)::text AS done`);
}

export async function addTaskNote(deps: TaskDeps, ctx: AuthContext, taskId: string, note: string): Promise<void> {
  requireAnyPermission(ctx, ["self:task", "task:manage"]);
  if (!isUuid(taskId)) throw notFound("That task");
  await run(() => staffDb(deps.db, ctx).$queryRaw`SELECT app_add_task_note(${taskId}::uuid, ${note})::text AS done`);
}

// Every file is checked before any is stored; if the database refuses, the stored files are removed again.
export async function submitTask(deps: TaskDeps, ctx: AuthContext, taskId: string, text: string | null, files: Upload[]): Promise<string> {
  requirePermission(ctx, "self:task");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(taskId)) throw notFound("That task");
  if (files.length > TASK_LIMITS.filesMax) throw invalid(TASK_DB_MESSAGES.task_too_many_files!);
  if (files.reduce((sum, f) => sum + f.bytes.length, 0) > TASK_LIMITS.uploadTotalMaxBytes) throw invalid("Attach at most 5 MB in total. Use fewer or smaller photos.");
  const checked = files.map((f) => ({ f, check: checkEvidence(f, f.bytes) }));
  const bad = checked.find((c) => !c.check.ok);
  if (bad && !bad.check.ok) throw invalid(bad.check.message);
  const stored: string[] = [];
  try {
    const evidence: { storage_key: string; original_name: string; mime_type: string; size_bytes: number; sha256: string }[] = [];
    for (const { f, check } of checked) {
      if (!check.ok) continue;
      const key = newStorageKey("tasks", deps.now);
      await deps.storage.put(key, f.bytes);
      stored.push(key);
      evidence.push({ storage_key: key, original_name: check.safeName, mime_type: check.kind.mimeType, size_bytes: f.bytes.length, sha256: sha256(f.bytes) });
    }
    return await run(() => staffDb(deps.db, ctx).$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT app_submit_task(${taskId}::uuid, ${text}, ${JSON.stringify(evidence)}::jsonb)::text AS id`;
      await audit(deps, tx, ctx, organizationId, "task.submitted", taskId, { files: evidence.length });
      return rows[0]!.id;
    }));
  } catch (e) {
    for (const key of stored) await deps.storage.remove(key).catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Files out: only to someone who may see the task (row-level security decides), always audited
// ---------------------------------------------------------------------------
export type DownloadableFile = { name: string; mimeType: string; bytes: Uint8Array };

export async function readEvidence(deps: TaskDeps, ctx: AuthContext, evidenceId: string): Promise<DownloadableFile> {
  requireAnyPermission(ctx, ["self:task", "task:manage"]);
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(evidenceId)) throw notFound("That file");
  const db = staffDb(deps.db, ctx);
  const ev = await db.taskEvidence.findFirst({ where: { id: evidenceId, organizationId }, select: { taskId: true, originalName: true, mimeType: true, storageKey: true } });
  if (!ev) throw notFound("That file");
  const bytes = await deps.storage.get(ev.storageKey);
  if (!bytes) throw notFound("That file");
  await deps.writeAudit(db, { organizationId, actorUserId: ctx.user.id, action: "task.evidence_downloaded", entityType: "task_evidence", entityId: evidenceId,
    metadata: { taskId: ev.taskId }, ...deps.client, now: deps.now });
  return { name: ev.originalName, mimeType: ev.mimeType, bytes };
}

export async function readResource(deps: TaskDeps, ctx: AuthContext, resourceId: string): Promise<DownloadableFile> {
  requireAnyPermission(ctx, ["self:task", "task:manage"]);
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(resourceId)) throw notFound("That file");
  const db = staffDb(deps.db, ctx);
  const r = await db.taskResource.findFirst({
    where: { id: resourceId, organizationId, kind: "FILE", removedAt: null }, select: { taskId: true, originalName: true, mimeType: true, storageKey: true },
  });
  if (!r || !r.storageKey || !r.mimeType) throw notFound("That file");
  const bytes = await deps.storage.get(r.storageKey);
  if (!bytes) throw notFound("That file");
  await deps.writeAudit(db, { organizationId, actorUserId: ctx.user.id, action: "task.resource_downloaded", entityType: "task_resource", entityId: resourceId,
    metadata: { taskId: r.taskId }, ...deps.client, now: deps.now });
  return { name: r.originalName, mimeType: r.mimeType, bytes };
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
