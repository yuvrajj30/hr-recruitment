import { Inbox, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { NoAccess, StageBadge } from "@/components/recruitment/job-bits";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { readScope } from "@/lib/auth/permissions";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { APPLICATION_SORTS, type ApplicationFilters, type ApplicationSort, listApplications, listAssignableRecruiters, listJobOptions } from "@/lib/recruitment/applications";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";
import { formatDate } from "@/lib/recruitment/labels";
import { isPipelineStage, PIPELINE_STAGES, STAGE_LABELS } from "@/lib/recruitment/stages";

export const metadata: Metadata = { title: "Applications · HRMS" };

const SORT_LABELS: Record<ApplicationSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  recently_moved: "Recently moved",
  candidate: "Candidate name (A–Z)",
  job: "Job title (A–Z)",
};

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, key: string): string => (typeof q[key] === "string" ? (q[key] as string) : "");

export default function ApplicationsPage(props: PageProps<"/recruitment/applications">) {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <ApplicationsContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function ApplicationsContent({ searchParams }: { searchParams: Promise<Query> }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Frecruitment%2Fapplications&reason=expired");
  const scope = readScope(auth.permissions, "application");
  if (scope === "none") {
    return (
      <div className="space-y-6">
        <PageHeader title="Applications" />
        <NoAccess what="view applications" />
      </div>
    );
  }

  const q = await searchParams;
  const sort = (APPLICATION_SORTS as readonly string[]).includes(one(q, "sort")) ? (one(q, "sort") as ApplicationSort) : "newest";
  const stage = one(q, "stage");
  const filters: ApplicationFilters = {
    search: one(q, "q"),
    jobId: one(q, "job"),
    stage: isPipelineStage(stage) ? stage : undefined,
    recruiter: one(q, "recruiter"),
    from: one(q, "from"),
    to: one(q, "to"),
    sort,
    page: Number(one(q, "page")) || 1,
  };
  const db = getAuthRuntime().db;
  const settings = await getOrganizationSettings(db, auth);
  const [result, jobs, recruiters] = await Promise.all([
    listApplications(db, auth, filters, settings.timezone),
    listJobOptions(db, auth),
    scope === "all" ? listAssignableRecruiters(db, auth) : Promise.resolve([]),
  ]);
  const canCreate = auth.permissions.has("application:create");
  const filtered = Boolean(filters.search || filters.jobId || filters.stage || filters.recruiter || filters.from || filters.to);
  const pageHref = (page: number) => {
    const p = new URLSearchParams();
    for (const key of ["q", "job", "stage", "recruiter", "from", "to", "sort"]) if (one(q, key)) p.set(key, one(q, key));
    if (page > 1) p.set("page", String(page));
    const s = p.toString();
    return s ? `/recruitment/applications?${s}` : "/recruitment/applications";
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Applications"
        description="Everyone who has applied, across all jobs."
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/recruitment/applications/new">
                <Plus aria-hidden />
                Add application
              </Link>
            </Button>
          )
        }
      />

      <Card>
        <form action="/recruitment/applications" className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4" role="search">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="f-q">Search</Label>
            <Input id="f-q" name="q" type="search" defaultValue={filters.search} placeholder="Name, email or reference number" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-job">Job</Label>
            <Select id="f-job" name="job" defaultValue={filters.jobId}>
              <option value="">All jobs</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                  {j.status !== "PUBLISHED" ? ` (${j.status.toLowerCase()})` : ""}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-stage">Status</Label>
            <Select id="f-stage" name="stage" defaultValue={filters.stage ?? ""}>
              <option value="">Any status</option>
              {PIPELINE_STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
          {scope === "all" && (
            <div className="space-y-1">
              <Label htmlFor="f-recruiter">Responsible</Label>
              <Select id="f-recruiter" name="recruiter" defaultValue={filters.recruiter}>
                <option value="">Anyone</option>
                <option value="unassigned">Unassigned</option>
                {recruiters.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="f-from">Applied from</Label>
            <Input id="f-from" name="from" type="date" defaultValue={filters.from} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-to">Applied to</Label>
            <Input id="f-to" name="to" type="date" defaultValue={filters.to} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-sort">Sort by</Label>
            <Select id="f-sort" name="sort" defaultValue={sort}>
              {APPLICATION_SORTS.map((s) => (
                <option key={s} value={s}>
                  {SORT_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" size="sm">
              Apply filters
            </Button>
            {filtered && (
              <Button variant="ghost" size="sm" asChild>
                <Link href="/recruitment/applications">Clear</Link>
              </Button>
            )}
            <span className="ml-auto text-[13px] text-fg-muted" role="status">
              <span className="tabular">{result.total}</span> application{result.total === 1 ? "" : "s"}
            </span>
          </div>
        </form>
      </Card>

      <Card>
        {result.items.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={filtered ? "No applications match these filters" : "No applications yet"}
            description={
              filtered ? "Try removing a filter or searching for something else." : "Applications appear here when candidates apply to a published job, or when you add one by hand."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Candidate</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Job</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Responsible</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Applied</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.items.map((a) => (
                  <tr key={a.id} className="hover:bg-surface-muted/60">
                    <td className="px-5 py-3">
                      <Link href={`/recruitment/applications/${a.id}`} className="font-medium text-fg hover:text-accent hover:underline">
                        {a.candidate.name}
                      </Link>
                      <div className="mt-0.5 text-xs text-fg-muted">{a.candidate.email}</div>
                    </td>
                    <td className="px-3 py-3">{a.job.title}</td>
                    <td className="px-3 py-3">
                      <StageBadge stage={a.stage} />
                    </td>
                    <td className="px-3 py-3 text-fg-muted">{a.recruiter?.name ?? "Unassigned"}</td>
                    <td className="px-3 py-3 text-fg-muted">{formatDate(a.appliedAt, settings.timezone)}</td>
                    <td className="tabular px-5 py-3 font-mono text-xs text-fg-muted">{a.referenceNumber}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.pages > 1 && (
          <nav aria-label="Pages" className="flex items-center justify-between border-t border-border px-5 py-3 text-[13px]">
            <span className="text-fg-muted">
              Page {result.page} of {result.pages}
            </span>
            <span className="flex gap-2">
              {result.page > 1 && (
                <Button variant="secondary" size="sm" asChild>
                  <Link href={pageHref(result.page - 1)}>Previous</Link>
                </Button>
              )}
              {result.page < result.pages && (
                <Button variant="secondary" size="sm" asChild>
                  <Link href={pageHref(result.page + 1)}>Next</Link>
                </Button>
              )}
            </span>
          </nav>
        )}
      </Card>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading applications">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
    </div>
  );
}
