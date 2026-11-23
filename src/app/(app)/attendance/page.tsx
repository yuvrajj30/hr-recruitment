import { Clock, UserX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AttendanceNav, dayTimeRange, FlagBadges, RecordStatusBadge, Th, timeRange } from "@/components/attendance/attendance-bits";
import { ClockButtons } from "@/components/attendance/clock-card";
import { CorrectionRequestForm, WithdrawButton } from "@/components/attendance/request-forms";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone, getMyAttendance } from "@/lib/attendance/attendance";
import { formatMinutes, localDay, localTime, REQUEST_STATUS_LABELS } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { formatDate } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Attendance · HRMS" };

export default function AttendancePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AttendanceContent />
    </Suspense>
  );
}

async function AttendanceContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fattendance&reason=expired");
  const isHr = auth.permissions.has("attendance:read");
  if (!auth.permissions.has("self:attendance_read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Attendance" />
        {isHr && <AttendanceNav canSelf={false} />}
        <NoAccess what="view your attendance" />
      </div>
    );
  }

  const rt = getAuthRuntime();
  const now = new Date();
  const [me, tz] = await Promise.all([getMyAttendance(rt.db, auth, now), attendanceTimezone(rt.db, auth)]);
  const mode = !me.open ? "out" : me.open.onBreak ? "break" : "in";
  const nextShift = me.upcoming[0] ?? null;
  const status = !me.open ? "Not clocked in" : me.open.onBreak ? "On break" : `Clocked in since ${localTime(me.open.clockInAt, tz)}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Attendance" description="Clock in and out, and see your hours." />
      {isHr && <AttendanceNav canSelf={false} />}

      {!me.linked ? (
        <Card>
          <EmptyState icon={UserX} title="Not linked yet" description="Your account is not linked to an employee record yet. Ask HR to link it." />
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Clock</CardTitle>
                <CardDescription>Today in your organisation’s time zone ({tz}).</CardDescription>
              </div>
              <Clock className="size-5 text-fg-subtle" aria-hidden />
            </CardHeader>
            <CardBody className="space-y-4">
              <p className="text-xl font-semibold text-fg">{status}</p>
              {me.open?.abandoned && (
                <Alert tone="warning">
                  You clocked in on {formatDate(me.open.clockInAt, tz)} at {localTime(me.open.clockInAt, tz)} and never clocked out. Clock out to close it. It will be marked as missing its clock-out, and you can then ask for a correction below.
                </Alert>
              )}
              {nextShift && (
                <p className="text-[13px] text-fg-muted">
                  {me.open ? "Planned shift" : "Next shift"}: {dayTimeRange(nextShift.startsAt, nextShift.endsAt, tz)} at {nextShift.outlet}
                </p>
              )}
              {me.canClock ? <ClockButtons mode={mode} /> : <p className="text-[13px] text-fg-muted">Your role cannot clock in or out.</p>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Upcoming shifts</CardTitle>
            </CardHeader>
            <CardBody>
              {me.upcoming.length === 0 ? (
                <p className="text-[13px] text-fg-muted">No shifts planned for you.</p>
              ) : (
                <ul className="divide-y divide-border text-[13px]">
                  {me.upcoming.map((s) => (
                    <li key={s.id} className="flex flex-wrap justify-between gap-2 py-2">
                      <span className="font-medium text-fg">{dayTimeRange(s.startsAt, s.endsAt, tz)}</span>
                      <span className="text-fg-muted">
                        {s.outlet}
                        {s.breakMinutes > 0 ? ` · ${s.breakMinutes} min break` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>History</CardTitle>
                <CardDescription>The last 31 days.</CardDescription>
              </div>
            </CardHeader>
            {me.history.length === 0 ? (
              <CardBody>
                <p className="text-[13px] text-fg-muted">Nothing recorded yet.</p>
              </CardBody>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-[13px]">
                  <thead className="border-b border-border text-xs text-fg-muted">
                    <tr>
                      <Th className="px-5">Date</Th>
                      <Th>In</Th>
                      <Th>Out</Th>
                      <Th>Worked</Th>
                      <Th>Outlet</Th>
                      <Th>Status</Th>
                      <Th className="px-5">Flags</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {me.history.map((r) => (
                      <tr key={r.id} className="hover:bg-surface-muted/60">
                        <td className="px-5 py-2.5 whitespace-nowrap">
                          <Link href={`/attendance/records/${r.id}`} className="font-medium text-accent-fg hover:underline">
                            {formatDate(r.clockInAt, tz)}
                          </Link>
                        </td>
                        <td className="px-3 py-2.5 tabular">{localTime(r.clockInAt, tz)}</td>
                        <td className="px-3 py-2.5 tabular">{r.clockOutAt ? localTime(r.clockOutAt, tz) : "—"}</td>
                        <td className="px-3 py-2.5 tabular">{formatMinutes(r.worked)}</td>
                        <td className="px-3 py-2.5 text-fg-muted">{r.outlet ?? "—"}</td>
                        <td className="px-3 py-2.5">
                          <RecordStatusBadge status={r.status} />
                        </td>
                        <td className="px-5 py-2.5">
                          <FlagBadges flags={r.flags} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {me.canClock && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Forgot to clock in?</CardTitle>
                  <CardDescription>Tell HR when you worked. They will check it and approve or reject it.</CardDescription>
                </div>
              </CardHeader>
              <CardBody>
                <CorrectionRequestForm defaults={{ day: localDay(now, tz), start: "", end: "", breakMinutes: "" }} />
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>My requests</CardTitle>
            </CardHeader>
            {me.requests.length === 0 ? (
              <CardBody>
                <p className="text-[13px] text-fg-muted">You have not asked for any corrections.</p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-border">
                {me.requests.map((q) => (
                  <li key={q.id} className="space-y-1.5 px-5 py-3 text-[13px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-fg">{dayTimeRange(q.proposedClockInAt, q.proposedClockOutAt, tz)}</span>
                      <Badge tone={q.status === "PENDING" ? "warning" : q.status === "APPROVED" ? "success" : "neutral"}>{REQUEST_STATUS_LABELS[q.status]}</Badge>
                    </div>
                    <p className="text-fg-muted">
                      {q.proposedBreakMinutes !== null ? `Break ${q.proposedBreakMinutes} min · ` : ""}
                      {q.reason}
                    </p>
                    {q.decisionNote && <p className="text-fg-muted">HR note: {q.decisionNote}</p>}
                    {q.recordId && (
                      <Link href={`/attendance/records/${q.recordId}`} className="text-accent-fg hover:underline">
                        View the record ({timeRange(q.current?.clockInAt ?? q.proposedClockInAt, q.current?.clockOutAt ?? null, tz)})
                      </Link>
                    )}
                    {q.status === "PENDING" && me.canClock && <WithdrawButton requestId={q.id} />}
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
    <div className="space-y-6" aria-busy="true" aria-label="Loading attendance">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-56" />
      <Skeleton className="h-64" />
    </div>
  );
}
