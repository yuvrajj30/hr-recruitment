import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/recruitment/job-bits";
import { ManualApplicationForm } from "@/components/recruitment/manual-application-form";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { isUuid, listJobOptions } from "@/lib/recruitment/applications";

export const metadata: Metadata = { title: "Add application · HRMS" };

export default function NewApplicationPage(props: PageProps<"/recruitment/applications/new">) {
  return (
    <Suspense fallback={<Skeleton className="h-[40rem]" />}>
      <NewApplicationContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function NewApplicationContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Frecruitment%2Fapplications%2Fnew&reason=expired");
  const header = <PageHeader title="Add an application" description="For someone who applied in person, by phone or by email instead of through the careers page." />;
  if (!auth.permissions.has("application:create")) {
    return (
      <div className="space-y-6">
        {header}
        <NoAccess what="add applications" />
      </div>
    );
  }
  const jobs = await listJobOptions(getAuthRuntime().db, auth, "published");
  const wanted = (await searchParams).job;
  const defaultJobId = isUuid(wanted) && jobs.some((j) => j.id === wanted) ? wanted : undefined;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {header}
      <ManualApplicationForm jobs={jobs.map(({ id, title }) => ({ id, title }))} defaultJobId={defaultJobId} />
    </div>
  );
}
