import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { updateJobAction } from "@/app/(app)/recruitment/actions";
import { NoAccess } from "@/components/recruitment/job-bits";
import { JobForm, type JobFormValues } from "@/components/recruitment/job-form";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { isEditable } from "@/lib/recruitment/job-status";
import { getJob, getOrganizationSettings, type JobDetail, listJobDepartments } from "@/lib/recruitment/jobs";

export const metadata: Metadata = { title: "Edit job · HRMS" };

export default function EditJobPage(props: PageProps<"/recruitment/jobs/[jobId]/edit">) {
  return (
    <Suspense fallback={<Skeleton className="h-[40rem]" />}>
      <EditJobContent params={props.params} />
    </Suspense>
  );
}

async function EditJobContent({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/recruitment/jobs/${jobId}/edit`)}&reason=expired`);
  if (!auth.permissions.has("job:update") || !auth.permissions.has("job:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Edit job opening" />
        <NoAccess what="edit job openings" />
      </div>
    );
  }
  const db = getAuthRuntime().db;
  let job: JobDetail;
  try {
    job = await getJob(db, auth, jobId);
  } catch (error) {
    if (error instanceof RecruitmentError && error.code === "not_found") notFound();
    throw error;
  }
  if (!isEditable(job.status)) {
    return (
      <div className="space-y-6">
        <PageHeader title={job.title} />
        <Alert tone="warning">Archived jobs are kept for the record and can no longer be edited.</Alert>
      </div>
    );
  }
  const [departments, settings] = await Promise.all([listJobDepartments(db, auth), getOrganizationSettings(db, auth)]);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={`Edit: ${job.title}`} description={job.status === "PUBLISHED" ? "This job is live. Changes are visible to candidates as soon as you save." : undefined} />
      <JobForm
        action={updateJobAction.bind(null, job.id)}
        initial={toFormValues(job)}
        departments={departments}
        currency={settings.currency}
        submitLabel="Save changes"
        cancelHref={`/recruitment/jobs/${job.id}`}
      />
    </div>
  );
}

function toFormValues(job: JobDetail): JobFormValues {
  const num = (v: string | null) => (v === null ? "" : v.replace(/\.00$/, ""));
  return {
    title: job.title,
    description: job.description,
    departmentId: job.departmentId ?? "",
    employmentType: job.employmentType,
    workMode: job.workMode,
    visibility: job.visibility,
    location: job.location ?? "",
    requiredSkills: job.requiredSkills.join(", "),
    qualifications: job.qualifications ?? "",
    experienceRequirement: job.experienceRequirement ?? "",
    compensationMin: num(job.compensationMin),
    compensationMax: num(job.compensationMax),
    compensationPeriod: job.compensationPeriod ?? "",
    internshipMonths: job.internshipMonths?.toString() ?? "",
    openingsCount: job.openingsCount.toString(),
    applicationDeadline: job.applicationDeadlineDate ?? "",
  };
}
