import { FileQuestion } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Detail } from "@/components/attendance/attendance-bits";
import { LeaveNav, LeaveStatusBadge, leaveRange } from "@/components/leave/leave-bits";
import { CancelLeaveForm, DecideLeaveControls } from "@/components/leave/leave-forms";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { localDay, localTime } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { getLeaveRequest, type LeaveRequestDetail } from "@/lib/leave/leave";
import { formatDays } from "@/lib/leave/rules";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { formatDate, formatDateTime } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Leave request · HRMS" };

export default function LeaveRequestPage(props: PageProps<"/leave/requests/[requestId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RequestContent params={props.params} />
    </Suspense>
  );
}

async function RequestContent({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/leave/requests/${requestId}`)}&reason=expired`);
  const isHr = auth.permissions.has("leave:read");
  if (!isHr && !auth.permissions.has("self:leave_read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Leave request" />
        <NoAccess what="view leave requests" />
      </div>
    );
  }

  const rt = getAuthRuntime();
  let q: LeaveRequestDetail;
  try {
    q = await getLeaveRequest(rt.db, auth, requestId);
  } catch (error) {
    if (!(error instanceof RecruitmentError) || error.code !== "not_found") throw error;
    return (
      <div className="space-y-6">
        <PageHeader title="Leave request" />
        <Card>
          <EmptyState
            icon={FileQuestion}
            title="Request not found"
            description="It may have been removed, or it belongs to someone else."
            action={
              <Link href={isHr ? "/leave/requests" : "/leave"} className="text-[13px] text-accent-fg hover:underline">
                Back to leave
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const tz = await attendanceTimezone(rt.db, auth);
  const today = localDay(new Date(), tz);
  const canApprove = auth.permissions.has("leave:approve");
  const canCancel = q.status === "APPROVED" && (canApprove || (!isHr && auth.permissions.has("self:leave_apply") && q.start > today));
  const handPlanned = q.cancelledShifts.filter((s) => !s.comesBack);
  const automatic = q.cancelledShifts.filter((s) => s.comesBack);
  const when = (s: Date) => `${formatDate(s, tz)} ${localTime(s, tz)}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Leave request" description={`${q.employeeName}, ${q.typeName}`} />
      {isHr && <LeaveNav canSelf={auth.permissions.has("self:leave_read")} />}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <span className="flex flex-wrap items-center gap-1.5">
            <LeaveStatusBadge status={q.status} />
            {q.selfDecided && <Badge tone="warning">Decided by themselves (only approver)</Badge>}
          </span>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-4 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="Employee">
              {isHr ? (
                <Link href={`/leave/employees/${q.employeeId}`} className="text-accent-fg hover:underline">
                  {q.employeeName}
                </Link>
              ) : (
                q.employeeName
              )}{" "}
              <span className="font-normal text-fg-muted">{q.employeeCode}</span>
            </Detail>
            <Detail label="Leave type">{q.typeName}</Detail>
            <Detail label="Dates">{leaveRange(q.start, q.end, q.startHalf, q.endHalf)}</Detail>
            <Detail label="Days counted">{formatDays(q.days)}</Detail>
            <Detail label="Asked on">{formatDateTime(q.createdAt, tz)}</Detail>
            {q.decidedAt && <Detail label="Decided on">{formatDateTime(q.decidedAt, tz)}</Detail>}
            {q.cancelledAt && <Detail label="Cancelled on">{formatDateTime(q.cancelledAt, tz)}</Detail>}
            {q.note && <Detail label="Note">{q.note}</Detail>}
            {q.decisionNote && <Detail label="HR note">{q.decisionNote}</Detail>}
            {q.cancelReason && <Detail label="Reason for cancelling">{q.cancelReason}</Detail>}
          </dl>
        </CardBody>
      </Card>

      {q.status === "PENDING" && isHr && q.preview && (
        <Card>
          <CardHeader>
            <CardTitle>Decision</CardTitle>
          </CardHeader>
          <CardBody className="grid gap-4 text-[13px] lg:grid-cols-[1fr_20rem]">
            <div className="space-y-2">
              {q.preview.currentDays !== q.days && (
                <Alert tone="warning">
                  Recounted today: {formatDays(q.preview.currentDays)} (holidays or working days changed). Approving takes the recount.
                </Alert>
              )}
              {q.paid && q.preview.available !== null && q.preview.availableAfter !== null && (
                <p className={q.preview.availableAfter < 0 ? "text-danger" : "text-fg-muted"}>
                  Available now: {formatDays(q.preview.available)}. After approving: {formatDays(q.preview.availableAfter)}.
                  {q.preview.availableAfter < 0 ? " Not enough leave left." : ""}
                </p>
              )}
            </div>
            {canApprove && <DecideLeaveControls requestId={q.id} />}
          </CardBody>
        </Card>
      )}

      {canCancel && (
        <Card>
          <CardHeader>
            <CardTitle>Cancel this leave</CardTitle>
          </CardHeader>
          <CardBody className="max-w-xl">
            <CancelLeaveForm requestId={q.id}>
              <div className="space-y-2">
                {handPlanned.length > 0 && (
                  <Alert tone="warning">
                    These shifts were planned by hand and will not come back by themselves if you cancel: {handPlanned.map((s) => `${when(s.startsAt)} at ${s.outlet}`).join(", ")}. Plan them again on the rota if needed.
                  </Alert>
                )}
                {automatic.length > 0 && <p className="text-[13px] text-fg-muted">Standard shifts on these days come back automatically.</p>}
              </div>
            </CancelLeaveForm>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading leave request">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-48" />
    </div>
  );
}
