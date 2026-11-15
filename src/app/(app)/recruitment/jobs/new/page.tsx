import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createJobAction } from "@/app/(app)/recruitment/actions";
import { NoAccess } from "@/components/recruitment/job-bits";
import { JobForm } from "@/components/recruitment/job-form";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { getOrganizationSettings, listJobDepartments } from "@/lib/recruitment/jobs";

export const metadata: Metadata = { title: "New job · HRMS" };

export default function NewJobPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[40rem]" />}>
      <NewJobContent />
    </Suspense>
  );
}

async function NewJobContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Frecruitment%2Fjobs%2Fnew&reason=expired");
  const header = <PageHeader title="New job opening" description="It is saved as a draft. Nobody outside your team sees it until you publish it." />;
  if (!auth.permissions.has("job:create")) {
    return (
      <div className="space-y-6">
        {header}
        <NoAccess what="create job openings" />
      </div>
    );
  }
  const db = getAuthRuntime().db;
  const [departments, settings] = await Promise.all([listJobDepartments(db, auth), getOrganizationSettings(db, auth)]);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {header}
      <JobForm action={createJobAction} initial={{}} departments={departments} currency={settings.currency} submitLabel="Save draft" cancelHref="/recruitment" />
    </div>
  );
}
