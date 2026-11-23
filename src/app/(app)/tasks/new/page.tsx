import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/recruitment/job-bits";
import { loadTaskChoices } from "@/components/tasks/task-bits";
import { NewTaskForm } from "@/components/tasks/task-forms";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { localDay } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";

export const metadata: Metadata = { title: "New task · HRMS" };

export default function NewTaskPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NewTaskContent />
    </Suspense>
  );
}

async function NewTaskContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Ftasks%2Fnew&reason=expired");
  if (!auth.permissions.has("task:manage")) {
    return (
      <div className="space-y-6">
        <PageHeader title="New task" />
        <NoAccess what="assign tasks" />
      </div>
    );
  }

  const rt = getAuthRuntime();
  const today = localDay(new Date(), await attendanceTimezone(rt.db, auth));
  const { employees, outlets, canListEmployees } = await loadTaskChoices(auth);

  return (
    <div className="space-y-6">
      <Link href="/tasks" className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        Tasks
      </Link>
      <PageHeader title="New task" description="Give one employee a piece of work at one outlet." />

      {!canListEmployees && <Alert tone="warning">You need access to the employee list to choose who gets the task. Ask an administrator.</Alert>}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Task details</CardTitle>
            <CardDescription>Only employees with an active login can be given a task. The employee is told when you assign it.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          <NewTaskForm employees={employees} outlets={outlets} today={today} />
        </CardBody>
      </Card>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading form">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-96" />
    </div>
  );
}
