import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Th } from "@/components/attendance/attendance-bits";
import { dayLabel, LeaveNav } from "@/components/leave/leave-bits";
import { HolidayForm, LeaveTypeForm, RemoveHolidayButton } from "@/components/leave/leave-forms";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { localDay } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { listStructure } from "@/lib/employees/employees";
import { listHolidays, listLeaveTypes } from "@/lib/leave/leave";
import { ACCRUAL_LABELS } from "@/lib/leave/rules";

export const metadata: Metadata = { title: "Leave set-up · HRMS" };

export default function LeaveSetupPage(props: PageProps<"/leave/setup">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SetupContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function SetupContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fleave%2Fsetup&reason=expired");
  if (!auth.permissions.has("leave:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Leave set-up" />
        <NoAccess what="see the leave set-up" />
      </div>
    );
  }

  const q = await searchParams;
  const canManage = auth.permissions.has("leave:manage");
  const rt = getAuthRuntime();
  const tz = await attendanceTimezone(rt.db, auth);
  const today = localDay(new Date(), tz);
  const rawYear = typeof q.year === "string" ? Number(q.year) : NaN;
  const year = Number.isInteger(rawYear) && rawYear >= 2000 && rawYear <= 2100 ? rawYear : Number(today.slice(0, 4));
  const [types, holidays, structure] = await Promise.all([
    listLeaveTypes(rt.db, auth),
    listHolidays(rt.db, auth, year),
    canManage && auth.permissions.has("employee:read") ? listStructure(rt.db, auth) : Promise.resolve(null),
  ]);
  const outlets = (structure?.outlet ?? []).filter((o) => o.isActive).map((o) => ({ id: o.id, name: o.name }));
  const href = (y: number) => `/leave/setup?year=${y}`;
  const defaultDay = today.startsWith(String(year)) ? today : `${year}-01-01`;

  return (
    <div className="space-y-6">
      <PageHeader title="Leave set-up" description="Leave types and holidays for your organisation." />
      <LeaveNav active="setup" canSelf={auth.permissions.has("self:leave_read")} />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Leave types</CardTitle>
            <CardDescription>Saving marks the type as set up. Changing the numbers never changes balances already given.</CardDescription>
          </div>
        </CardHeader>
        {types.length === 0 ? (
          <CardBody>
            <p className="text-[13px] text-fg-muted">There are no leave types yet.</p>
          </CardBody>
        ) : canManage ? (
          <ul className="divide-y divide-border">
            {types.map((t) => (
              <li key={t.id} className="space-y-3 px-5 py-4">
                <p className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-medium text-fg">{t.code}</span>
                  <Badge>{t.paid ? "Paid" : "Unpaid"}</Badge>
                  {t.paid && !t.configured && <Badge tone="warning">Not set up</Badge>}
                  {!t.isActive && <Badge>Not in use</Badge>}
                </p>
                <LeaveTypeForm
                  type={{
                    id: t.id, code: t.code, name: t.name, paid: t.paid, accrual: t.accrual, daysPerYear: String(t.daysPerYear),
                    carryOverMax: String(t.carryOverMax), noteRequired: t.noteRequired, isActive: t.isActive,
                  }}
                />
              </li>
            ))}
          </ul>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <Th className="px-5">Type</Th>
                  <Th>Paid</Th>
                  <Th>Credited</Th>
                  <Th>Days per year</Th>
                  <Th>Carry-over</Th>
                  <Th className="px-5">Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {types.map((t) => (
                  <tr key={t.id}>
                    <td className="px-5 py-2.5">
                      <span className="font-medium text-fg">{t.name}</span> <span className="text-fg-muted">{t.code}</span>
                    </td>
                    <td className="px-3 py-2.5">{t.paid ? "Paid" : "Unpaid"}</td>
                    <td className="px-3 py-2.5 text-fg-muted">{t.paid ? ACCRUAL_LABELS[t.accrual] : "No balance"}</td>
                    <td className="px-3 py-2.5 tabular">{t.paid ? t.daysPerYear : "—"}</td>
                    <td className="px-3 py-2.5 tabular">{t.paid ? t.carryOverMax : "—"}</td>
                    <td className="px-5 py-2.5">{t.paid && !t.configured ? <Badge tone="warning">Not set up</Badge> : t.isActive ? "In use" : "Not in use"}</td>
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
            <CardTitle>Add a leave type</CardTitle>
          </CardHeader>
          <CardBody>
            <LeaveTypeForm />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Holidays in {year}</CardTitle>
            <CardDescription>Holidays are not counted as leave days. A holiday added later never changes leave already approved.</CardDescription>
          </div>
          <nav aria-label="Holiday year" className="flex gap-2 text-[13px]">
            <Link href={href(year - 1)} className="rounded-md border border-border-strong px-3 py-1.5 font-medium text-fg hover:bg-surface-muted">
              {year - 1}
            </Link>
            <Link href={href(year + 1)} className="rounded-md border border-border-strong px-3 py-1.5 font-medium text-fg hover:bg-surface-muted">
              {year + 1}
            </Link>
          </nav>
        </CardHeader>
        {holidays.length === 0 ? (
          <CardBody>
            <p className="text-[13px] text-fg-muted">No holidays are set for {year}.</p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-border text-[13px]">
            {holidays.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2">
                <span className="font-medium text-fg">
                  {dayLabel(h.day)} <span className="font-normal text-fg-muted">{h.name}</span>
                </span>
                <span className="flex items-center gap-3 text-fg-muted">
                  {h.outlet ?? "All outlets"}
                  {canManage && <RemoveHolidayButton holidayId={h.id} />}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <CardBody className="border-t border-border">
            <HolidayForm outlets={outlets} defaultDay={defaultDay} />
          </CardBody>
        )}
      </Card>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading leave set-up">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-64" />
      <Skeleton className="h-48" />
    </div>
  );
}
