import { FileQuestion } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Th } from "@/components/attendance/attendance-bits";
import { LeaveNav, LeaveStatusBadge, leaveRange } from "@/components/leave/leave-bits";
import { AdjustLeaveForm } from "@/components/leave/leave-forms";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { localDay } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { type EmployeeLeave, getEmployeeLeave } from "@/lib/leave/leave";
import { formatDays, LEDGER_KIND_LABELS } from "@/lib/leave/rules";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { formatDateTime } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Employee leave · HRMS" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function EmployeeLeavePage(props: PageProps<"/leave/employees/[employeeId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <EmployeeContent params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

async function EmployeeContent({ params, searchParams }: { params: Promise<{ employeeId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { employeeId } = await params;
  const q = await searchParams;
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/leave/employees/${employeeId}`)}&reason=expired`);
  if (!auth.permissions.has("leave:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Employee leave" />
        <NoAccess what="see an employee's leave" />
      </div>
    );
  }

  const rt = getAuthRuntime();
  const tz = await attendanceTimezone(rt.db, auth);
  const today = localDay(new Date(), tz);
  const rawYear = typeof q.year === "string" ? Number(q.year) : NaN;
  const year = Number.isInteger(rawYear) && rawYear >= 2000 && rawYear <= 2100 ? rawYear : Number(today.slice(0, 4));
  let data: EmployeeLeave;
  try {
    data = await getEmployeeLeave(rt.db, auth, employeeId, year);
  } catch (error) {
    if (!(error instanceof RecruitmentError) || error.code !== "not_found") throw error;
    return (
      <div className="space-y-6">
        <PageHeader title="Employee leave" />
        <Card>
          <EmptyState icon={FileQuestion} title="Employee not found" description="They may have been removed, or the link is wrong." />
        </Card>
      </div>
    );
  }

  const canManage = auth.permissions.has("leave:manage");
  const href = (y: number) => `/leave/employees/${employeeId}?year=${y}`;
  const paidTypes = data.types.filter((t) => t.paid && t.isActive && t.configured).map((t) => ({ id: t.id, name: t.name }));

  return (
    <div className="space-y-6">
      <PageHeader title={data.employee.name} description={`${data.employee.code}, leave for ${year}`} />
      <LeaveNav canSelf={auth.permissions.has("self:leave_read")} />

      <nav aria-label="Leave year" className="flex flex-wrap gap-2 text-[13px]">
        <Link href={href(year - 1)} className="rounded-md border border-border-strong px-3 py-1.5 font-medium text-fg hover:bg-surface-muted">
          {year - 1}
        </Link>
        <span aria-current="page" className="rounded-md border border-accent bg-accent-soft px-3 py-1.5 font-medium text-accent-fg">
          {year}
        </span>
        <Link href={href(year + 1)} className="rounded-md border border-border-strong px-3 py-1.5 font-medium text-fg hover:bg-surface-muted">
          {year + 1}
        </Link>
      </nav>

      <Card>
        <CardHeader>
          <CardTitle>Balances</CardTitle>
        </CardHeader>
        {data.balances.length === 0 ? (
          <CardBody>
            <p className="text-[13px] text-fg-muted">No leave types are in use for this year.</p>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <Th className="px-5">Type</Th>
                  <Th>Credited</Th>
                  <Th>Taken</Th>
                  <Th>Waiting</Th>
                  <Th>Balance</Th>
                  <Th className="px-5">Available</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.balances.map((b) => (
                  <tr key={b.typeId}>
                    <td className="px-5 py-2.5 font-medium text-fg">{b.typeName}</td>
                    {b.paid ? (
                      <>
                        <td className="px-3 py-2.5 tabular">{formatDays(b.credited)}</td>
                        <td className="px-3 py-2.5 tabular">{formatDays(b.taken)}</td>
                        <td className="px-3 py-2.5 tabular">{formatDays(b.pending)}</td>
                        <td className="px-3 py-2.5 tabular">{formatDays(b.balance)}</td>
                        <td className="px-5 py-2.5 tabular">{formatDays(b.available ?? 0)}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2.5 text-fg-muted" colSpan={3}>
                          Unpaid leave: no balance
                        </td>
                        <td className="px-3 py-2.5 tabular text-fg-muted">{formatDays(b.taken)} taken</td>
                        <td className="px-5 py-2.5 text-fg-subtle">—</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Adjust a balance</CardTitle>
          </CardHeader>
          <CardBody>
            {paidTypes.length === 0 ? (
              <p className="text-[13px] text-fg-muted">There is no paid leave type set up yet. Set one up first.</p>
            ) : (
              <AdjustLeaveForm employeeId={employeeId} year={year} types={paidTypes} />
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Ledger</CardTitle>
        </CardHeader>
        {data.ledger.length === 0 ? (
          <CardBody>
            <p className="text-[13px] text-fg-muted">Nothing has been credited or taken in {year}.</p>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <Th className="px-5">Date</Th>
                  <Th>Type</Th>
                  <Th>What</Th>
                  <Th>Days</Th>
                  <Th>Reason</Th>
                  <Th className="px-5">By</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border align-top">
                {data.ledger.map((l) => (
                  <tr key={l.id}>
                    <td className="px-5 py-2.5 whitespace-nowrap text-fg-muted">{formatDateTime(l.createdAt, tz)}</td>
                    <td className="px-3 py-2.5">{l.typeCode}</td>
                    <td className="px-3 py-2.5">
                      {LEDGER_KIND_LABELS[l.kind]}
                      {l.kind === "ACCRUAL" && l.month ? <span className="text-fg-muted"> ({MONTHS[l.month - 1]})</span> : null}
                    </td>
                    <td className="px-3 py-2.5 tabular">{l.days > 0 ? "+" : ""}{formatDays(l.days)}</td>
                    <td className="px-3 py-2.5 text-fg-muted">{l.reason ?? "—"}</td>
                    <td className="px-5 py-2.5 text-fg-muted">{l.createdBy ?? "System"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Requests</CardTitle>
        </CardHeader>
        {data.requests.length === 0 ? (
          <CardBody>
            <p className="text-[13px] text-fg-muted">No leave requests in {year}.</p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-border">
            {data.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[13px]">
                <Link href={`/leave/requests/${r.id}`} className="font-medium text-accent-fg hover:underline">
                  {leaveRange(r.start, r.end, r.startHalf, r.endHalf)}
                </Link>
                <span className="text-fg-muted">
                  {r.typeName}, <span className="tabular">{formatDays(r.days)}</span>
                </span>
                <LeaveStatusBadge status={r.status} />
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
    <div className="space-y-6" aria-busy="true" aria-label="Loading employee leave">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-48" />
      <Skeleton className="h-64" />
    </div>
  );
}
