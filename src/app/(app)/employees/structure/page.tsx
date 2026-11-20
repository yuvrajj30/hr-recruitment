import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { StructureSection } from "@/components/employees/structure-sections";
import { NoAccess } from "@/components/recruitment/job-bits";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { listStructure } from "@/lib/employees/employees";

export const metadata: Metadata = { title: "Outlets, departments and designations · HRMS" };

export default function StructurePage() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto h-[40rem] max-w-3xl" />}>
      <StructureContent />
    </Suspense>
  );
}

async function StructureContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Femployees%2Fstructure&reason=expired");
  if (!auth.permissions.has("employee:read")) return <NoAccess what="view employees" />;
  const canManage = auth.permissions.has("employee:manage");
  const structure = await listStructure(getAuthRuntime().db, auth);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/employees" className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        Employees
      </Link>
      <PageHeader
        title="Outlets, departments and designations"
        description="The lists employees are assigned from. Nothing is deleted: deactivate an item to stop using it. Employees already assigned to it keep it."
      />
      <StructureSection kind="outlet" items={structure.outlet} canManage={canManage} />
      <StructureSection kind="department" items={structure.department} canManage={canManage} />
      <StructureSection kind="designation" items={structure.designation} canManage={canManage} />
    </div>
  );
}
