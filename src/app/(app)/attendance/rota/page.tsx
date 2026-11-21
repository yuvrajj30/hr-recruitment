import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AttendanceNav, dayTimeRange, timeRange } from "@/components/attendance/attendance-bits";
import { CancelShiftForm, CopyWeekForm, ShiftForm } from "@/components/attendance/rota-forms";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone, getRota, type ShiftView } from "@/lib/attendance/attendance";
import { addDays, dayRange, dayStart, isDay, localDay, localTime, weekStart } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { formatDate } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Rota · HRMS" };

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, key: string): string => (typeof q[key] === "string" ? (q[key] as string) : "");

export default function RotaPage(props: PageProps<"/attendance/rota">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RotaContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function RotaContent({ searchParams }: { searchParams: Promise<Query> }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fattendance%2Frota&reason=expired");
  if (!auth.permissions.has("attendance:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Rota" />
        <NoAccess what="view the rota" />
      </div>
    );
  }
  const q = await searchParams;
  const canManage = auth.permissions.has("attendance:manage");
  const rt = getAuthRuntime();
  const now = new Date();
  const tz = await attendanceTimezone(rt.db, auth);
  const rawWeek = one(q, "week");
  const week = weekStart(isDay(rawWeek) ? rawWeek : localDay(now, tz));
  const outlet = one(q, "outlet");
  const range = { start: dayStart(week, tz), end: dayStart(addDays(week, 7), tz) };
  const rota = await getRota(rt.db, auth, range, outlet || null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const link = (w: string) => `/attendance/rota?week=${w}${outlet ? `&outlet=${encodeURIComponent(outlet)}` : ""}`;

  const byEmployee = new Map<string, ShiftView[]>();
  for (const s of rota.shifts) byEmployee.set(s.employeeId, [...(byEmployee.get(s.employeeId) ?? []), s]);
  const people = new Map<string, { id: string; name: string; code: string }>();
  for (const s of rota.shifts) people.set(s.employeeId, { id: s.employeeId, name: s.employeeName, code: s.employeeCode });
  if (canManage) for (const e of rota.employees) people.set(e.id, { id: e.id, name: e.fullName, code: e.employeeCode });
  const rows = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  const editable = rota.shifts.filter((s) => s.status === "PLANNED" && s.startsAt.getTime() > now.getTime());
  const employeeChoices = rota.employees.map((e) => ({ id: e.id, label: `${e.fullName} (${e.employeeCode})` }));
  const weekLabel = `${formatDate(range.start, tz)} – ${formatDate(dayRange(addDays(week, 6), tz).start, tz)}`;
  const emptyDefaults = { day: localDay(now, tz), start: "", end: "", breakMinutes: "", note: "", outletId: outlet };

  return (
    <div className="space-y-6">
      <PageHeader title="Rota" description={`Week of ${weekLabel}`} />
      <AttendanceNav active="rota" canSelf={auth.permissions.has("self:attendance_read")} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" asChild>
            <Link href={link(addDays(week, -7))}>
              <ChevronLeft aria-hidden />
              Previous week
            </Link>
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <Link href={link(addDays(week, 7))}>
              Next week
              <ChevronRight aria-hidden />
            </Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href={link(weekStart(localDay(now, tz)))}>This week</Link>
          </Button>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/attendance/standards">Standard shifts</Link>
        </Button>
        <form method="get" className="flex items-end gap-2" aria-label="Filter by outlet">
          <input type="hidden" name="week" value={week} />
          <div className="space-y-1">
            <label htmlFor="rota-outlet" className="block text-xs text-fg-muted">Outlet</label>
            <Select id="rota-outlet" name="outlet" defaultValue={outlet} className="w-44">
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

      <Card>
        {rows.length === 0 ? (
          <EmptyState icon={CalendarDays} title="No shifts this week" description="Planned shifts appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] table-fixed text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="w-40 px-5 py-2.5 font-medium">Employee</th>
                  {days.map((d) => (
                    <th key={d} scope="col" className="px-2 py-2.5 font-medium">
                      {formatDate(dayStart(d, tz), tz).replace(/ \d{4}$/, "")}
                      <span className="block font-normal text-fg-subtle">{new Intl.DateTimeFormat("en-IN", { timeZone: tz, weekday: "short" }).format(dayStart(d, tz))}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border align-top">
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="px-5 py-2.5">
                      <span className="font-medium text-fg">{p.name}</span>
                      <span className="block text-xs text-fg-muted">{p.code}</span>
                    </td>
                    {days.map((d) => (
                      <td key={d} className="space-y-1 px-2 py-2.5">
                        {(byEmployee.get(p.id) ?? [])
                          .filter((s) => localDay(s.startsAt, tz) === d)
                          .map((s) => (
                            <div
                              key={s.id}
                              title={s.status === "CANCELLED" ? `Cancelled: ${s.cancelReason ?? ""}` : (s.note ?? undefined)}
                              className={`rounded-md border border-border px-2 py-1 ${s.status === "CANCELLED" ? "text-fg-muted line-through" : "bg-accent-soft text-fg"}`}
                            >
                              <Link href={`/attendance/shifts/${s.id}`} className="tabular font-medium hover:underline">{timeRange(s.startsAt, s.endsAt, tz)}</Link>
              {s.source === "STANDARD" && <Badge tone={s.edited ? "warning" : "neutral"} className="ml-1.5">{s.edited ? "Changed" : "Standard"}</Badge>}
                              <span className="block text-xs text-fg-muted">{s.outlet}</span>
                            </div>
                          ))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {canManage && (
        <>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Add shift</CardTitle>
                <CardDescription>Shifts can only be planned for the future.</CardDescription>
              </div>
            </CardHeader>
            <CardBody className="space-y-4">
              <ShiftForm employees={employeeChoices} outlets={rota.outlets} defaults={emptyDefaults} />
              <div className="border-t border-border pt-4">
                <CopyWeekForm week={week} outletId={outlet} />
              </div>
            </CardBody>
          </Card>

          {editable.length > 0 && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Change or cancel shifts</CardTitle>
                  <CardDescription>Shifts that have not started yet.</CardDescription>
                </div>
              </CardHeader>
              <ul className="divide-y divide-border">
                {editable.map((s) => (
                  <li key={s.id} className="px-5 py-3 text-[13px]">
                    <details>
                      <summary className="cursor-pointer font-medium text-fg">
                        {s.employeeName} <span className="font-normal text-fg-muted">{dayTimeRange(s.startsAt, s.endsAt, tz)} · {s.outlet}</span>
                      </summary>
                      <div className="mt-3 grid gap-6 lg:grid-cols-2">
                        <ShiftForm
                          outlets={rota.outlets}
                          shift={{ id: s.id, employeeId: s.employeeId }}
                          defaults={{
                            day: localDay(s.startsAt, tz),
                            start: localTime(s.startsAt, tz),
                            end: localTime(s.endsAt, tz),
                            breakMinutes: String(s.breakMinutes),
                            note: s.note ?? "",
                            outletId: s.outletId,
                          }}
                        />
                        <CancelShiftForm shiftId={s.id} />
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading rota">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-10 w-full max-w-xl" />
      <Skeleton className="h-96" />
    </div>
  );
}
