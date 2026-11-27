import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/recruitment/job-bits";
import { REPORT_TITLES, ReportsNav, Stat } from "@/components/reports/report-bits";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMinutes, localDay } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { getAttendanceReport, getHeadcountReport, getHiringReport, getLeaveReport, getReportSetup, getTaskReport } from "@/lib/reports/reports";
import { defaultPeriod, type ReportKind } from "@/lib/reports/rules";

export const metadata: Metadata = { title: "Reports · HRMS" };

export default function ReportsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReportsOverview />
    </Suspense>
  );
}

async function ReportsOverview() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Freports&reason=expired");
  if (!auth.permissions.has("report:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Reports" />
        <NoAccess what="see reports" />
      </div>
    );
  }
  const rt = getAuthRuntime();
  const now = new Date();
  const setup = await getReportSetup(rt.db, auth);
  const today = localDay(now, setup.timeZone);
  const period = defaultPeriod(today);
  const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
  // One report at a time (each holds a database connection while it reads). A report that refuses ("too much data")
  // shows a note on its own tile; anything else goes to the error page as usual.
  type Stats = { label: string; value: string | number }[];
  const tile = async (fn: () => Promise<Stats>): Promise<Stats | null> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof RecruitmentError && error.code === "invalid") return null;
      throw error;
    }
  };
  const tiles: { kind: ReportKind; stats: Stats | null }[] = [];
  tiles.push({ kind: "headcount", stats: await tile(async () => {
    const r = await getHeadcountReport(rt.db, auth, period, null);
    return [{ label: "Employed today", value: r.atEnd }, { label: "Joined", value: r.joiners }, { label: "Left", value: r.leavers }];
  }) });
  tiles.push({ kind: "attendance", stats: await tile(async () => {
    const rows = await getAttendanceReport(rt.db, auth, period, null, now);
    return [
      { label: "Hours worked", value: formatMinutes(sum(rows, (r) => r.workedMinutes)) },
      { label: "Missed shifts", value: sum(rows, (r) => r.missed) },
      { label: "Late arrivals", value: sum(rows, (r) => r.late) },
    ];
  }) });
  tiles.push({ kind: "leave", stats: await tile(async () => {
    const r = await getLeaveReport(rt.db, auth, Number(today.slice(0, 4)), period, null);
    return [{ label: "Requests waiting", value: r.requests.PENDING ?? 0 }, { label: "Approved", value: r.requests.APPROVED ?? 0 }, { label: "People", value: r.rows.length }];
  }) });
  tiles.push({ kind: "hiring", stats: await tile(async () => {
    const r = await getHiringReport(rt.db, auth, period);
    return [
      { label: "Applications", value: sum(r.jobs, (j) => j.received) },
      { label: "Interviews", value: sum(r.jobs, (j) => j.interviewing) },
      { label: "Joined", value: sum(r.jobs, (j) => j.joined) },
    ];
  }) });
  tiles.push({ kind: "tasks", stats: await tile(async () => {
    const rows = await getTaskReport(rt.db, auth, period, null, now);
    const count = sum(rows, (r) => r.ratingCount);
    return [
      { label: "Due", value: sum(rows, (r) => r.assigned) },
      { label: "Overdue now", value: sum(rows, (r) => r.overdue) },
      { label: "Average rating", value: count ? `${Math.round((sum(rows, (r) => r.ratingSum) / count) * 10) / 10} / 5` : "—" },
    ];
  }) });

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" description={`This month so far (${period.from} to ${period.to}). Open a report to choose another period or download it.`} />
      <ReportsNav active="overview" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {tiles.map((t) => (
          <Card key={t.kind}>
            <CardHeader>
              <div>
                <CardTitle>{REPORT_TITLES[t.kind].title}</CardTitle>
                <CardDescription>{REPORT_TITLES[t.kind].description}</CardDescription>
              </div>
            </CardHeader>
            <CardBody className="space-y-3">
              {t.stats ? (
                <div className="grid grid-cols-3 gap-2">
                  {t.stats.map((s) => (
                    <Stat key={s.label} label={s.label} value={s.value} />
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-fg-muted">Too much data for a summary here. Open the report and choose a shorter period or one outlet.</p>
              )}
              <Link href={`/reports/${t.kind}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
                Open the {REPORT_TITLES[t.kind].title.toLowerCase()} report
                <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-44 w-full" />
        ))}
      </div>
    </div>
  );
}
