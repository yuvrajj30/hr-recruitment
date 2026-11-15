import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/recruitment/job-bits";
import { PipelineBoard } from "@/components/recruitment/pipeline-board";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { readScope } from "@/lib/auth/permissions";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { listAssignableRecruiters, listJobOptions, listPipeline, PIPELINE_COLUMN_LIMIT } from "@/lib/recruitment/applications";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";

export const metadata: Metadata = { title: "Pipeline · HRMS" };

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, key: string): string => (typeof q[key] === "string" ? (q[key] as string) : "");

export default function PipelinePage(props: PageProps<"/recruitment/pipeline">) {
  return (
    <Suspense fallback={<BoardSkeleton />}>
      <PipelineContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function PipelineContent({ searchParams }: { searchParams: Promise<Query> }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Frecruitment%2Fpipeline&reason=expired");
  const scope = readScope(auth.permissions, "application");
  if (scope === "none") {
    return (
      <div className="space-y-6">
        <PageHeader title="Pipeline" />
        <NoAccess what="view applications" />
      </div>
    );
  }
  const q = await searchParams;
  const filters = { search: one(q, "q"), jobId: one(q, "job"), recruiter: one(q, "recruiter") };
  const db = getAuthRuntime().db;
  const settings = await getOrganizationSettings(db, auth);
  const [columns, jobs, recruiters] = await Promise.all([
    listPipeline(db, auth, filters, settings.timezone),
    listJobOptions(db, auth),
    scope === "all" ? listAssignableRecruiters(db, auth) : Promise.resolve([]),
  ]);
  const filtered = Boolean(filters.search || filters.jobId || filters.recruiter);
  const total = columns.reduce((sum, c) => sum + c.total, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipeline"
        description={scope === "assigned" ? "The applications assigned to you, by stage." : "Every application by stage. Drag a card to another column, or use its “Move to” menu."}
      />

      <Card>
        <form action="/recruitment/pipeline" className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4" role="search">
          <div className="space-y-1">
            <Label htmlFor="p-q">Search</Label>
            <Input id="p-q" name="q" type="search" defaultValue={filters.search} placeholder="Name, email or reference" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="p-job">Job</Label>
            <Select id="p-job" name="job" defaultValue={filters.jobId}>
              <option value="">All jobs</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                  {j.status !== "PUBLISHED" ? ` (${j.status.toLowerCase()})` : ""}
                </option>
              ))}
            </Select>
          </div>
          {scope === "all" && (
            <div className="space-y-1">
              <Label htmlFor="p-recruiter">Recruiter</Label>
              <Select id="p-recruiter" name="recruiter" defaultValue={filters.recruiter}>
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
          <div className="flex items-end gap-2">
            <Button type="submit" size="sm">
              Apply filters
            </Button>
            {filtered && (
              <Button variant="ghost" size="sm" asChild>
                <Link href="/recruitment/pipeline">Clear</Link>
              </Button>
            )}
            <span className="ml-auto text-[13px] text-fg-muted" role="status">
              <span className="tabular">{total}</span> application{total === 1 ? "" : "s"}
            </span>
          </div>
        </form>
      </Card>

      <PipelineBoard columns={columns} timeZone={settings.timezone} canMove={auth.permissions.has("application:move_stage")} limit={PIPELINE_COLUMN_LIMIT} />
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading pipeline">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-24" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-80 w-64 shrink-0" />
        ))}
      </div>
    </div>
  );
}
