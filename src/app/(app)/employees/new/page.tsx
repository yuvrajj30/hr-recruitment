import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createEmployeeAction } from "@/app/(app)/employees/actions";
import { EmployeeForm } from "@/components/employees/employee-form";
import { NoAccess } from "@/components/recruitment/job-bits";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { listManagerChoices, listStructure } from "@/lib/employees/employees";

export const metadata: Metadata = { title: "Add employee · HRMS" };

export default function NewEmployeePage() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto h-[40rem] max-w-3xl" />}>
      <NewEmployeeContent />
    </Suspense>
  );
}

async function NewEmployeeContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Femployees%2Fnew&reason=expired");
  if (!auth.permissions.has("employee:manage") || !auth.permissions.has("employee:read")) return <NoAccess what="add employees" />;
  const rt = getAuthRuntime();
  const [structure, managers] = await Promise.all([listStructure(rt.db, auth), listManagerChoices(rt.db, auth)]);
  const active = (items: { id: string; name: string; isActive: boolean }[]) => items.filter((i) => i.isActive).map((i) => ({ id: i.id, label: i.name }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/employees" className="text-[13px] text-fg-muted hover:text-fg">
        ← Back to employees
      </Link>
      <PageHeader title="Add employee" description="Fill in what you know now. Everything except the code, name and joining date can be left empty." />
      <EmployeeForm
        action={createEmployeeAction}
        initial={{ employmentType: "FULL_TIME" }}
        outlets={active(structure.outlet)}
        departments={active(structure.department)}
        designations={active(structure.designation)}
        managers={managers.map((m) => ({ id: m.id, label: `${m.fullName} (${m.employeeCode})` }))}
        submitLabel="Add employee"
        cancelHref="/employees"
      />
    </div>
  );
}
