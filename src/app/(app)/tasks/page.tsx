import { ClipboardCheck, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/recruitment/job-bits";
import { loadTaskChoices, TaskRows, TasksNav } from "@/components/tasks/task-bits";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { OPEN_STATUSES } from "@/lib/tasks/rules";
import { listMyTasks, listTasks, type TaskFilter } from "@/lib/tasks/tasks";

export const metadata: Metadata = { title: "Tasks · HRMS" };

const STATUS_FILTERS = [
  { value: "OPEN", label: "Open" },
  { value: "SUBMITTED", label: "Waiting for review" },
  { value: "DONE", label: "Done" },
  { value: "ALL", label: "All" },
] as const;

export default function TasksPage(props: PageProps<"/tasks">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TasksContent searchParams={props.searchParams} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

async function TasksContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Ftasks&reason=expired");
  const isHr = auth.permissions.has("task:manage");
  const isSelf = auth.permissions.has("self:task");
  if (!isHr && !isSelf) {
    return (
      <div className="space-y-6">
        <PageHeader title="Tasks" />
        <NoAccess what="see tasks" />
      </div>
    );
  }

  const q = await searchParams;
  const rt = getAuthRuntime();
  const status = STATUS_FILTERS.find((s) => s.value === one(q.status))?.value ?? "OPEN";
  const owner = one(q.owner);
  const outlet = one(q.outlet);
  const filter: TaskFilter = { status, ownerId: owner || undefined, outletId: outlet || undefined };
  const [mine, all, choices] = await Promise.all([
    isSelf ? listMyTasks(rt.db, auth) : Promise.resolve([]),
    isHr ? listTasks(rt.db, auth, filter) : Promise.resolve([]),
    isHr ? loadTaskChoices(auth, { includeLeft: true }) : Promise.resolve(null),
  ]);
  // Open tasks first (nearest deadline first, as listed), then the finished ones.
  const myOpen = mine.filter((t) => OPEN_STATUSES.includes(t.status));
  const myDone = mine.filter((t) => !OPEN_STATUSES.includes(t.status));
  const filtered = status !== "OPEN" || owner !== "" || outlet !== "";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description="Work that HR gives to a person at an outlet, with proof and a review."
        actions={
          isHr && (
            <Button asChild>
              <Link href="/tasks/new">
                <Plus aria-hidden />
                New task
              </Link>
            </Button>
          )
        }
      />
      <TasksNav active="list" canHr={isHr} />

      {isSelf && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>My tasks</CardTitle>
              <CardDescription>Open tasks first, then the ones that are finished.</CardDescription>
            </div>
          </CardHeader>
          {mine.length === 0 ? (
            <EmptyState icon={ClipboardCheck} title="No tasks for you" description="When HR gives you a task it appears here, and you get a notification." />
          ) : (
            <>
              {myOpen.length === 0 ? (
                <CardBody>
                  <p className="text-[13px] text-fg-muted">You have no open tasks.</p>
                </CardBody>
              ) : (
                <TaskRows tasks={myOpen} />
              )}
              {myDone.length > 0 && (
                <>
                  <p className="border-t border-border bg-surface-muted px-5 py-2 text-xs font-medium text-fg-muted">Finished</p>
                  <TaskRows tasks={myDone} />
                </>
              )}
            </>
          )}
        </Card>
      )}

      {isHr && choices && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>All tasks</CardTitle>
              <CardDescription>Everyone&rsquo;s tasks in your organisation, nearest deadline first.</CardDescription>
            </div>
          </CardHeader>
          <CardBody className="border-b border-border">
            <form method="get" action="/tasks" className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="f-status">Status</Label>
                <Select id="f-status" name="status" defaultValue={status}>
                  {STATUS_FILTERS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="f-owner">Person</Label>
                <Select id="f-owner" name="owner" defaultValue={owner}>
                  <option value="">Everyone</option>
                  {choices.employees.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="f-outlet">Outlet</Label>
                <Select id="f-outlet" name="outlet" defaultValue={outlet}>
                  <option value="">All outlets</option>
                  {choices.outlets.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" variant="secondary">
                Show tasks
              </Button>
              {filtered && (
                <Link href="/tasks" className="py-2 text-[13px] text-accent-fg hover:underline">
                  Clear filters
                </Link>
              )}
            </form>
          </CardBody>
          {all.length === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title={filtered ? "No tasks match" : "No open tasks"}
              description={filtered ? "Change or clear the filters to see more." : "Use New task to give someone work. Their proof and your review are kept here."}
            />
          ) : (
            <TaskRows tasks={all} showOwner />
          )}
        </Card>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading tasks">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-48" />
      <Skeleton className="h-64" />
    </div>
  );
}
