import { ChevronLeft, ChevronRight, ClipboardList } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AttendanceNav, FlagBadges, RecordStatusBadge, Th, timeRange } from "@/components/attendance/attendance-bits";
import { ConfirmShiftButton, RecordTimeForm } from "@/components/attendance/hr-forms";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone, getDay, getRota } from "@/lib/attendance/attendance";
import { addDays, dayRange, formatMinutes, isDay, localDay, localTime } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { formatDate } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Attendance review · HRMS" };

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, key: string): string => (typeof q[key] === "string" ? (q[key] as string) : "");

export default function ReviewPage(props: PageProps<"/attendance/review">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReviewContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function ReviewContent({ searchParams }: { searchParams: Promise<Query> }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fattendance%2Freview&reason=expired");
  const canSelf = auth.permissions.has("self:attendance_read");
  if (!auth.permissions.has("attendance:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Attendance review" />
        <NoAccess what="review attendance" />
      </div>
    );
  }

  const q = await searchParams;
  const canManage = auth.permissions.has("attendance:manage");
  const rt = getAuthRuntime();
  const now = new Date();
  const tz = await attendanceTimezone(rt.db, auth);
  const today = localDay(now, tz);
  const rawDay = one(q, "day");
  const day = isDay(rawDay) ? rawDay : today;
  const outlet = one(q, "outlet");
  const [view, rota] = await Promise.all([getDay(rt.db, auth, day, tz, now, outlet || null), getRota(rt.db, auth, dayRange(day, tz), null)]);
  const link = (d: string) => `/attendance/review?day=${d}${outlet ? `&outlet=${encodeURIComponent(outlet)}` : ""}`;
  const dayLabel = formatDate(dayRange(day, tz).start, tz);
  // A holiday or weekly off inside a longer leave is not a leave day (not charged): say what the day is.
  const leaveBadge = (l: { typeCode: string; half: boolean; dayOff: "holiday" | "weekly_off" | null }) =>
    l.dayOff === "holiday" ? "Holiday" : l.dayOff === "weekly_off" ? "Weekly off" : l.half ? `Half day leave: ${l.typeCode}` : `On leave: ${l.typeCode}`;
  const rowIds = new Set(view.rows.map((r) => r.employeeId));
  const leaveOnly = view.onLeave.filter((l) => !rowIds.has(l.employeeId) && l.dayOff === null);

  return (
    <div className="space-y-6">
      <PageHeader title="Attendance review" description={`${dayLabel}${day === today ? " (today)" : ""}`} />
      <AttendanceNav active="review" canSelf={canSelf} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" asChild>
            <Link href={link(addDays(day, -1))}>
              <ChevronLeft aria-hidden />
              Previous day
            </Link>
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <Link href={link(addDays(day, 1))}>
              Next day
              <ChevronRight aria-hidden />
            </Link>
          </Button>
          {day !== today && (
            <Button variant="ghost" size="sm" asChild>
              <Link href={link(today)}>Today</Link>
            </Button>
          )}
        </div>
        <form method="get" className="flex items-end gap-2" aria-label="Filter by outlet">
          <input type="hidden" name="day" value={day} />
          <div className="space-y-1">
            <label htmlFor="rv-outlet" className="block text-xs text-fg-muted">Outlet</label>
            <Select id="rv-outlet" name="outlet" defaultValue={outlet} className="w-44">
              <option value="">All outlets</option>
              {rota.outlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="secondary">Show</Button>
        </form>
      </div>

      {(view.attention.length > 0 || view.pendingRequests > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {view.pendingRequests > 0 && (
              <Alert tone="info">
                <Link href="/attendance/requests" className="font-medium text-accent-fg hover:underline">
                  {view.pendingRequests} correction {view.pendingRequests === 1 ? "request" : "requests"} waiting
                </Link>
              </Alert>
            )}
            {view.attention.length > 0 && (
              <ul className="divide-y divide-border text-[13px]">
                {view.attention.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium text-fg">{r.employeeName}</span>
                      <span className="ml-2 text-fg-muted">
                        clocked in {formatDate(r.clockInAt, tz)} at {localTime(r.clockInAt, tz)}, no clock-out
                      </span>
                    </span>
                    <Link href={`/attendance/records/${r.id}`} className="text-accent-fg hover:underline">
                      Open record
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Planned and worked</CardTitle>
            <CardDescription>Shifts and attendance that start on this day.</CardDescription>
          </div>
        </CardHeader>
        {view.rows.length === 0 ? (
          <EmptyState icon={ClipboardList} title="Nothing on this day" description="No shifts are planned and nobody clocked in." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <Th className="px-5">Employee</Th>
                  <Th>Planned</Th>
                  <Th className="px-5">Worked</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border align-top">
                {view.rows.map((row) => (
                  <tr key={row.employeeId}>
                    <td className="px-5 py-3">
                      <span className="font-medium text-fg">{row.employeeName}</span>
                      <span className="block text-xs text-fg-muted">{row.employeeCode}</span>
                      {view.onLeave
                        .filter((l) => l.employeeId === row.employeeId)
                        .map((l) => (
                          <Badge key={l.typeCode} tone={l.dayOff ? "neutral" : "accent"} className="mt-1">
                            {leaveBadge(l)}
                          </Badge>
                        ))}
                    </td>
                    <td className="space-y-2 px-3 py-3">
                      {row.shifts.length === 0 && <span className="text-fg-subtle">—</span>}
                      {row.shifts.map((s) => (
                        <div key={s.id} className="space-y-1">
                          <p className={s.status === "CANCELLED" ? "text-fg-muted line-through" : "text-fg"} title={s.cancelReason ?? undefined}>
                            {timeRange(s.startsAt, s.endsAt, tz)} <span className="text-fg-muted">{s.outlet}</span>
                            {s.status === "CANCELLED" && <Badge className="ml-2">Cancelled</Badge>}
                            {s.missed && (
                              <Badge tone="danger" className="ml-2">
                                Missed
                              </Badge>
                            )}
                          </p>
                          {s.missed && canManage && <ConfirmShiftButton shiftId={s.id} />}
                        </div>
                      ))}
                    </td>
                    <td className="space-y-2 px-5 py-3">
                      {row.records.length === 0 && <span className="text-fg-subtle">—</span>}
                      {row.records.map((r) => (
                        <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <Link href={`/attendance/records/${r.id}`} className="font-medium text-accent-fg tabular hover:underline">
                            {timeRange(r.clockInAt, r.clockOutAt, tz)}
                          </Link>
                          <span className="tabular text-fg-muted">{formatMinutes(r.worked)}</span>
                          <RecordStatusBadge status={r.status} />
                          <FlagBadges flags={r.flags} />
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {leaveOnly.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{day === today ? "On leave today" : "On leave on this day"}</CardTitle>
          </CardHeader>
          <ul className="divide-y divide-border text-[13px]">
            {leaveOnly.map((l) => (
              <li key={`${l.employeeId}-${l.typeCode}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                <span className="font-medium text-fg">{l.employeeName}</span>
                <Badge tone="accent">{leaveBadge(l)}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Record time</CardTitle>
              <CardDescription>Add worked time for someone who could not clock in.</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <RecordTimeForm
              employees={rota.employees.map((e) => ({ id: e.id, label: `${e.fullName} (${e.employeeCode})` }))}
              outlets={rota.outlets}
              defaultDay={day > today ? today : day}
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading attendance review">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-10 w-full max-w-xl" />
      <Skeleton className="h-96" />
    </div>
  );
}
