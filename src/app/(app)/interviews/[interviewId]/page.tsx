import { ArrowLeft, Pencil } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import { durationMinutes, formatSlot, InterviewStatusBadge, RecommendationBadge, roundTitle, typeLabel } from "@/components/interviews/interview-bits";
import { FeedbackForm, InterviewStatusControls } from "@/components/interviews/interview-controls";
import { NoAccess, StageBadge } from "@/components/recruitment/job-bits";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { type FeedbackView, getInterview, type InterviewDetail } from "@/lib/interviews/interviews";
import { canEditInterview, canRecordOutcome, feedbackOpen, RATING_CRITERIA } from "@/lib/interviews/rules";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";
import { formatDateTime } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Interview · HRMS" };

const SAVED_MESSAGES: Record<string, string> = {
  scheduled: "Interview scheduled.",
  updated: "Changes saved.",
};

export default function InterviewPage(props: PageProps<"/interviews/[interviewId]">) {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <InterviewContent params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

async function InterviewContent({ params, searchParams }: { params: Promise<{ interviewId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ interviewId }, query] = await Promise.all([params, searchParams]);
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/interviews/${interviewId}`)}&reason=expired`);
  if (!auth.permissions.has("interview:read")) return <NoAccess what="view interviews" />;

  const rt = getAuthRuntime();
  let interview: InterviewDetail;
  try {
    interview = await getInterview(rt.db, auth, interviewId);
  } catch (error) {
    // Not found and "not yours to see" are the same page on purpose.
    if (error instanceof RecruitmentError && error.code === "not_found") notFound();
    throw error;
  }
  const { timezone } = await getOrganizationSettings(rt.db, auth);
  const now = rt.now();
  const scheduled = interview.status === "SCHEDULED";
  const canEdit = canEditInterview(interview.status, interview.start, now) && auth.permissions.has("interview:update");
  const outcomeAllowed = auth.permissions.has("interview:update") && canRecordOutcome(interview.status, interview.start, now);
  const canCancel = scheduled && auth.permissions.has("interview:cancel");
  const canWriteFeedback = auth.permissions.has("feedback:submit") && interview.myParticipantId !== null && interview.myFeedback !== "submitted";
  const feedbackIsOpen = feedbackOpen(interview.status, interview.start, now);
  // The "scheduled / saved" notice comes from the address after a redirect; it is stale once the interview ended.
  const saved = scheduled && typeof query.saved === "string" ? SAVED_MESSAGES[query.saved] : undefined;

  return (
    <div className="space-y-6">
      <Link href="/interviews" className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        Interviews
      </Link>

      <PageHeader
        title={`${interview.candidateName} · ${roundTitle(interview.roundNumber, interview.roundName)}`}
        description={`${interview.jobTitle} · ${interview.application.referenceNumber}`}
        actions={
          canEdit && (
            <Button variant="secondary" asChild>
              <Link href={`/interviews/${interview.id}/edit`}>
                <Pencil aria-hidden />
                Edit or reschedule
              </Link>
            </Button>
          )
        }
      />

      {saved && <Alert tone="success">{saved}</Alert>}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-6">
          {(outcomeAllowed || canCancel) && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>What happened?</CardTitle>
                  <CardDescription>
                    {outcomeAllowed ? "Record the outcome once the interview has taken place." : "The outcome can be recorded once the interview has started."}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardBody>
                <InterviewStatusControls interviewId={interview.id} canRecordOutcome={outcomeAllowed} canCancel={canCancel} />
              </CardBody>
            </Card>
          )}

          {interview.myParticipantId && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Your feedback</CardTitle>
                  <CardDescription>
                    {interview.myFeedback === "submitted"
                      ? "Submitted. It can no longer be changed."
                      : feedbackIsOpen
                        ? "Your own, independent view. Drafts are private to you; once submitted it is final and the other HR staff can read it."
                        : interview.status === "SCHEDULED"
                          ? "You can write your feedback once the interview has started."
                          : "Feedback is not collected for this interview."}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardBody>
                {interview.myFeedback === "submitted" && interview.myFeedbackRow ? (
                  <FeedbackCard f={interview.myFeedbackRow} timezone={timezone} />
                ) : canWriteFeedback && feedbackIsOpen ? (
                  <FeedbackForm interviewId={interview.id} initial={toFeedbackValues(interview.myFeedbackRow)} />
                ) : (
                  <p className="text-[13px] text-fg-muted">Nothing to do yet.</p>
                )}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div>
                <CardTitle>{interview.myParticipantId ? "Colleagues' feedback" : "Feedback"}</CardTitle>
                <CardDescription>Only submitted feedback is shown. Each interviewer writes on their own.</CardDescription>
              </div>
            </CardHeader>
            <CardBody className="space-y-4">
              {!auth.permissions.has("feedback:read") ? (
                <p className="text-[13px] text-fg-muted">Your role does not include reading interview feedback.</p>
              ) : interview.othersHiddenUntilISubmit ? (
                <p className="text-[13px] text-fg-muted">Submit your own feedback first. Colleagues&apos; feedback is shown after that, so everyone&apos;s view stays independent.</p>
              ) : interview.otherFeedback.length === 0 ? (
                <p className="text-[13px] text-fg-muted">No feedback has been submitted yet.</p>
              ) : (
                interview.otherFeedback.map((f) => <FeedbackCard key={f.participantId} f={f} timezone={timezone} />)
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="self-start">
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardBody>
              <dl className="space-y-3 text-[13px]">
                <Detail label="Status">
                  <span className="flex flex-wrap gap-1.5">
                    <InterviewStatusBadge status={interview.status} />
                  </span>
                </Detail>
                <Detail label="When">
                  {formatSlot(interview.start, interview.end, timezone)}
                  <span className="block font-normal text-fg-muted">{durationMinutes(interview.start, interview.end)} minutes</span>
                </Detail>
                <Detail label="Kind">{typeLabel(interview.type)}</Detail>
                {interview.location && <Detail label="Where">{interview.location}</Detail>}
                {interview.meetingLink && (
                  <Detail label="Meeting link">
                    <a href={interview.meetingLink} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-accent-fg hover:underline">
                      {interview.meetingLink.replace(/^https:\/\//, "")}
                    </a>
                  </Detail>
                )}
                <Detail label="Interviewers">
                  <ul className="space-y-0.5">
                    {interview.participantRows.map((p) => (
                      <li key={p.participantId}>
                        {p.name}
                        {p.isMe && <span className="font-normal text-fg-muted"> (you)</span>}
                      </li>
                    ))}
                  </ul>
                </Detail>
                {interview.status === "CANCELLED" && interview.cancelReason && <Detail label="Why it was cancelled">{interview.cancelReason}</Detail>}
                <Detail label="Application">
                  <Link href={`/recruitment/applications/${interview.application.id}`} className="text-accent-fg hover:underline">
                    {interview.application.referenceNumber}
                  </Link>
                  <span className="mt-1 block">
                    <StageBadge stage={interview.application.stage} />
                  </span>
                </Detail>
                <Detail label="Scheduled by">
                  {interview.createdByName ?? "A former team member"}
                  <span className="block font-normal text-fg-muted">{formatDateTime(interview.createdAt, timezone)}</span>
                </Detail>
              </dl>
            </CardBody>
          </Card>

          {interview.instructions && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Notes for the interviewers</CardTitle>
                  <CardDescription>Internal only.</CardDescription>
                </div>
              </CardHeader>
              <CardBody>
                <p className="text-[13px] whitespace-pre-line text-fg">{interview.instructions}</p>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function toFeedbackValues(f: FeedbackView | null): Record<string, string | undefined> {
  if (!f) return {};
  const s = (n: number | null) => (n == null ? "" : String(n));
  return {
    ...Object.fromEntries(Object.entries(f.ratings).map(([k, v]) => [k, s(v)])),
    overallRating: s(f.overallRating),
    recommendation: f.recommendation ?? "",
    strengths: f.strengths ?? "",
    weaknesses: f.weaknesses ?? "",
    notes: f.notes ?? "",
  };
}

function FeedbackCard({ f, timezone }: { f: FeedbackView; timezone: string }) {
  const scored = RATING_CRITERIA.filter((c) => f.ratings[c.key] != null);
  return (
    <article className="rounded-md border border-border p-4 text-[13px]">
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{f.isMine ? "You" : f.interviewerName}</span>
        {f.recommendation && <RecommendationBadge value={f.recommendation} />}
        {f.overallRating != null && <Badge>Overall {f.overallRating}/5</Badge>}
        {f.submittedAt && <span className="ml-auto text-xs text-fg-muted">{formatDateTime(f.submittedAt, timezone)}</span>}
      </header>
      {scored.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          {scored.map((c) => (
            <div key={c.key} className="flex justify-between gap-2">
              <dt className="text-fg-muted">{c.label}</dt>
              <dd className="tabular font-medium text-fg">{f.ratings[c.key]}/5</dd>
            </div>
          ))}
        </dl>
      )}
      {(
        [
          ["Strengths", f.strengths],
          ["Concerns", f.weaknesses],
          ["Other notes", f.notes],
        ] as const
      ).map(([label, text]) =>
        text ? (
          <div key={label} className="mt-3">
            <p className="text-xs text-fg-muted">{label}</p>
            <p className="mt-0.5 whitespace-pre-line text-fg">{text}</p>
          </div>
        ) : null,
      )}
    </article>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-0.5 font-medium text-fg">{children}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading interview">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-8 w-72" />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Skeleton className="h-96" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}
