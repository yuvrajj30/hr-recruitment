import { ArrowLeft, Check, Circle, FileText, Link2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/recruitment/job-bits";
import {
  changedFields, deadlineLabel, EVENT_LABELS, loadTaskChoices, OverdueBadge, PriorityText, TaskStatusBadge,
} from "@/components/tasks/task-bits";
import {
  AddFileForm, AddLinkForm, CancelTaskForm, EditTaskForm, NoteForm, RemoveResourceButton, ReviewTaskForm, StartTaskButton, SubmitTaskForm,
} from "@/components/tasks/task-forms";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { localDay } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { formatDateTime, formatFileSize } from "@/lib/recruitment/labels";
import { PROOF_LABELS, RATING_LABELS, type TaskProofKind, type TaskRating } from "@/lib/tasks/rules";
import { getTask, type TaskDetail } from "@/lib/tasks/tasks";

export const metadata: Metadata = { title: "Task · HRMS" };

export default function TaskPage(props: PageProps<"/tasks/[taskId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TaskContent params={props.params} />
    </Suspense>
  );
}

async function TaskContent({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/tasks/${taskId}`)}&reason=expired`);
  if (!auth.permissions.has("self:task") && !auth.permissions.has("task:manage")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Task" />
        <NoAccess what="see tasks" />
      </div>
    );
  }

  const rt = getAuthRuntime();
  let task: TaskDetail;
  try {
    task = await getTask(rt.db, auth, taskId);
  } catch (error) {
    if (error instanceof RecruitmentError && error.code === "not_found") notFound();
    throw error;
  }
  const isHr = auth.permissions.has("task:manage");
  const tz = await attendanceTimezone(rt.db, auth);
  const today = localDay(new Date(), tz);
  const choices = task.canEdit ? await loadTaskChoices(auth) : null;
  const owner = { id: task.ownerId, label: `${task.ownerName} (${task.ownerCode})` };
  const employees = choices ? (choices.employees.some((e) => e.id === owner.id) ? choices.employees : [owner, ...choices.employees]) : [];
  const outlets = choices ? (choices.outlets.some((o) => o.id === task.outletId) ? choices.outlets : [{ id: task.outletId, label: task.outlet }, ...choices.outlets]) : [];

  const latest = task.submissions.at(-1);
  const judged = task.status === "SUBMITTED" || task.status === "APPROVED";
  const hasPhoto = latest?.evidence.some((v) => v.mimeType.startsWith("image/")) ?? false;
  const hasPdf = latest?.evidence.some((v) => v.mimeType === "application/pdf") ?? false;
  const proofDone: Record<TaskProofKind, boolean> = { PHOTO: judged && hasPhoto, DOCUMENT: judged && hasPdf, TEXT: judged && Boolean(latest?.text) };
  const needsText = task.proofKinds.includes("TEXT");
  const needsFiles = task.proofKinds.includes("PHOTO") || task.proofKinds.includes("DOCUMENT");
  const open = task.status !== "APPROVED" && task.status !== "CANCELLED";
  const resources = task.resources;

  return (
    <div className="space-y-6">
      <Link href="/tasks" className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        Tasks
      </Link>

      <PageHeader title={task.title} />

      <Card>
        <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <span className="flex items-center gap-2">
            <TaskStatusBadge status={task.status} />
            {task.overdue && <OverdueBadge />}
          </span>
          <dl className="grid flex-1 gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
            <Meta label="Deadline">{deadlineLabel(task.dueOn, task.dueTime)}</Meta>
            <Meta label="Priority">
              <PriorityText priority={task.priority} />
            </Meta>
            <Meta label="Outlet">{task.outlet}</Meta>
            <Meta label="Assigned to">{owner.label}</Meta>
          </dl>
        </CardBody>
      </Card>

      {task.status === "CHANGES_REQUESTED" && (
        <Alert tone="warning">
          <span className="block font-medium">HR asked for changes</span>
          <span className="block whitespace-pre-wrap">{task.decisionNote ?? "Check the history below, then submit again."}</span>
        </Alert>
      )}
      {task.status === "APPROVED" && task.rating !== null && (
        <Alert tone="success">
          <span className="block font-medium">Approved — rated {task.rating}/5 ({RATING_LABELS[task.rating as TaskRating]})</span>
          {task.ratingComment && <span className="block whitespace-pre-wrap">{task.ratingComment}</span>}
        </Alert>
      )}
      {task.status === "CANCELLED" && (
        <Alert tone="warning">
          <span className="block font-medium">This task was cancelled</span>
          {task.cancelReason && <span className="block whitespace-pre-wrap">{task.cancelReason}</span>}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>What to do</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <p className="text-[13px] whitespace-pre-wrap text-fg">{task.description}</p>
              <div>
                <h3 className="text-xs font-medium text-fg-muted">Proof required</h3>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                  {task.proofKinds.map((k) => (
                    <li key={k} className="flex items-center gap-2 text-fg">
                      {proofDone[k] ? <Check className="size-4 text-success" aria-label="Given" /> : <Circle className="size-4 text-fg-subtle" aria-label="Not given yet" />}
                      {PROOF_LABELS[k]}
                    </li>
                  ))}
                </ul>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>References</CardTitle>
                <CardDescription>Files and links from HR to help with the task.</CardDescription>
              </div>
            </CardHeader>
            {resources.length === 0 ? (
              <CardBody>
                <p className="text-[13px] text-fg-muted">There are no references for this task.</p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-border text-[13px]">
                {resources.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                    {r.removedAt ? (
                      <span className="text-fg-muted line-through">{r.kind === "LINK" ? r.url : r.name}</span>
                    ) : r.kind === "LINK" && r.url?.startsWith("https://") ? (
                      <a href={r.url} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-2 text-accent-fg hover:underline">
                        <Link2 className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{r.url}</span>
                      </a>
                    ) : (
                      <a href={`/api/task-resources/${r.id}`} className="flex min-w-0 items-center gap-2 text-accent-fg hover:underline">
                        <FileText className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{r.name}</span>
                        {r.sizeBytes !== null && <span className="text-fg-muted">{formatFileSize(r.sizeBytes)}</span>}
                      </a>
                    )}
                    <span className="flex items-center gap-2 text-fg-muted">
                      {r.removedAt ? "Removed" : null}
                      {isHr && open && !r.removedAt && <RemoveResourceButton resourceId={r.id} />}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {isHr && task.canEdit && (
              <CardBody className="grid gap-4 border-t border-border sm:grid-cols-2">
                <AddFileForm taskId={task.id} />
                <AddLinkForm taskId={task.id} />
              </CardBody>
            )}
          </Card>

          {task.canWork && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>{task.status === "IN_PROGRESS" ? "Hand in your work" : "Your turn"}</CardTitle>
                  <CardDescription>
                    {task.status === "IN_PROGRESS"
                      ? "Give every kind of proof the task asks for, then submit it for HR to review."
                      : "Start the task when you begin the work."}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardBody className="space-y-5">
                {task.status === "IN_PROGRESS" ? (
                  <SubmitTaskForm taskId={task.id} needsText={needsText} needsFiles={needsFiles} />
                ) : (
                  <StartTaskButton taskId={task.id} again={task.status === "CHANGES_REQUESTED"} />
                )}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Submissions</CardTitle>
                <CardDescription>What was handed in, oldest first.</CardDescription>
              </div>
            </CardHeader>
            {task.submissions.length === 0 ? (
              <CardBody>
                <p className="text-[13px] text-fg-muted">Nothing has been submitted yet.</p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-border text-[13px]">
                {task.submissions.map((s) => (
                  <li key={s.id} className="space-y-2 px-5 py-3">
                    <p className="font-medium text-fg">
                      Submission {s.number}
                      <span className="ml-2 font-normal text-fg-muted">
                        {formatDateTime(s.at, tz)}
                        {s.submittedBy ? `, ${s.submittedBy}` : ""}
                      </span>
                    </p>
                    {s.text && <p className="whitespace-pre-wrap text-fg">{s.text}</p>}
                    {s.evidence.length > 0 && (
                      <ul className="space-y-1">
                        {s.evidence.map((v) => (
                          <li key={v.id}>
                            <a href={`/api/task-evidence/${v.id}`} className="inline-flex items-center gap-2 text-accent-fg hover:underline">
                              <FileText className="size-4" aria-hidden />
                              {v.name}
                              <span className="text-fg-muted">{formatFileSize(v.sizeBytes)}</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {task.canReview && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Review</CardTitle>
                  <CardDescription>Approve the work with a rating, or ask for changes.</CardDescription>
                </div>
              </CardHeader>
              <CardBody>
                <ReviewTaskForm taskId={task.id} />
              </CardBody>
            </Card>
          )}

          {(task.canWork || task.canEdit) && (
            <Card>
              <CardBody>
                <NoteForm taskId={task.id} />
              </CardBody>
            </Card>
          )}

          {task.canEdit && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Change or cancel</CardTitle>
                  <CardDescription>Edit the details, move the task to someone else, or cancel it.</CardDescription>
                </div>
              </CardHeader>
              <CardBody className="space-y-3">
                <details className="rounded-md border border-border">
                  <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-medium text-fg">Edit task</summary>
                  <div className="border-t border-border px-4 py-4">
                    <EditTaskForm
                      task={{
                        id: task.id, ownerId: task.ownerId, outletId: task.outletId, title: task.title, description: task.description, dueOn: task.dueOn,
                        dueTime: task.dueTime, priority: task.priority, proof: task.proofKinds,
                      }}
                      employees={employees}
                      outlets={outlets}
                      today={today}
                    />
                  </div>
                </details>
                <details className="rounded-md border border-border">
                  <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-medium text-danger">Cancel task</summary>
                  <div className="border-t border-border px-4 py-4">
                    <CancelTaskForm taskId={task.id} />
                  </div>
                </details>
              </CardBody>
            </Card>
          )}
        </div>

        <Card className="self-start">
          <CardHeader>
            <div>
              <CardTitle>History</CardTitle>
              <CardDescription>Everything that happened, oldest first.</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <ol className="space-y-4 border-l border-border pl-4">
              {task.events.map((e) => {
                const fields = e.kind === "EDITED" || e.kind === "REASSIGNED" ? changedFields(e.changes) : [];
                return (
                  <li key={e.id} className="relative text-[13px]">
                    <span className="absolute top-1.5 -left-[1.28rem] size-2 rounded-full bg-border-strong" aria-hidden />
                    <p className="font-medium text-fg">{EVENT_LABELS[e.kind] ?? e.kind}</p>
                    <p className="text-xs text-fg-muted">
                      {formatDateTime(e.at, tz)}
                      {e.actor ? `, ${e.actor}` : ""}
                    </p>
                    {fields.length > 0 && <p className="mt-1 text-fg-muted">Changed: {fields.join(", ")}</p>}
                    {e.note && <p className="mt-1 whitespace-pre-wrap text-fg">{e.note}</p>}
                  </li>
                );
              })}
            </ol>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="font-medium text-fg">{children}</dd>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading task">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-20" />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Skeleton className="h-96" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
