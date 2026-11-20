import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { updateEmployeeAction } from "@/app/(app)/employees/actions";
import { EmployeeForm } from "@/components/employees/employee-form";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { type EmployeeDetail, getEmployee, listManagerChoices, listStructure } from "@/lib/employees/employees";
import { RecruitmentError } from "@/lib/recruitment/errors";

export const metadata: Metadata = { title: "Edit employee · HRMS" };

export default function EditEmployeePage(props: PageProps<"/employees/[employeeId]/edit">) {
  return (
    <Suspense fallback={<Skeleton className="mx-auto h-[40rem] max-w-3xl" />}>
      <EditEmployeeContent params={props.params} />
    </Suspense>
  );
}

async function EditEmployeeContent({ params }: { params: Promise<{ employeeId: string }> }) {
  const { employeeId } = await params;
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/employees/${employeeId}/edit`)}&reason=expired`);
  if (!auth.permissions.has("employee:manage") || !auth.permissions.has("employee:read")) return <NoAccess what="change employees" />;
  const rt = getAuthRuntime();
  let employee: EmployeeDetail;
  try {
    employee = await getEmployee(rt.db, auth, employeeId);
  } catch (error) {
    if (error instanceof RecruitmentError && error.code === "not_found") notFound();
    throw error;
  }
  const back = `/employees/${employee.id}`;
  const [structure, managers] = await Promise.all([listStructure(rt.db, auth), listManagerChoices(rt.db, auth, employee.id)]);
  // The current outlet / department / designation stay choosable even if they have been deactivated since.
  const choices = (items: { id: string; name: string; isActive: boolean }[], currentId: string | null) =>
    items.filter((i) => i.isActive || i.id === currentId).map((i) => ({ id: i.id, label: i.isActive ? i.name : `${i.name} (inactive)` }));
  const managerOptions = managers.map((m) => ({ id: m.id, label: `${m.fullName} (${m.employeeCode})` }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href={back} className="text-[13px] text-fg-muted hover:text-fg">
        ← Back to {employee.fullName}
      </Link>
      <PageHeader title={`Edit ${employee.fullName}`} description={employee.employeeCode} />
      {employee.status === "EXITED" ? (
        <Alert tone="warning">This employee has left, so their record can no longer be changed.</Alert>
      ) : (
        <EmployeeForm
          action={updateEmployeeAction.bind(null, employee.id)}
          initial={{
            employeeCode: employee.employeeCode,
            fullName: employee.fullName,
            email: employee.email ?? "",
            phone: employee.phone ?? "",
            employmentType: employee.employmentType,
            joinedOn: employee.joinedOn,
            outletId: employee.outletId ?? "",
            departmentId: employee.departmentId ?? "",
            designationId: employee.designationId ?? "",
            managerId: employee.managerId ?? "",
          }}
          outlets={choices(structure.outlet, employee.outletId)}
          departments={choices(structure.department, employee.departmentId)}
          designations={choices(structure.designation, employee.designationId)}
          managers={managerOptions}
          submitLabel="Save changes"
          cancelHref={back}
        />
      )}
    </div>
  );
}
