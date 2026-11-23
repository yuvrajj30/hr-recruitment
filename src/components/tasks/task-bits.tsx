import Link from "next/link";
import { dayLabel } from "@/components/leave/leave-bits";
import { Badge } from "@/components/ui/badge";
import type { AuthContext } from "@/lib/auth/context";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { listEmployees, listStructure } from "@/lib/employees/employees";
import {
  RATING_LABELS, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS, type TaskPriority, type TaskRating, type TaskStatus,
} from "@/lib/tasks/rules";
import type { TaskListItem } from "@/lib/tasks/tasks";

// Display pieces shared by the task pages (server-rendered). Days arrive as "YYYY-MM-DD" text, times as "HH:MM".

const STATUS_TONES: Record<TaskStatus, "neutral" | "accent" | "warning" | "success" | "danger"> = {
  ASSIGNED: "neutral", IN_PROGRESS: "accent", SUBMITTED: "warning", CHANGES_REQUESTED: "danger", APPROVED: "success", CANCELLED: "neutral",
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{TASK_STATUS_LABELS[status]}</Badge>;
}

export function OverdueBadge() {
  return <Badge tone="danger">Overdue</Badge>;
}

// "12 Nov 2026" or "12 Nov 2026, 17:30"
export const deadlineLabel = (dueOn: string, dueTime: string | null): string => (dueTime ? `${dayLabel(dueOn)}, ${dueTime}` : dayLabel(dueOn));

export function PriorityText({ priority }: { priority: TaskPriority }) {
  const strong = priority === "HIGH" || priority === "URGENT";
  return <span className={strong ? "font-medium text-warning" : "text-fg-muted"}>{TASK_PRIORITY_LABELS[priority]} priority</span>;
}

// "4/5 Good"
export const ratingLabel = (rating: number): string => `${rating}/5 ${RATING_LABELS[rating as TaskRating] ?? ""}`.trim();

// Links between the task screens. canHr = task:manage (new task).
export function TasksNav({ active, canHr }: { active?: "list" | "new"; canHr: boolean }) {
  const items = [{ key: "list", href: "/tasks", label: "Tasks" }, ...(canHr ? [{ key: "new", href: "/tasks/new", label: "New task" }] : [])];
  return (
    <nav aria-label="Tasks" className="flex flex-wrap gap-2 text-[13px]">
      {items.map((i) => (
        <Link
          key={i.key}
          href={i.href}
          aria-current={i.key === active ? "page" : undefined}
          className={`rounded-md border px-3 py-1.5 font-medium ${i.key === active ? "border-accent bg-accent-soft text-accent-fg" : "border-border-strong text-fg hover:bg-surface-muted"}`}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

// A list of tasks, one row each: title, status, then outlet, deadline, priority (and the person, for HR).
export function TaskRows({ tasks, showOwner }: { tasks: TaskListItem[]; showOwner?: boolean }) {
  return (
    <ul className="divide-y divide-border">
      {tasks.map((t) => (
        <li key={t.id} className="space-y-1.5 px-5 py-3 text-[13px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link href={`/tasks/${t.id}`} className="font-medium text-fg hover:underline">
              {t.title}
            </Link>
            <span className="flex items-center gap-1.5">
              {t.overdue && <OverdueBadge />}
              <TaskStatusBadge status={t.status} />
            </span>
          </div>
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-fg-muted">
            {showOwner && (
              <span className="text-fg">
                {t.ownerName} ({t.ownerCode})
              </span>
            )}
            <span>{t.outlet}</span>
            <span>Due {deadlineLabel(t.dueOn, t.dueTime)}</span>
            <PriorityText priority={t.priority} />
          </p>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Timeline wording
// ---------------------------------------------------------------------------
export const EVENT_LABELS: Record<string, string> = {
  ASSIGNED: "Task assigned",
  EDITED: "Task edited",
  REASSIGNED: "Moved to another person",
  RESOURCE_ADDED: "Reference added",
  RESOURCE_REMOVED: "Reference removed",
  STARTED: "Work started",
  NOTE: "Note added",
  SUBMITTED: "Submitted for review",
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  CANCELLED: "Task cancelled",
};

const CHANGE_LABELS: Record<string, string> = {
  title: "Title", description: "Description", due: "Deadline", priority: "Priority", proof_kinds: "Proof required",
  outlet_id: "Outlet", owner_employee_id: "Person",
};

// What an edit changed, as a short list of field names (the old and new values stay in the history record).
export function changedFields(changes: unknown): string[] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  return Object.keys(changes as Record<string, unknown>).map((k) => CHANGE_LABELS[k] ?? k);
}

// ---------------------------------------------------------------------------
// Pickers for HR: people and outlets, as "Full name (EMPLOYEE-CODE)" and the outlet name
// ---------------------------------------------------------------------------
export type PickChoice = { id: string; label: string };

// People who can be given a task: active, with a linked login (includeLeft: everyone and every outlet, for filters). Needs the employee list (employee:read); without it the
// list is empty and the page says so.
export async function loadTaskChoices(auth: AuthContext, options: { includeLeft?: boolean } = {}): Promise<{ employees: PickChoice[]; outlets: PickChoice[]; canListEmployees: boolean }> {
  const db = getAuthRuntime().db;
  const canListEmployees = auth.permissions.has("employee:read");
  const [people, structure] = await Promise.all([
    canListEmployees ? listEmployees(db, auth, { status: options.includeLeft ? "ALL" : "ACTIVE" }) : Promise.resolve([]),
    canListEmployees ? listStructure(db, auth) : Promise.resolve(null),
  ]);
  const employees = people
    .filter((p) => options.includeLeft || p.hasAccount)
    .map((p) => ({ id: p.id, label: `${p.fullName} (${p.employeeCode})${p.status === "ACTIVE" ? "" : " - left"}` }));
  const outlets = (structure?.outlet ?? []).filter((o) => options.includeLeft || o.isActive).map((o) => ({ id: o.id, label: o.name }));
  return { employees, outlets, canListEmployees };
}
