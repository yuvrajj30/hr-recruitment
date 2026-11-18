import { CalendarClock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { formatSlot, InterviewStatusBadge, roundTitle, typeLabel } from "@/components/interviews/interview-bits";
import { NoAccess, StageBadge } from "@/components/recruitment/job-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { INTERVIEW_VIEW_LABELS, INTERVIEW_VIEWS, type InterviewView, listInterviews } from "@/lib/interviews/interviews";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";
import { cn } from "@/lib/ui/cn";

export const metadata: Metadata = { title: "Interviews · HRMS" };

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, key: string): string => (typeof q[key] === "string" ? (q[key] as string) : "");

export default function InterviewsPage(props: PageProps<"/interviews">) {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <InterviewsContent searchParams={props.searchParams} />
    </Suspense>
  );
}

const EMPTY: Record<InterviewView, { title: string; description: string }> = {
  upcoming: { title: "No upcoming interviews", description: "Schedule an interview from an application's page." },
  mine: { title: "You are not on any interviews", description: "Interviews you are an interviewer on appear here." },
  feedback: { title: "Nothing waiting for your feedback", description: "Once an interview you are on has started, it appears here until you submit your feedback." },
  past: { title: "No past interviews yet", description: "Completed, cancelled and no-show interviews appear here." },
  all: { title: "No interviews yet", description: "Schedule an interview from an application's page." },
};

async function InterviewsContent({ searchParams }: { searchParams: Promise<Query> }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Finterviews&reason=expired");
  if (!auth.permissions.has("interview:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Interviews" />
        <NoAccess what="view interviews" />
      </div>
    );
  }
  const q = await searchParams;
  const view = (INTERVIEW_VIEWS as readonly string[]).includes(one(q, "view")) ? (one(q, "view") as InterviewView) : "upcoming";
  const page = Number(one(q, "page")) || 1;
  const rt = getAuthRuntime();
  const db = rt.db;
  const now = rt.now(); // after getCurrentAuth (request time), never during prerendering
  const [result, { timezone }] = await Promise.all([listInterviews(db, auth, { view, page }, now), getOrganizationSettings(db, auth)]);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const href = (v: InterviewView, p = 1) => {
    const params = new URLSearchParams();
    if (v !== "upcoming") params.set("view", v);
    if (p > 1) params.set("page", String(p));
    const s = params.toString();
    return s ? `/interviews?${s}` : "/interviews";
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Interviews" description="Interviews for your organisation's applications. Schedule a new one from the application's page." />

      <nav aria-label="Choose interviews to show" className="flex flex-wrap gap-1">
        {INTERVIEW_VIEWS.map((v) => {
          const count = v === "upcoming" ? result.counts.upcoming : v === "feedback" ? result.counts.feedback : null;
          return (
            <Link
              key={v}
              href={href(v)}
              aria-current={v === view ? "page" : undefined}
              className={cn("rounded-md px-2.5 py-1.5 text-[13px] font-medium text-fg-muted hover:bg-surface-muted hover:text-fg", v === view && "bg-surface-muted text-fg")}
            >
              {INTERVIEW_VIEW_LABELS[v]}
              {count !== null && <span className="tabular ml-1.5 text-fg-subtle">{count}</span>}
            </Link>
          );
        })}
      </nav>

      <Card>
        {result.items.length === 0 ? (
          <EmptyState icon={CalendarClock} title={EMPTY[view].title} description={EMPTY[view].description} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">When</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Candidate</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Round</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Interviewers</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.items.map((i) => (
                  <tr key={i.id} className="hover:bg-surface-muted/60">
                    <td className="px-5 py-3">
                      <Link href={`/interviews/${i.id}`} className="font-medium text-fg hover:text-accent hover:underline">
                        {formatSlot(i.start, i.end, timezone)}
                      </Link>
                      <div className="mt-0.5 text-xs text-fg-muted">{typeLabel(i.type)}</div>
                    </td>
                    <td className="px-3 py-3">
                      <span className="font-medium text-fg">{i.candidateName}</span>
                      <div className="mt-0.5 text-xs text-fg-muted">
                        {i.jobTitle} · {i.application.referenceNumber}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-fg-muted">{roundTitle(i.roundNumber, i.roundName)}</td>
                    <td className="px-3 py-3 text-fg-muted">
                      {i.participants.map((p) => p.name).join(", ")}
                      {i.myFeedback === "submitted" && <div className="mt-0.5 text-xs text-success">Your feedback is in</div>}
                      {i.myFeedback === "draft" && <div className="mt-0.5 text-xs text-warning">Your feedback is a draft</div>}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex flex-col items-end gap-1">
                        <InterviewStatusBadge status={i.status} />
                        <StageBadge stage={i.application.stage} />
                        {i.isParticipant && <Badge tone="accent">You interview</Badge>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <nav aria-label="Pages" className="flex items-center justify-between border-t border-border px-5 py-3 text-[13px]">
            <span className="text-fg-muted">
              Page {result.page} of {pages}
            </span>
            <div className="flex gap-2">
              {result.page > 1 && (
                <Button variant="secondary" size="sm" asChild>
                  <Link href={href(view, result.page - 1)}>Previous</Link>
                </Button>
              )}
              {result.page < pages && (
                <Button variant="secondary" size="sm" asChild>
                  <Link href={href(view, result.page + 1)}>Next</Link>
                </Button>
              )}
            </div>
          </nav>
        )}
      </Card>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading interviews">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-8 w-96" />
      <Skeleton className="h-96" />
    </div>
  );
}
