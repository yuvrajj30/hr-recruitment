import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { updateInterviewAction } from "@/app/(app)/interviews/actions";
import { roundTitle } from "@/components/interviews/interview-bits";
import { ScheduleForm } from "@/components/interviews/schedule-form";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { getInterview, type InterviewDetail, listInterviewerOptions } from "@/lib/interviews/interviews";
import { canEditInterview, dateToZonedInput } from "@/lib/interviews/rules";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";

export const metadata: Metadata = { title: "Edit interview · HRMS" };

export default function EditInterviewPage(props: PageProps<"/interviews/[interviewId]/edit">) {
  return (
    <Suspense fallback={<Skeleton className="mx-auto h-[40rem] max-w-3xl" />}>
      <EditInterviewContent params={props.params} />
    </Suspense>
  );
}

async function EditInterviewContent({ params }: { params: Promise<{ interviewId: string }> }) {
  const { interviewId } = await params;
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/interviews/${interviewId}/edit`)}&reason=expired`);
  if (!auth.permissions.has("interview:update") || !auth.permissions.has("interview:read")) return <NoAccess what="change interviews" />;
  const rt = getAuthRuntime();
  const db = rt.db;
  const now = rt.now();
  let interview: InterviewDetail;
  try {
    interview = await getInterview(db, auth, interviewId);
  } catch (error) {
    if (error instanceof RecruitmentError && error.code === "not_found") notFound();
    throw error;
  }
  const back = `/interviews/${interview.id}`;
  const [options, { timezone }] = await Promise.all([listInterviewerOptions(db, auth), getOrganizationSettings(db, auth)]);
  // Current interviewers who can no longer be chosen (for example, their role changed) still appear, so they
  // are not removed by accident; the server refuses to ADD anyone who is not eligible.
  const known = new Set(options.map((o) => o.id));
  const interviewers = [...options, ...interview.participantRows.filter((p) => !known.has(p.userId)).map((p) => ({ id: p.userId, name: `${p.name} (no longer eligible)` }))];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href={back} className="text-[13px] text-fg-muted hover:text-fg">
        ← Back to the interview
      </Link>
      <PageHeader title={`Edit ${roundTitle(interview.roundNumber, interview.roundName).toLowerCase()}`} description={`${interview.candidateName} · ${interview.jobTitle}`} />
      {interview.status !== "SCHEDULED" ? (
        <Alert tone="warning">Only a scheduled interview can be changed. This one is final.</Alert>
      ) : !canEditInterview(interview.status, interview.start, now) ? (
        <Alert tone="warning">This interview has already started, so its time and interviewers can no longer change. Record what happened on the interview page, or cancel it and schedule a new round.</Alert>
      ) : (
        <ScheduleForm
          action={updateInterviewAction.bind(null, interview.id)}
          initial={{
            type: interview.type,
            start: dateToZonedInput(interview.start, timezone),
            duration: String(Math.round((interview.end.getTime() - interview.start.getTime()) / 60_000)),
            roundName: interview.roundName ?? "",
            meetingLink: interview.meetingLink ?? "",
            location: interview.location ?? "",
            instructions: interview.instructions ?? "",
            participantIds: interview.participantRows.map((p) => p.userId).join(","),
          }}
          interviewers={interviewers}
          timeZone={timezone}
          submitLabel="Save changes"
          cancelHref={back}
        />
      )}
    </div>
  );
}
