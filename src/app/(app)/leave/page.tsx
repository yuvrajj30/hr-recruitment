import { UserX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { BalanceTile, NoteTile } from "@/components/leave/balance-tiles";
import { dayLabel, LeaveNav, LeaveStatusBadge, leaveRange } from "@/components/leave/leave-bits";
import { LeaveRequestForm, WithdrawLeaveButton } from "@/components/leave/leave-forms";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { localDay } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { getMyLeave } from "@/lib/leave/leave";
import { formatDays } from "@/lib/leave/rules";

export const metadata: Metadata = { title: "Leave · HRMS" };

export default function LeavePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <LeaveContent />
    </Suspense>
  );
}

async function LeaveContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fleave&reason=expired");
  const isHr = auth.permissions.has("leave:read");
  if (!auth.permissions.has("self:leave_read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Leave" />
        {isHr && <LeaveNav canSelf={false} />}
        <NoAccess what="view your leave" />
      </div>
    );
  }

  const rt = getAuthRuntime();
  const tz = await attendanceTimezone(rt.db, auth);
  const today = localDay(new Date(), tz);
  const me = await getMyLeave(rt.db, auth, today);
  const year = Number(today.slice(0, 4));
  const typeName = (code: string) => me.types.find((t) => t.code === code)?.name ?? code;
  const choices = me.types
    .filter((t) => t.isActive)
    .map((t) => ({ id: t.id, name: t.name, paid: t.paid, configured: t.configured, noteRequired: t.noteRequired }));
  const nextYearHasLines = me.balances.some((b) => b.year > year && (b.credited !== 0 || b.taken !== 0 || b.pending !== 0));
  const paidBalances = me.balances.filter((b) => b.paid && b.available !== null && (b.year === year || nextYearHasLines));
  const unpaidTypes = me.types.filter((t) => t.isActive && !t.paid);
  const missing = me.types.filter((t) => t.isActive && t.paid && !t.configured);
  const showYear = paidBalances.some((b) => b.year !== year);

  return (
    <div className="space-y-6">
      <PageHeader title="Leave" description="Your balances, requests and the holidays ahead." />
      {isHr && <LeaveNav canSelf />}

      {!me.linked ? (
        <Card>
          <EmptyState icon={UserX} title="Not linked yet" description="Your account is not linked to an employee record yet. Ask HR to link it." />
        </Card>
      ) : (
        <>
          {me.notConfigured.length > 0 && (
            <Alert tone="warning">
              HR has not set up these leave types yet: {me.notConfigured.map(typeName).join(", ")}. You can still ask for unpaid leave.
            </Alert>
          )}

          <section aria-label="Balances" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {paidBalances
              .filter((b) => me.types.find((t) => t.id === b.typeId)?.configured)
              .map((b) => (
                <BalanceTile key={`${b.typeId}-${b.year}`} b={{ ...b, available: b.available ?? 0 }} showYear={showYear} />
              ))}
            {unpaidTypes.map((t) => (
              <NoteTile key={t.id} title={t.name} text="Unpaid leave: no balance needed." />
            ))}
            {missing.map((t) => (
              <NoteTile key={t.id} title={t.name} text="Not set up yet." muted />
            ))}
          </section>

          {me.canApply && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Ask for leave</CardTitle>
                  <CardDescription>HR will approve or reject it. You will see the answer here.</CardDescription>
                </div>
              </CardHeader>
              <CardBody>
                <LeaveRequestForm types={choices} defaultDay={today} hasStandard={me.hasStandard} />
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>My requests</CardTitle>
            </CardHeader>
            {me.requests.length === 0 ? (
              <CardBody>
                <p className="text-[13px] text-fg-muted">You have not asked for any leave.</p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-border">
                {me.requests.map((q) => (
                  <li key={q.id} className="space-y-1.5 px-5 py-3 text-[13px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-fg">
                        <Link href={`/leave/requests/${q.id}`} className="hover:underline">
                          {leaveRange(q.start, q.end, q.startHalf, q.endHalf)}
                        </Link>
                      </span>
                      <LeaveStatusBadge status={q.status} />
                    </div>
                    <p className="text-fg-muted">
                      <span className="text-fg">{q.typeName}</span>, <span className="tabular">{formatDays(q.days)}</span>
                      {q.note ? `. ${q.note}` : ""}
                    </p>
                    {q.decisionNote && <p className="text-fg-muted">HR note: {q.decisionNote}</p>}
                    {q.status === "PENDING" && me.canApply && <WithdrawLeaveButton requestId={q.id} />}
                    {q.status === "APPROVED" && q.start > today && me.canApply && (
                      <Link href={`/leave/requests/${q.id}`} className="text-accent-fg hover:underline">
                        Cancel…
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Upcoming holidays</CardTitle>
            </CardHeader>
            {me.holidays.length === 0 ? (
              <CardBody>
                <p className="text-[13px] text-fg-muted">No holidays are set for the coming year.</p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-border text-[13px]">
                {me.holidays.map((h) => (
                  <li key={h.id} className="flex flex-wrap justify-between gap-2 px-5 py-2.5">
                    <span className="font-medium text-fg">
                      {dayLabel(h.day)} <span className="font-normal text-fg-muted">{h.name}</span>
                    </span>
                    <span className="text-fg-muted">{h.outlet ?? "All outlets"}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading leave">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32" />
      <Skeleton className="h-56" />
    </div>
  );
}
