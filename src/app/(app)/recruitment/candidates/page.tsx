import { Search, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { readScope } from "@/lib/auth/permissions";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { listCandidates } from "@/lib/recruitment/candidates";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";
import { formatDate } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Candidates · HRMS" };

type Query = Record<string, string | string[] | undefined>;

export default function CandidatesPage(props: PageProps<"/recruitment/candidates">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <CandidatesContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function CandidatesContent({ searchParams }: { searchParams: Promise<Query> }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Frecruitment%2Fcandidates&reason=expired");
  const scope = readScope(auth.permissions, "candidate");
  if (scope === "none") {
    return (
      <div className="space-y-6">
        <PageHeader title="Candidates" />
        <NoAccess what="view candidates" />
      </div>
    );
  }
  const q = await searchParams;
  const search = typeof q.q === "string" ? q.q.slice(0, 100) : "";
  const db = getAuthRuntime().db;
  const [result, { timezone }] = await Promise.all([listCandidates(db, auth, { search, page: Number(q.page) || 1 }), getOrganizationSettings(db, auth)]);
  const pageHref = (page: number) => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (page > 1) p.set("page", String(page));
    const s = p.toString();
    return s ? `/recruitment/candidates?${s}` : "/recruitment/candidates";
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Candidates"
        description="Everyone who has applied to your organisation. One profile per person, however many jobs they apply for."
      />

      <form action="/recruitment/candidates" className="relative w-full sm:w-80" role="search">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <Input name="q" type="search" defaultValue={search} placeholder="Name, email, phone or skill" aria-label="Search candidates" className="pl-8" />
      </form>

      <Card>
        {result.items.length === 0 ? (
          <EmptyState
            icon={UsersRound}
            title={search ? "No candidates match your search" : "No candidates yet"}
            description={search ? "Try a different name, email, phone number or skill." : "A candidate profile is created the first time someone applies."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Candidate</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Phone</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">First applied</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Applications</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Last applied</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.items.map((c) => (
                  <tr key={c.id} className="hover:bg-surface-muted/60">
                    <td className="px-5 py-3">
                      <Link href={`/recruitment/candidates/${c.id}`} className="font-medium text-fg hover:text-accent hover:underline">
                        {c.name}
                      </Link>
                      <div className="mt-0.5 text-xs text-fg-muted">{c.email}</div>
                    </td>
                    <td className="tabular px-3 py-3 text-fg-muted">{c.phone ?? "—"}</td>
                    <td className="px-3 py-3 text-fg-muted">{formatDate(c.firstSeenAt, timezone)}</td>
                    <td className="tabular px-3 py-3 text-right">{c.applicationCount}</td>
                    <td className="px-5 py-3 text-fg-muted">{c.lastAppliedAt ? formatDate(c.lastAppliedAt, timezone) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.pages > 1 && (
          <nav aria-label="Pages" className="flex items-center justify-between border-t border-border px-5 py-3 text-[13px]">
            <span className="text-fg-muted">
              Page {result.page} of {result.pages} · {result.total} candidates
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
