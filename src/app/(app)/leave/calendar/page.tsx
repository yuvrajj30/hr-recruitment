import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { LeaveNav } from "@/components/leave/leave-bits";
import { MonthStrip, type StripPerson, StripLegend } from "@/components/leave/month-strip";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { addDays, localDay } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { getWhoIsOff, listHolidays } from "@/lib/leave/leave";

export const metadata: Metadata = { title: "Who is off · HRMS" };

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, key: string): string => (typeof q[key] === "string" ? (q[key] as string) : "");

const shiftMonth = (ym: string, n: number): string => {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

export default function LeaveCalendarPage(props: PageProps<"/leave/calendar">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <CalendarContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function CalendarContent({ searchParams }: { searchParams: Promise<Query> }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fleave%2Fcalendar&reason=expired");
  const isHr = auth.permissions.has("leave:read");
  if (!isHr && !auth.permissions.has("self:leave_read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Who is off" />
        <NoAccess what="see who is off" />
      </div>
    );
  }

  const q = await searchParams;
  const rt = getAuthRuntime();
  const tz = await attendanceTimezone(rt.db, auth);
  const today = localDay(new Date(), tz);
  const raw = one(q, "month");
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) && Number(raw.slice(0, 4)) >= 2000 && Number(raw.slice(0, 4)) <= 2100 ? raw : today.slice(0, 7);
  const first = `${month}-01`;
  const last = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const years = [...new Set([Number(first.slice(0, 4)), Number(last.slice(0, 4))])];
  const [entries, ...holidayLists] = await Promise.all([getWhoIsOff(rt.db, auth, first, last), ...years.map((y) => listHolidays(rt.db, auth, y))]);

  // A holiday for some outlets only still shades the day; the title says which.
  const holidays: Record<string, string> = {};
  for (const h of holidayLists.flat()) {
    if (h.day < first || h.day > last) continue;
    const label = h.outlet ? `${h.name} (${h.outlet})` : h.name;
    holidays[h.day] = holidays[h.day] ? `${holidays[h.day]}, ${label}` : label;
  }

  const byPerson = new Map<string, StripPerson>();
  for (const e of entries) {
    const p = byPerson.get(e.employeeId) ?? { employeeId: e.employeeId, name: e.employeeName, code: e.employeeCode, entries: [] };
    p.entries.push(e);
    byPerson.set(e.employeeId, p);
  }
  const people = [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name));
  const monthLabel = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${first}T00:00:00Z`));
  const link = (m: string) => `/leave/calendar?month=${m}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Who is off" description={monthLabel} />
      <LeaveNav active="calendar" canSelf={auth.permissions.has("self:leave_read")} canHr={isHr} />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" asChild>
          <Link href={link(shiftMonth(month, -1))}>
            <ChevronLeft aria-hidden />
            Previous month
          </Link>
        </Button>
        {month !== today.slice(0, 7) && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={link(today.slice(0, 7))}>This month</Link>
          </Button>
        )}
        <Button variant="secondary" size="sm" asChild>
          <Link href={link(shiftMonth(month, 1))}>
            Next month
            <ChevronRight aria-hidden />
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{monthLabel}</CardTitle>
            <CardDescription>{isHr ? "Approved leave and requests still waiting. Hover a cell for the leave type." : "Approved leave in your organisation."}</CardDescription>
          </div>
        </CardHeader>
        {people.length === 0 ? (
          <EmptyState icon={CalendarDays} title="Nobody is off this month." description={isHr ? "Approved leave and waiting requests show here." : "Approved leave shows here."} />
        ) : (
          <>
            <MonthStrip first={first} last={last} today={today} people={people} holidays={holidays} linkPeople={isHr} />
            <CardBody className="border-t border-border">
              <StripLegend showWaiting={isHr} />
            </CardBody>
          </>
        )}
      </Card>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading calendar">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-96" />
    </div>
  );
}
