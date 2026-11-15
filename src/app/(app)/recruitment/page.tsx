import { BriefcaseBusiness, Plus, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { JobStatusBadge, NoAccess } from "@/components/recruitment/job-bits";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { readScope } from "@/lib/auth/permissions";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { JOB_STATUS_LABELS, type JobStatus } from "@/lib/recruitment/job-status";
import { countJobsByStatus, getOrganizationSettings, type JobFilters, listJobs } from "@/lib/recruitment/jobs";
import { EMPLOYMENT_TYPE_LABELS, formatDate, WORK_MODE_LABELS } from "@/lib/recruitment/labels";
import { cn } from "@/lib/ui/cn";

export const metadata: Metadata = { title: "Recruitment · HRMS" };

const TABS = [
  { key: "ACTIVE", label: "All active" },
  { key: "DRAFT", label: JOB_STATUS_LABELS.DRAFT },
  { key: "PUBLISHED", label: JOB_STATUS_LABELS.PUBLISHED },
  { key: "CLOSED", label: JOB_STATUS_LABELS.CLOSED },
  { key: "ARCHIVED", label: JOB_STATUS_LABELS.ARCHIVED },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function RecruitmentPage(props: PageProps<"/recruitment">) {
  return (
    <Suspense fallback={<JobsSkeleton />}>
      <JobsContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function JobsContent({ searchParams }: { searchParams: PageProps<"/recruitment">["searchParams"] }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Frecruitment&reason=expired");
  if (!auth.permissions.has("job:read")) {
    // Someone who works applications but not job openings starts on their applications instead.
    if (readScope(auth.permissions, "application") !== "none") redirect("/recruitment/applications");
    return (
      <div className="space-y-6">
        <PageHeader title="Job openings" />
        <NoAccess what="view job openings" />
      </div>
    );
  }

  const params = await searchParams;
  const tab: TabKey = TABS.find((t) => t.key === params.status)?.key ?? "ACTIVE";
  const search = typeof params.q === "string" ? params.q.slice(0, 100) : "";
  const db = getAuthRuntime().db;
  const filters: JobFilters = { status: tab, search };
  const [jobs, counts, settings] = await Promise.all([listJobs(db, auth, filters), countJobsByStatus(db, auth), getOrganizationSettings(db, auth)]);
  const tabCount = (key: TabKey) => (key === "ACTIVE" ? counts.DRAFT + counts.PUBLISHED + counts.CLOSED : counts[key as JobStatus]);
  const canCreate = auth.permissions.has("job:create");
  const hrefFor = (key: TabKey) => {
    const q = new URLSearchParams();
    if (key !== "ACTIVE") q.set("status", key);
    if (search) q.set("q", search);
    const s = q.toString();
    return s ? `/recruitment?${s}` : "/recruitment";
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Job openings"
        description="Create roles, publish them to candidates and close them when filled."
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/recruitment/jobs/new">
                <Plus aria-hidden />
                New job
              </Link>
            </Button>
          )
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Filter by status" className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={hrefFor(t.key)}
              aria-current={t.key === tab ? "page" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-[13px] font-medium text-fg-muted hover:bg-surface-muted hover:text-fg",
                t.key === tab && "bg-surface-muted text-fg",
              )}
            >
              {t.label} <span className="tabular text-fg-subtle">{tabCount(t.key)}</span>
            </Link>
          ))}
        </nav>
        <form action="/recruitment" className="relative w-full sm:w-64" role="search">
          {tab !== "ACTIVE" && <input type="hidden" name="status" value={tab} />}
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input name="q" type="search" defaultValue={search} placeholder="Search by title" aria-label="Search jobs by title" className="pl-8" />
        </form>
      </div>

      <Card>
        {jobs.length === 0 ? (
          <EmptyState
            icon={BriefcaseBusiness}
            title={search ? "No jobs match your search" : tab === "ACTIVE" ? "No job openings yet" : `No ${JOB_STATUS_LABELS[tab as JobStatus].toLowerCase()} jobs`}
            description={search ? "Try a different title, or clear the search." : canCreate && tab === "ACTIVE" ? "Create your first job opening to start receiving applications." : "Jobs will appear here when there are some."}
            action={
              canCreate && tab === "ACTIVE" && !search ? (
                <Button asChild>
                  <Link href="/recruitment/jobs/new">New job</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Job</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Applications</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Deadline</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-surface-muted/60">
                    <td className="px-5 py-3">
                      <Link href={`/recruitment/jobs/${job.id}`} className="font-medium text-fg hover:text-accent hover:underline">
                        {job.title}
                      </Link>
                      <div className="mt-0.5 text-xs text-fg-muted">
                        {[job.departmentName, EMPLOYMENT_TYPE_LABELS[job.employmentType], WORK_MODE_LABELS[job.workMode], job.location].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <JobStatusBadge status={job.status} />
                    </td>
                    <td className="tabular px-3 py-3 text-right">{job.applicationCount}</td>
                    <td className="px-3 py-3 text-fg-muted">{job.applicationDeadline ? formatDate(job.applicationDeadline, settings.timezone) : "None"}</td>
                    <td className="px-5 py-3 text-fg-muted">{formatDate(job.updatedAt, settings.timezone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function JobsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading job openings">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-64" />
    </div>
  );
}
