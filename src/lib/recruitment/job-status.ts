import type { PermissionKey } from "@/lib/auth/permission-keys";

// The life of a job opening, and who may move it along.
//
//   DRAFT --publish--> PUBLISHED --close--> CLOSED --archive--> ARCHIVED
//     ^                  |   ^                |
//     +----unpublish-----+   +----reopen------+
//   DRAFT --archive--> ARCHIVED   (a draft that will never be used)
//
// ARCHIVED is the end: nothing moves out of it. Jobs are archived rather than deleted, because
// applications point at them and the hiring history must stay intact.

export type JobStatus = "DRAFT" | "PUBLISHED" | "CLOSED" | "ARCHIVED";
export type JobAction = "publish" | "unpublish" | "close" | "reopen" | "archive";

type Transition = { from: readonly JobStatus[]; to: JobStatus; permission: PermissionKey };

export const JOB_TRANSITIONS: Record<JobAction, Transition> = {
  publish: { from: ["DRAFT"], to: "PUBLISHED", permission: "job:publish" },
  unpublish: { from: ["PUBLISHED"], to: "DRAFT", permission: "job:publish" },
  close: { from: ["PUBLISHED"], to: "CLOSED", permission: "job:close" },
  reopen: { from: ["CLOSED"], to: "PUBLISHED", permission: "job:publish" },
  archive: { from: ["DRAFT", "CLOSED"], to: "ARCHIVED", permission: "job:close" },
};

export const JOB_ACTIONS = Object.keys(JOB_TRANSITIONS) as JobAction[];

export const isJobAction = (value: unknown): value is JobAction =>
  typeof value === "string" && (JOB_ACTIONS as string[]).includes(value);

export function canTransition(status: JobStatus, action: JobAction): boolean {
  return JOB_TRANSITIONS[action].from.includes(status);
}

// The buttons to show for a job: allowed from its current status AND permitted for this person.
export function availableJobActions(status: JobStatus, permissions: ReadonlySet<string>): JobAction[] {
  return JOB_ACTIONS.filter((a) => canTransition(status, a) && permissions.has(JOB_TRANSITIONS[a].permission));
}

// Archived jobs are kept for the record and can no longer be edited.
export const isEditable = (status: JobStatus): boolean => status !== "ARCHIVED";

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  CLOSED: "Closed",
  ARCHIVED: "Archived",
};

export const JOB_ACTION_LABELS: Record<JobAction, string> = {
  publish: "Publish",
  unpublish: "Move back to draft",
  close: "Close applications",
  reopen: "Reopen",
  archive: "Archive",
};
