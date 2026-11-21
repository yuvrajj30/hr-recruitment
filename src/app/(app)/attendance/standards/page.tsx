import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AttendanceNav } from "@/components/attendance/attendance-bits";
import { ApplyStandardForm, EmployeeStandardForm, OutletHoursForm } from "@/components/attendance/standards-forms";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getStandards } from "@/lib/attendance/attendance";
import { STANDARD_DAYS_AHEAD, STANDARD_SHIFT_LABELS, WEEKDAYS } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";

export const metadata: Metadata = { title: "Standard shifts · HRMS" };

export default function StandardsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <StandardsContent />
    </Suspense>
  );
}

// "Morning 08:00–15:00 · Evening 15:00–23:00" (an evening ending at or before its start runs past midnight).
function hoursSummary(o: { opening: string | null; changeover: string | null; closing: string | null }): string | null {
  if (!o.opening || !o.changeover || !o.closing) return null;
  const end = o.closing === "00:00" ? "00:00 (midnight)" : o.closing <= o.changeover ? `${o.closing} (next day)` : o.closing;
  return `Morning ${o.opening}–${o.changeover} · Evening ${o.changeover}–${end}`;
}

async function StandardsContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fattendance%2Fstandards&reason=expired");
  if (!auth.permissions.has("attendance:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Standard shifts" />
        <NoAccess what="view standard shifts" />
      </div>
    );
  }
  const canManage = auth.permissions.has("attendance:manage");
  const data = await getStandards(getAuthRuntime().db, auth);
  const weekdays = WEEKDAYS.map((d) => ({ n: d.n, short: d.short }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Standard shifts"
        description={`The rota for the next ${STANDARD_DAYS_AHEAD} days is filled from these every morning and whenever you save here. Days you change by hand on the rota are never overwritten.`}
      />
      <AttendanceNav active="standards" canSelf={auth.permissions.has("self:attendance_read")} />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Outlet hours</CardTitle>
            <CardDescription>When each outlet opens, when the evening shift starts and when it closes.</CardDescription>
          </div>
        </CardHeader>
        {data.outlets.length === 0 ? (
          <p className="px-5 py-6 text-[13px] text-fg-muted">There are no active outlets yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.outlets.map((o) => {
              const summary = hoursSummary(o);
              return (
                <li key={o.id} className="space-y-3 px-5 py-4 text-[13px]">
                  <div>
                    <span className="font-medium text-fg">{o.name}</span>
                    <span className="block text-xs text-fg-muted">{summary ?? "No standard hours set"}</span>
                  </div>
                  {canManage && (
                    <OutletHoursForm
                      outlet={{
                        outletId: o.id,
                        opening: o.opening ?? "",
                        changeover: o.changeover ?? "",
                        closing: o.closing ?? "",
                        breakMinutes: String(o.breakMinutes),
                        hasHours: summary !== null,
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Employees</CardTitle>
            <CardDescription>Each person&apos;s standard shift and working days. The home outlet is set on the employee page.</CardDescription>
          </div>
        </CardHeader>
        {data.employees.length === 0 ? (
          <p className="px-5 py-6 text-[13px] text-fg-muted">There are no active employees yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.employees.map((e) => (
              <li key={e.id} className="grid gap-3 px-5 py-3 text-[13px] lg:grid-cols-[14rem_1fr]">
                <div>
                  <span className="font-medium text-fg">{e.fullName}</span>
                  <span className="block text-xs text-fg-muted">{e.employeeCode}</span>
                  <span className="block text-xs text-fg-muted">{e.outlet ?? "No outlet — set it on the employee page"}</span>
                </div>
                {canManage ? (
                  <EmployeeStandardForm employee={{ employeeId: e.id, standardShift: e.standardShift ?? "NONE", workDays: e.workDays }} weekdays={weekdays} />
                ) : (
                  <p className="text-fg-muted">
                    {e.standardShift ? `${STANDARD_SHIFT_LABELS[e.standardShift]} · ${weekdays.filter((d) => e.workDays.includes(d.n)).map((d) => d.short).join(", ")}` : "No standard"}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Apply to the rota now</CardTitle>
              <CardDescription>Adds any missing standard shifts for the next {STANDARD_DAYS_AHEAD} days.</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <ApplyStandardForm />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading standard shifts">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-10 w-full max-w-xl" />
      <Skeleton className="h-96" />
    </div>
  );
}
