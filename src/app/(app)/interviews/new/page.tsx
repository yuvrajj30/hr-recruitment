import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { scheduleInterviewAction } from "@/app/(app)/interviews/actions";
import { ScheduleForm } from "@/components/interviews/schedule-form";
import { NoAccess, StageBadge } from "@/components/recruitment/job-bits";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { getSchedulingTarget, listInterviewerOptions } from "@/lib/interviews/interviews";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";

export const metadata: Metadata = { title: "Schedule interview · HRMS" };

export default function NewInterviewPage(props: PageProps<"/interviews/new">) {
  return (
    <Suspense fallback={<Skeleton className="mx-auto h-[40rem] max-w-3xl" />}>
      <NewInterviewContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function NewInterviewContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const applicationId = typeof q.application === "string" ? q.application : "";
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/interviews/new?application=${applicationId}`)}&reason=expired`);
  if (!auth.permissions.has("interview:schedule")) return <NoAccess what="schedule interviews" />;
  if (!applicationId) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader title="Schedule an interview" />
        <Alert tone="info">
          Open the application from{" "}
          <Link href="/recruitment/applications" className="font-medium underline">
            Applications
          </Link>{" "}
          and choose “Schedule interview” there.
        </Alert>
      </div>
    );
  }
  const db = getAuthRuntime().db;
  let target: Awaited<ReturnType<typeof getSchedulingTarget>>;
  try {
    target = await getSchedulingTarget(db, auth, applicationId);
  } catch (error) {
    if (error instanceof RecruitmentError && error.code === "not_found") notFound();
    throw error;
  }
  const [interviewers, { timezone }] = await Promise.all([listInterviewerOptions(db, auth), getOrganizationSettings(db, auth)]);
  const back = `/recruitment/applications/${target.id}`;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href={back} className="text-[13px] text-fg-muted hover:text-fg">
        ← {target.candidateName}&apos;s application
      </Link>
      <PageHeader title={`Schedule round ${target.nextRound}`} description={`${target.candidateName} · ${target.jobTitle} · ${target.referenceNumber}`} />
      {!target.open ? (
        <Alert tone="warning">
          <span className="inline-flex items-center gap-2">
            This application is <StageBadge stage={target.stage} />. Interviews can only be scheduled for open applications.
          </span>
        </Alert>
      ) : (
        <ScheduleForm
          action={scheduleInterviewAction.bind(null, target.id)}
          // The person scheduling is ticked by default; they can untick themselves.
          initial={{ type: "IN_PERSON", duration: "45", participantIds: interviewers.some((i) => i.id === auth.user.id) ? auth.user.id : "" }}
          interviewers={interviewers}
          timeZone={timezone}
          submitLabel="Schedule interview"
          cancelHref={back}
        />
      )}
    </div>
  );
}
