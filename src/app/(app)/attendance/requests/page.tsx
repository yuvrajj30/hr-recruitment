import { Inbox } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AttendanceNav, dayTimeRange } from "@/components/attendance/attendance-bits";
import { DecideControls } from "@/components/attendance/request-forms";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone, listRequests } from "@/lib/attendance/attendance";
import { REQUEST_STATUS_LABELS } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { formatDateTime } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Correction requests · HRMS" };

export default function RequestsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RequestsContent />
    </Suspense>
  );
}

async function RequestsContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fattendance%2Frequests&reason=expired");
  if (!auth.permissions.has("attendance:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Correction requests" />
        <NoAccess what="review attendance requests" />
      </div>
    );
  }
  const canManage = auth.permissions.has("attendance:manage");
  const rt = getAuthRuntime();
  const [tz, pending, decided] = await Promise.all([
    attendanceTimezone(rt.db, auth),
    listRequests(rt.db, auth, "PENDING"),
    listRequests(rt.db, auth, "DECIDED"),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Correction requests" description="Employees asking HR to correct or add attendance." />
      <AttendanceNav active="requests" canSelf={auth.permissions.has("self:attendance_read")} />

      <Card>
        <CardHeader>
          <CardTitle>Waiting for a decision ({pending.length})</CardTitle>
        </CardHeader>
        {pending.length === 0 ? (
          <EmptyState icon={Inbox} title="Nothing waiting" description="New requests from employees appear here." />
        ) : (
          <ul className="divide-y divide-border">
            {pending.map((q) => (
              <li key={q.id} className="grid gap-4 px-5 py-4 text-[13px] lg:grid-cols-[1fr_20rem]">
                <div className="space-y-1.5">
                  <p className="font-medium text-fg">
                    {q.employeeName} <span className="font-normal text-fg-muted">{q.employeeCode}</span>
                  </p>
                  <p className="text-fg-muted">
                    {q.current ? `Now: ${dayTimeRange(q.current.clockInAt, q.current.clockOutAt, tz)}` : "Time not clocked (new period)"}
                  </p>
                  <p className="text-fg">
                    Proposed: {dayTimeRange(q.proposedClockInAt, q.proposedClockOutAt, tz)}
                    {q.proposedBreakMinutes !== null ? ` · break ${q.proposedBreakMinutes} min` : ""}
                  </p>
                  <p className="text-fg-muted">Reason: {q.reason}</p>
                  <p className="text-xs text-fg-subtle">Asked on {formatDateTime(q.createdAt, tz)}</p>
                  {q.recordId && (
                    <Link href={`/attendance/records/${q.recordId}`} className="text-accent-fg hover:underline">
                      Open the record
                    </Link>
                  )}
                </div>
                {canManage && <DecideControls requestId={q.id} />}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Decided</CardTitle>
        </CardHeader>
        {decided.length === 0 ? (
          <EmptyState icon={Inbox} title="Nothing decided yet" description="Approved, rejected and withdrawn requests are listed here." />
        ) : (
          <ul className="divide-y divide-border">
            {decided.map((q) => (
              <li key={q.id} className="space-y-1 px-5 py-3 text-[13px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-fg">
                    {q.employeeName} <span className="font-normal text-fg-muted">{dayTimeRange(q.proposedClockInAt, q.proposedClockOutAt, tz)}</span>
                  </span>
                  <Badge tone={q.status === "APPROVED" ? "success" : "neutral"}>{REQUEST_STATUS_LABELS[q.status]}</Badge>
                </div>
                <p className="text-fg-muted">
                  {q.reason}
                  {q.decisionNote ? ` · Note: ${q.decisionNote}` : ""}
                  {q.decidedAt ? ` · ${formatDateTime(q.decidedAt, tz)}` : ""}
                </p>
                {q.recordId && (
                  <Link href={`/attendance/records/${q.recordId}`} className="text-accent-fg hover:underline">
                    Open the record
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading requests">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-64" />
      <Skeleton className="h-64" />
    </div>
  );
}
