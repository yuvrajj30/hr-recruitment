import { BriefcaseBusiness, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { EMPLOYMENT_TYPE_LABELS, formatDate, WORK_MODE_LABELS } from "@/lib/recruitment/labels";
import { getPublicOrganization, listPublicJobs } from "@/lib/recruitment/public-jobs";

// The public list of an organisation's open jobs. Only published, public jobs whose deadline has not passed.

export const metadata: Metadata = { title: "Careers" };

export default function CareersPage(props: PageProps<"/careers/[orgSlug]">) {
  return (
    <Suspense fallback={<Skeleton className="h-72" />}>
      <OpenJobs params={props.params} />
    </Suspense>
  );
}

async function OpenJobs({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  await connection();
  const rt = getAuthRuntime();
  const now = rt.now();
  const organization = await getPublicOrganization(rt.db, orgSlug);
  if (!organization) notFound();
  const jobs = await listPublicJobs(rt.db, organization.slug, now);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-accent-fg">Careers</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">Work at {organization.name}</h1>
        <p className="mt-2 text-sm text-fg-muted">
          {jobs.length === 0 ? "There are no open jobs right now." : `${jobs.length} open job${jobs.length === 1 ? "" : "s"}. Choose one to read more and apply.`}
        </p>
      </header>

      <Card>
        {jobs.length === 0 ? (
          <EmptyState icon={BriefcaseBusiness} title="No open jobs at the moment" description="Please check again later." />
        ) : (
          <ul className="divide-y divide-border">
            {jobs.map((job) => (
              <li key={job.id}>
                <Link href={`/careers/${organization.slug}/jobs/${job.slug}`} className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-surface-muted/60">
                  <div className="min-w-0">
                    <p className="font-medium text-fg">{job.title}</p>
                    <p className="mt-0.5 text-[13px] text-fg-muted">
                      {[job.departmentName, EMPLOYMENT_TYPE_LABELS[job.employmentType], WORK_MODE_LABELS[job.workMode], job.location].filter(Boolean).join(" · ")}
                      {job.applicationDeadline && ` · Apply by ${formatDate(job.applicationDeadline, organization.timezone)}`}
                    </p>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
