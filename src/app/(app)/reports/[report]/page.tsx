import { BarChart3 } from "lucide-react";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/recruitment/job-bits";
import {
  type Column, PersonCell, REPORT_TITLES, ReportFilters, ReportsNav, ReportTable, Stat, StatGrid,
} from "@/components/reports/report-bits";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import type { AuthContext } from "@/lib/auth/context";
import { formatMinutes, localDay } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { formatDays, LEAVE_STATUS_LABELS, type LeaveRequestStatus } from "@/lib/leave/rules";
import { RecruitmentError } from "@/lib/recruitment/errors";
import {
  getAttendanceReport, getHeadcountReport, getHiringReport, getLeaveReport, getReportSetup, getTaskReport, type LeaveRow, type ReportSetup,
} from "@/lib/reports/reports";
import {
  type AttendanceRow, type Count, type HiringJobRow, isReportKind, type ReportKind, readReportQuery, type ReportQuery, type TaskRow,
} from "@/lib/reports/rules";

export const metadata: Metadata = { title: "Reports · HRMS" };

export default function ReportPage(props: PageProps<"/reports/[report]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReportContent params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

async function ReportContent({ params, searchParams }: { params: Promise<{ report: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { report } = await params;
  if (!isReportKind(report)) notFound();
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/reports/${report}`)}&reason=expired`);
  const { title, description } = REPORT_TITLES[report];
  if (!auth.permissions.has("report:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title={title} />
        <NoAccess what="see reports" />
      </div>
    );
  }
  const rt = getAuthRuntime();
  const setup = await getReportSetup(rt.db, auth);
  const query = readReportQuery(await searchParams, localDay(new Date(), setup.timeZone));
  const withOutlet = report !== "hiring";

  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} />
      <ReportsNav active={report} />
      <ReportFilters
        kind={report}
        values={{ period: query.period, outletId: query.outletId ?? "", year: query.year }}
        outlets={setup.outlets}
        withOutlet={withOutlet}
        withYear={report === "leave"}
        errors={query.errors}
      />
      <ReportBody kind={report} auth={auth} query={query} setup={setup} />
    </div>
  );
}

type Loaded =
  | { kind: "headcount"; data: Awaited<ReturnType<typeof getHeadcountReport>> }
  | { kind: "attendance"; data: AttendanceRow[] }
  | { kind: "leave"; data: Awaited<ReturnType<typeof getLeaveReport>> }
  | { kind: "hiring"; data: Awaited<ReturnType<typeof getHiringReport>> }
  | { kind: "tasks"; data: TaskRow[] }
  | { kind: "refused"; message: string };

async function load(kind: ReportKind, auth: AuthContext, query: ReportQuery): Promise<Loaded> {
  const db = getAuthRuntime().db;
  const now = new Date();
  try {
    switch (kind) {
      case "headcount": return { kind, data: await getHeadcountReport(db, auth, query.period, query.outletId) };
      case "attendance": return { kind, data: await getAttendanceReport(db, auth, query.period, query.outletId, now) };
      case "leave": return { kind, data: await getLeaveReport(db, auth, query.year, query.period, query.outletId) };
      case "hiring": return { kind, data: await getHiringReport(db, auth, query.period) };
      case "tasks": return { kind, data: await getTaskReport(db, auth, query.period, query.outletId, now) };
    }
  } catch (error) {
    // Only our own refusals ("too much data") are shown; anything else goes to the error page.
    if (!(error instanceof RecruitmentError) || error.code !== "invalid") throw error;
    return { kind: "refused", message: error.message };
  }
}

async function ReportBody({ kind, auth, query, setup }: { kind: ReportKind; auth: AuthContext; query: ReportQuery; setup: ReportSetup }) {
  const r = await load(kind, auth, query);
  switch (r.kind) {
    case "headcount": return <HeadcountView data={r.data} />;
    case "attendance": return <AttendanceView rows={r.data} />;
    case "leave": return <LeaveView data={r.data} />;
    case "hiring": return <HiringView data={r.data} />;
    case "tasks": return <TasksView rows={r.data} timeZone={setup.timeZone} />;
    case "refused":
      return (
        <Card>
          <CardBody>
            <p role="alert" className="text-[13px] text-danger">{r.message}</p>
          </CardBody>
        </Card>
      );
  }
}

