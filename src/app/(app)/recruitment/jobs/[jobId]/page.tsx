import { ArrowLeft, Pencil, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import { JobStatusBadge, NoAccess, StageBadge } from "@/components/recruitment/job-bits";
import { JobStatusActions } from "@/components/recruitment/job-status-actions";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { readScope } from "@/lib/auth/permissions";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { countApplicationsByStage } from "@/lib/recruitment/applications";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { availableJobActions, isEditable } from "@/lib/recruitment/job-status";
import { getJob, getOrganizationSettings, type JobDetail } from "@/lib/recruitment/jobs";
import { PIPELINE_STAGES } from "@/lib/recruitment/stages";
import { EMPLOYMENT_TYPE_LABELS, formatDate, formatDateTime, formatPay, VISIBILITY_LABELS, WORK_MODE_LABELS } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Job opening · HRMS" };

export default function JobPage(props: PageProps<"/recruitment/jobs/[jobId]">) {
  return (
    <Suspense fallback={<JobSkeleton />}>
      <JobContent params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

const SAVED_MESSAGES: Record<string, string> = {
  created: "Job saved as a draft. Publish it when it is ready for candidates.",
  updated: "Changes saved.",
  publish: "Job published. It is now accepting applications.",
  unpublish: "Job moved back to draft. Candidates can no longer see it.",
  close: "Applications closed.",
  reopen: "Job reopened. It is accepting applications again.",
  archive: "Job archived.",
};

async function JobContent({ params, searchParams }: { params: Promise<{ jobId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ jobId }, query] = await Promise.all([params, searchParams]);
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/recruitment/jobs/${jobId}`)}&reason=expired`);
  if (!auth.permissions.has("job:read")) return <NoAccess what="view job openings" />;

  const db = getAuthRuntime().db;
  let job: JobDetail;
  try {
    job = await getJob(db, auth, jobId);
  } catch (error) {
    if (error instanceof RecruitmentError && error.code === "not_found") notFound();
    throw error;
  }
  const { timezone } = await getOrganizationSettings(db, auth);
  const saved = typeof query.saved === "string" ? SAVED_MESSAGES[query.saved] : undefined;
  const actions = availableJobActions(job.status, auth.permissions);
  const canEdit = auth.permissions.has("job:update") && isEditable(job.status);
  const pay = formatPay(job.compensationMin, job.compensationMax, job.compensationCurrency, job.compensationPeriod);
  const applicationScope = readScope(auth.permissions, "application");
  const canSeeApplications = applicationScope !== "none";
  const stageCounts = canSeeApplications ? await countApplicationsByStage(db, auth, job.id) : [];
  const visibleCount = stageCounts.reduce((sum, c) => sum + c.count, 0);
  const publicPath = job.status === "PUBLISHED" && job.visibility === "PUBLIC" && auth.organization ? `/careers/${auth.organization.slug}/jobs/${job.slug}` : null;
  const deadlinePassed = job.status === "PUBLISHED" && job.applicationDeadline !== null && job.applicationDeadline <= new Date();

  return (
    <div className="space-y-6">
      <Link href="/recruitment" className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        Job openings
      </Link>

      <PageHeader
        title={job.title}
        description={[job.departmentName, EMPLOYMENT_TYPE_LABELS[job.employmentType], WORK_MODE_LABELS[job.workMode], job.location].filter(Boolean).join(" · ")}
        actions={
          canEdit && (
            <Button variant="secondary" asChild>
              <Link href={`/recruitment/jobs/${job.id}/edit`}>
                <Pencil aria-hidden />
                Edit
              </Link>
            </Button>
          )
        }
      />

      {saved && <Alert tone="success">{saved}</Alert>}
      {deadlinePassed && <Alert tone="warning">The application deadline has passed, so candidates can no longer apply. Close the job, or edit it to set a later deadline.</Alert>}

      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
            <JobStatusBadge status={job.status} />
            <span>{statusLine(job, timezone)}</span>
          </div>
          <JobStatusActions jobId={job.id} actions={actions} />
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Description</CardTitle>
            </CardHeader>
            <CardBody>
              <p className="text-sm leading-6 whitespace-pre-line text-fg">{job.description}</p>
            </CardBody>
          </Card>

          {(job.requiredSkills.length > 0 || job.qualifications || job.experienceRequirement) && (
            <Card>
              <CardHeader>
                <CardTitle>Requirements</CardTitle>
              </CardHeader>
              <CardBody className="space-y-4 text-sm">
                {job.requiredSkills.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {job.requiredSkills.map((s) => (
                      <Badge key={s}>{s}</Badge>
                    ))}
                  </div>
                )}
                {job.experienceRequirement && <Detail label="Experience">{job.experienceRequirement}</Detail>}
                {job.qualifications && (
                  <Detail label="Qualifications">
                    <span className="whitespace-pre-line">{job.qualifications}</span>
                  </Detail>
                )}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Applications</CardTitle>
                <CardDescription>{canSeeApplications ? `${visibleCount} application${visibleCount === 1 ? "" : "s"}${applicationScope === "assigned" ? " assigned to you" : ""}.` : "Your role does not include viewing applications."}</CardDescription>
              </div>
              {canSeeApplications && (
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  {auth.permissions.has("application:create") && job.status === "PUBLISHED" && (
                    <Button variant="secondary" size="sm" asChild>
                      <Link href={`/recruitment/applications/new?job=${job.id}`}>Add application</Link>
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" asChild>
                    <Link href={`/recruitment/pipeline?job=${job.id}`}>Pipeline</Link>
                  </Button>
                  <Button variant="secondary" size="sm" asChild>
                    <Link href={`/recruitment/applications?job=${job.id}`}>View all</Link>
                  </Button>
                </div>
              )}
            </CardHeader>
            {canSeeApplications &&
              (visibleCount === 0 ? (
                <EmptyState icon={Users} title="No applications yet" description={job.status === "PUBLISHED" ? "They appear here as candidates apply." : "Candidates can apply once the job is published."} />
              ) : (
                <CardBody className="flex flex-wrap gap-2">
                  {PIPELINE_STAGES.filter((stage) => stageCounts.some((c) => c.stage === stage)).map((stage) => (
                    <Link key={stage} href={`/recruitment/applications?job=${job.id}&stage=${stage}`} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[13px] hover:bg-surface-muted">
                      <StageBadge stage={stage} />
                      <span className="tabular font-medium text-fg">{stageCounts.find((c) => c.stage === stage)!.count}</span>
                    </Link>
                  ))}
                </CardBody>
              ))}
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className="space-y-3 text-[13px]">
              <Detail label="Openings">{job.openingsCount}</Detail>
              <Detail label="Pay">{pay ?? "Not shown"}</Detail>
              {job.internshipMonths && <Detail label="Internship length">{`${job.internshipMonths} month${job.internshipMonths === 1 ? "" : "s"}`}</Detail>}
              <Detail label="Visibility">{VISIBILITY_LABELS[job.visibility]}</Detail>
              {publicPath && (
                <Detail label="Public application page">
                  <Link href={publicPath} target="_blank" className="break-all text-accent-fg hover:underline">
                    {publicPath}
                  </Link>
                </Detail>
              )}
              <Detail label="Deadline">{job.applicationDeadline ? `${formatDate(job.applicationDeadline, timezone)}, end of day` : "None"}</Detail>
              <Detail label="Created">{`${formatDate(job.createdAt, timezone)} by ${job.createdByName}`}</Detail>
              <Detail label="Last updated">{formatDateTime(job.updatedAt, timezone)}</Detail>
            </dl>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function statusLine(job: JobDetail, tz: string): string {
  switch (job.status) {
    case "DRAFT":
      return "Only your team can see this job.";
    case "PUBLISHED":
      return job.publishedAt ? `Accepting applications since ${formatDate(job.publishedAt, tz)}.` : "Accepting applications.";
    case "CLOSED":
      return job.closedAt ? `Closed to new applications on ${formatDate(job.closedAt, tz)}.` : "Closed to new applications.";
    case "ARCHIVED":
      return "Kept for the record. It can no longer be changed.";
  }
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-0.5 font-medium text-fg">{children}</dd>
    </div>
  );
}

function JobSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading job opening">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-16" />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}
