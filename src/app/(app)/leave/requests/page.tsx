import { Inbox } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Th } from "@/components/attendance/attendance-bits";
import { LeaveNav, LeaveStatusBadge, leaveRange } from "@/components/leave/leave-bits";
import { DecideLeaveControls, LeaveRequestForm } from "@/components/leave/leave-forms";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { localDay } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { listEmployees } from "@/lib/employees/employees";
import { listLeaveRequests, listLeaveTypes } from "@/lib/leave/leave";
import { formatDays } from "@/lib/leave/rules";
import { formatDateTime } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Leave requests · HRMS" };

export default function LeaveRequestsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RequestsContent />
    </Suspense>
  );
}

async function RequestsContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fleave%2Frequests&reason=expired");
  if (!auth.permissions.has("leave:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Leave requests" />
        <NoAccess what="review leave requests" />
      </div>
    );
  }
  const canApprove = auth.permissions.has("leave:approve");
  const rt = getAuthRuntime();
  const [tz, pending, decided, types, employees] = await Promise.all([
    attendanceTimezone(rt.db, auth),
    listLeaveRequests(rt.db, auth, "PENDING"),
    listLeaveRequests(rt.db, auth, "DECIDED"),
    canApprove ? listLeaveTypes(rt.db, auth) : Promise.resolve([]),
    canApprove && auth.permissions.has("employee:read") ? listEmployees(rt.db, auth) : Promise.resolve([]),
  ]);
  const today = localDay(new Date(), tz);

  return (
    <div className="space-y-6">
      <PageHeader title="Leave requests" description="Employees asking for leave, and what has been decided." />
      <LeaveNav active="requests" canSelf={auth.permissions.has("self:leave_read")} />

      <Card>
        <CardHeader>
          <CardTitle>Waiting for a decision ({pending.length})</CardTitle>
        </CardHeader>
        {pending.length === 0 ? (
          <EmptyState icon={Inbox} title="Nothing waiting" description="New leave requests from employees appear here." />
        ) : (
          <ul className="divide-y divide-border">
            {pending.map((q) => (
              <li key={q.id} className="grid gap-4 px-5 py-4 text-[13px] lg:grid-cols-[1fr_20rem]">
                <div className="space-y-1.5">
                  <p className="font-medium text-fg">
                    <Link href={`/leave/employees/${q.employeeId}`} className="text-accent-fg hover:underline">
                      {q.employeeName}
                    </Link>{" "}
                    <span className="font-normal text-fg-muted">{q.employeeCode}</span>
                  </p>
                  <p className="text-fg">
                    {q.typeName}: {leaveRange(q.start, q.end, q.startHalf, q.endHalf)}, <span className="tabular">{formatDays(q.days)}</span>
                  </p>
                  {q.currentDays !== null && q.currentDays !== q.days && (
                    <Alert tone="warning">
                      Recounted today: {formatDays(q.currentDays)} (holidays or working days changed). Approving takes the recount.
                    </Alert>
                  )}
                  {q.paid && q.available !== null && q.availableAfter !== null && (
                    <p className={q.availableAfter < 0 ? "text-danger" : "text-fg-muted"}>
                      Available now: {formatDays(q.available)}. After approving: {formatDays(q.availableAfter)}.
                      {q.availableAfter < 0 ? " Not enough leave left." : ""}
                    </p>
                  )}
                  {q.note && <p className="text-fg-muted">Note: {q.note}</p>}
                  <p className="text-xs text-fg-subtle">
                    Asked on {formatDateTime(q.createdAt, tz)}.{" "}
                    <Link href={`/leave/requests/${q.id}`} className="text-accent-fg hover:underline">
                      Open the request
                    </Link>
                  </p>
                </div>
                {canApprove && <DecideLeaveControls requestId={q.id} />}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canApprove && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Record paper leave</CardTitle>
              <CardDescription>Enter leave that was agreed on paper, or for someone without a login. It is saved as approved.</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <LeaveRequestForm
              types={types.filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name, paid: t.paid, configured: t.configured, noteRequired: t.noteRequired }))}
              defaultDay={today}
              employees={employees.map((e) => ({ id: e.id, label: `${e.fullName} (${e.employeeCode})` }))}
            />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Decided</CardTitle>
        </CardHeader>
        {decided.length === 0 ? (
          <EmptyState icon={Inbox} title="Nothing decided yet" description="Approved, rejected, withdrawn and cancelled requests are listed here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <Th className="px-5">Employee</Th>
                  <Th>Type</Th>
                  <Th>Dates</Th>
                  <Th>Days</Th>
                  <Th>Status</Th>
                  <Th className="px-5">Decided</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border align-top">
                {decided.map((q) => (
                  <tr key={q.id} className="hover:bg-surface-muted/60">
                    <td className="px-5 py-2.5">
                      <Link href={`/leave/requests/${q.id}`} className="font-medium text-accent-fg hover:underline">
                        {q.employeeName}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-fg-muted">{q.typeName}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{leaveRange(q.start, q.end, q.startHalf, q.endHalf)}</td>
                    <td className="px-3 py-2.5 tabular">{formatDays(q.days)}</td>
                    <td className="px-3 py-2.5">
                      <span className="flex flex-wrap items-center gap-1">
                        <LeaveStatusBadge status={q.status} />
                        {q.selfDecided && <Badge tone="warning">Decided by themselves (only approver)</Badge>}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-fg-muted">{q.decidedAt ? formatDateTime(q.decidedAt, tz) : q.cancelledAt ? formatDateTime(q.cancelledAt, tz) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading leave requests">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-64" />
      <Skeleton className="h-64" />
    </div>
  );
}