function Empty({ text }: { text: string }) {
  return (
    <Card>
      <EmptyState icon={BarChart3} title="Nothing to show" description={text} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
function CountList({ title, items }: { title: string; items: Count[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      {items.length === 0 ? (
        <CardBody>
          <p className="text-[13px] text-fg-muted">Nobody.</p>
        </CardBody>
      ) : (
        <ReportTable rows={items} rowKey={(c) => c.name} minWidth={240}
          columns={[{ label: "Name", cell: (c) => c.name }, { label: "People", cell: (c) => c.count, numeric: true }]} />
      )}
    </Card>
  );
}

function HeadcountView({ data }: { data: Awaited<ReturnType<typeof getHeadcountReport>> }) {
  return (
    <>
      <StatGrid>
        <Stat label="Employed on the first day" value={data.atStart} />
        <Stat label="Employed on the last day" value={data.atEnd} />
        <Stat label="Joined" value={data.joiners} />
        <Stat label="Left" value={data.leavers} hint="Last working day in the period" />
        <Stat label="Turnover" value={data.turnoverPercent === null ? "—" : `${data.turnoverPercent}%`} hint="Leavers ÷ average headcount" />
      </StatGrid>
      <p className="text-xs text-fg-subtle">The groups below are the people employed on the last day, by their current outlet and department.</p>
      <div className="grid gap-4 lg:grid-cols-3">
        <CountList title="By outlet" items={data.byOutlet} />
        <CountList title="By department" items={data.byDepartment} />
        <CountList title="By employment type" items={data.byType} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
function AttendanceView({ rows }: { rows: AttendanceRow[] }) {
  if (rows.length === 0) return <Empty text="No shifts or attendance in this period." />;
  const sum = (f: (r: AttendanceRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const columns: Column<AttendanceRow>[] = [
    { label: "Person", cell: (r) => <PersonCell name={r.name} code={r.code} /> },
    { label: "Planned", cell: (r) => r.planned, numeric: true },
    { label: "Attended", cell: (r) => r.attended, numeric: true },
    { label: "Missed", cell: (r) => <Flag n={r.missed} />, numeric: true },
    { label: "On leave", cell: (r) => r.onLeave, numeric: true },
    { label: "Upcoming", cell: (r) => r.upcoming, numeric: true },
    { label: "Late", cell: (r) => (r.late ? `${r.late} (${formatMinutes(r.lateMinutes)})` : "0"), numeric: true },
    { label: "Left early", cell: (r) => r.early, numeric: true },
    { label: "No clock-out", cell: (r) => <Flag n={r.missingOut} />, numeric: true },
    { label: "Unplanned", cell: (r) => r.unplanned, numeric: true },
    { label: "Worked", cell: (r) => formatMinutes(r.workedMinutes), numeric: true },
  ];
  return (
    <>
      <StatGrid>
        <Stat label="Hours worked" value={formatMinutes(sum((r) => r.workedMinutes))} />
        <Stat label="Planned shifts" value={sum((r) => r.planned)} />
        <Stat label="Missed shifts" value={sum((r) => r.missed)} hint="Not counting approved leave" />
        <Stat label="Late arrivals" value={sum((r) => r.late)} hint="More than 5 minutes after the start" />
        <Stat label="Missing clock-outs" value={sum((r) => r.missingOut)} />
      </StatGrid>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Per person</CardTitle>
            <CardDescription>A shift or record counts on the day it starts. Voided records are left out.</CardDescription>
          </div>
        </CardHeader>
        <ReportTable rows={rows} columns={columns} rowKey={(r) => r.employeeId} minWidth={920} />
      </Card>
    </>
  );
}

function Flag({ n }: { n: number }) {
  return n > 0 ? <span className="font-medium text-danger">{n}</span> : <>0</>;
}

// ---------------------------------------------------------------------------
function LeaveView({ data }: { data: Awaited<ReturnType<typeof getLeaveReport>> }) {
  const paid = data.types.filter((t) => t.paid);
  const statuses = Object.entries(data.requests) as [LeaveRequestStatus, number][];
  return (
    <>
      <StatGrid>
        {(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN", "CANCELLED"] as const).map((s) => (
          <Stat key={s} label={`Requests: ${LEAVE_STATUS_LABELS[s].toLowerCase()}`} value={data.requests[s] ?? 0} hint={s === "PENDING" ? "Overlapping the period" : undefined} />
        ))}
      </StatGrid>
      {statuses.length === 0 && <p className="text-xs text-fg-subtle">No leave requests overlap this period.</p>}
      {data.rows.length === 0 ? (
        <Empty text={`Nobody was employed in ${data.year}.`} />
      ) : (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Balances for {data.year}</CardTitle>
              <CardDescription>Balance per paid leave type. Below it: days taken in {data.year}, and days of approved requests that start in the chosen period.</CardDescription>
            </div>
          </CardHeader>
          <ReportTable<LeaveRow>
            rows={data.rows}
            rowKey={(r) => r.employeeId}
            minWidth={320 + paid.length * 150}
            columns={[
              { label: "Person", cell: (r) => <PersonCell name={r.name} code={r.code} /> },
              ...paid.map((t): Column<LeaveRow> => ({
                label: t.name,
                numeric: true,
                cell: (r) => {
                  const b = r.balances.find((x) => x.typeId === t.id);
                  if (!b) return <span className="text-fg-subtle">—</span>;
                  return (
                    <span title={`Credited ${formatDays(b.credited)}, taken ${formatDays(b.taken)}, waiting ${formatDays(b.pending)}`}>
                      {formatDays(b.balance)}
                      {(b.taken !== 0 || b.takenInPeriod !== 0) && (
                        <span className="block text-xs text-fg-subtle">
                          {formatDays(b.taken)} taken{b.takenInPeriod !== 0 ? `, ${formatDays(b.takenInPeriod)} in period` : ""}
                        </span>
                      )}
                    </span>
                  );
                },
              })),
            ]}
          />
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function HiringView({ data }: { data: Awaited<ReturnType<typeof getHiringReport>> }) {
  if (data.jobs.length === 0) return <Empty text="There are no jobs yet (archived jobs are not shown)." />;
  const sum = (f: (r: HiringJobRow) => number) => data.jobs.reduce((s, r) => s + f(r), 0);
  return (
    <>
      <StatGrid>
        <Stat label="Applications received" value={sum((r) => r.received)} />
        <Stat label="Interviews scheduled" value={sum((r) => r.interviewing)} />
        <Stat label="Selected" value={sum((r) => r.selected)} />
        <Stat label="Joined" value={sum((r) => r.joined)} />
        <Stat label="Rejected" value={sum((r) => r.rejected)} />
      </StatGrid>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>In the period, per job</CardTitle>
            <CardDescription>Applications received, and moves into each stage during the period.</CardDescription>
          </div>
        </CardHeader>
        <ReportTable rows={data.jobs} rowKey={(r) => r.jobId} minWidth={720} columns={[
          { label: "Job", cell: (r) => r.title },
          { label: "Received", cell: (r) => r.received, numeric: true },
          { label: "Interviews", cell: (r) => r.interviewing, numeric: true },
          { label: "Selected", cell: (r) => r.selected, numeric: true },
          { label: "Offer accepted", cell: (r) => r.offerAccepted, numeric: true },
          { label: "Joined", cell: (r) => r.joined, numeric: true },
          { label: "Rejected", cell: (r) => r.rejected, numeric: true },
        ]} />
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Pipeline today</CardTitle>
            <CardDescription>Every application to these jobs, by its current stage, whatever the period.</CardDescription>
          </div>
        </CardHeader>
        {data.pipeline.length === 0 ? (
          <CardBody>
            <p className="text-[13px] text-fg-muted">No applications yet.</p>
          </CardBody>
        ) : (
          <ReportTable rows={data.pipeline} rowKey={(r) => r.stage} minWidth={280}
            columns={[{ label: "Stage", cell: (r) => r.label }, { label: "Applications", cell: (r) => r.count, numeric: true }]} />
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
function TasksView({ rows, timeZone }: { rows: TaskRow[]; timeZone: string }) {
  if (rows.length === 0) return <Empty text="No tasks were due in this period." />;
  const sum = (f: (r: TaskRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const ratings = rows.filter((r) => r.averageRating !== null);
  return (
    <>
      <StatGrid>
        <Stat label="Tasks due" value={sum((r) => r.assigned)} hint="Cancelled tasks left out" />
        <Stat label="Approved" value={sum((r) => r.approved)} />
        <Stat label="Approved on time" value={sum((r) => r.onTime)} hint={`Submitted by the deadline (${timeZone})`} />
        <Stat label="Overdue now" value={sum((r) => r.overdue)} />
        <Stat label="Changes requested" value={sum((r) => r.changesRequested)} />
      </StatGrid>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Per person</CardTitle>
            <CardDescription>
              Ratings are shown to HR here{ratings.length === 0 ? "; none were given in this period" : ""}.
            </CardDescription>
          </div>
        </CardHeader>
        <ReportTable rows={rows} rowKey={(r) => r.employeeId} minWidth={720} columns={[
          { label: "Person", cell: (r) => <PersonCell name={r.name} code={r.code} /> },
          { label: "Due", cell: (r) => r.assigned, numeric: true },
          { label: "Approved", cell: (r) => r.approved, numeric: true },
          { label: "On time", cell: (r) => r.onTime, numeric: true },
          { label: "Overdue", cell: (r) => <Flag n={r.overdue} />, numeric: true },
          { label: "Changes requested", cell: (r) => r.changesRequested, numeric: true },
          { label: "Average rating", cell: (r) => (r.averageRating === null ? "—" : `${r.averageRating} / 5`), numeric: true },
        ]} />
      </Card>
    </>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
