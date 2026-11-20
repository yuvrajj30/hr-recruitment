import { ArrowLeft, Pencil } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { LinkAccountControl, MarkLeftControl } from "@/components/employees/employee-controls";
import { AssignmentHistory, Detail, EmployeeStatusBadge, formatDay } from "@/components/employees/employee-bits";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { type EmployeeDetail, getEmployee, listLinkableAccounts } from "@/lib/employees/employees";
import { EMPLOYMENT_TYPE_LABELS } from "@/lib/employees/rules";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";

export const metadata: Metadata = { title: "Employee · HRMS" };

const SAVED_MESSAGES: Record<string, string> = {
  created: "Employee added.",
  updated: "Changes saved.",
};

export default function EmployeePage(props: PageProps<"/employees/[employeeId]">) {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <EmployeeContent params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

async function EmployeeContent({ params, searchParams }: { params: Promise<{ employeeId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ employeeId }, query] = await Promise.all([params, searchParams]);
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/employees/${employeeId}`)}&reason=expired`);
  if (!auth.permissions.has("employee:read")) return <NoAccess what="view employees" />;

  const rt = getAuthRuntime();
  let employee: EmployeeDetail;
  try {
    employee = await getEmployee(rt.db, auth, employeeId);
  } catch (error) {
    if (error instanceof RecruitmentError && error.code === "not_found") notFound();
    throw error;
  }
  const canManage = auth.permissions.has("employee:manage");
  const active = employee.status === "ACTIVE";
  const [{ timezone }, linkable] = await Promise.all([
    getOrganizationSettings(rt.db, auth),
    canManage && active && !employee.memberId ? listLinkableAccounts(rt.db, auth) : Promise.resolve([]),
  ]);
  const saved = typeof query.saved === "string" ? SAVED_MESSAGES[query.saved] : undefined;

  return (
    <div className="space-y-6">
      <Link href="/employees" className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        Employees
      </Link>

      <PageHeader
        title={employee.fullName}
        description={`${employee.employeeCode}${employee.designation ? ` · ${employee.designation}` : ""}`}
        actions={
          canManage &&
          active && (
            <Button variant="secondary" asChild>
              <Link href={`/employees/${employee.id}/edit`}>
                <Pencil aria-hidden />
                Edit
              </Link>
            </Button>
          )
        }
      />

      {saved && <Alert tone="success">{saved}</Alert>}
      {!active && (
        <Alert tone="warning">
          <EmployeeStatusBadge status="EXITED" exitedOn={employee.exitedOn} /> This employee has left. Their record is kept for your history and can no longer be changed.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardBody>
              <dl className="grid gap-4 text-[13px] sm:grid-cols-2">
                <Detail label="Status">
                  <EmployeeStatusBadge status={employee.status} exitedOn={employee.exitedOn} />
                </Detail>
                <Detail label="Employment type">{EMPLOYMENT_TYPE_LABELS[employee.employmentType]}</Detail>
                <Detail label="Joined on">{formatDay(employee.joinedOn)}</Detail>
                {employee.exitedOn && <Detail label="Left on">{formatDay(employee.exitedOn)}</Detail>}
                <Detail label="Email">{employee.email ?? "—"}</Detail>
                <Detail label="Phone">{employee.phone ?? "—"}</Detail>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Current assignment</CardTitle>
                <CardDescription>Where they work now and who they report to.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              <dl className="grid gap-4 text-[13px] sm:grid-cols-2">
                <Detail label="Outlet">{employee.outlet ?? "—"}</Detail>
                <Detail label="Department">{employee.department ?? "—"}</Detail>
                <Detail label="Designation">{employee.designation ?? "—"}</Detail>
                <Detail label="Manager">
                  {employee.managerId ? (
                    <Link href={`/employees/${employee.managerId}`} className="text-accent-fg hover:underline">
                      {employee.manager ?? "View manager"}
                    </Link>
                  ) : (
                    "—"
                  )}
                </Detail>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>People reporting to {employee.fullName}</CardTitle>
                <CardDescription>Active employees only.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              {employee.reports.length === 0 ? (
                <p className="text-[13px] text-fg-muted">Nobody reports to this person.</p>
              ) : (
                <ul className="space-y-1 text-[13px]">
                  {employee.reports.map((r) => (
                    <li key={r.id}>
                      <Link href={`/employees/${r.id}`} className="font-medium text-accent-fg hover:underline">
                        {r.fullName}
                      </Link>
                      <span className="ml-2 text-fg-muted">{r.employeeCode}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Assignment history</CardTitle>
                <CardDescription>Every change of outlet, department, designation or manager, newest first.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              <AssignmentHistory history={employee.history} timezone={timezone} showChangedBy />
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="self-start">
            <CardHeader>
              <div>
                <CardTitle>Login</CardTitle>
                <CardDescription>The staff account this person signs in with.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              {canManage && active ? (
                <LinkAccountControl employeeId={employee.id} account={employee.account} choices={linkable} />
              ) : employee.account ? (
                <p className="text-[13px] text-fg">
                  {employee.account.name} <span className="text-fg-muted">({employee.account.email})</span>
                </p>
              ) : (
                <p className="text-[13px] text-fg-muted">No login is linked.</p>
              )}
            </CardBody>
          </Card>

          {canManage && active && (
            <Card className="self-start">
              <CardHeader>
                <div>
                  <CardTitle>Leaving</CardTitle>
                  <CardDescription>Record the last working day when this person leaves.</CardDescription>
                </div>
              </CardHeader>
              <CardBody>
                <MarkLeftControl employeeId={employee.id} joinedOn={employee.joinedOn} />
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading employee">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-8 w-72" />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Skeleton className="h-96" />
        <Skeleton className="h-60" />
      </div>
    </div>
  );
}
