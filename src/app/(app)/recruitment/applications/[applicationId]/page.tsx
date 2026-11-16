import { ArrowLeft, Download, FileText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import { NoteForm, RecruiterPicker, StageMover } from "@/components/recruitment/application-controls";
import { NoAccess, StageBadge } from "@/components/recruitment/job-bits";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { readScope } from "@/lib/auth/permissions";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { type ApplicationDetail, getApplication, listAssignableRecruiters } from "@/lib/recruitment/applications";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";
import { formatDate, formatDateTime, formatFileSize } from "@/lib/recruitment/labels";
import { STAGE_LABELS } from "@/lib/recruitment/stages";

export const metadata: Metadata = { title: "Application · HRMS" };

export default function ApplicationPage(props: PageProps<"/recruitment/applications/[applicationId]">) {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <ApplicationContent params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

async function ApplicationContent({ params, searchParams }: { params: Promise<{ applicationId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ applicationId }, query] = await Promise.all([params, searchParams]);
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/recruitment/applications/${applicationId}`)}&reason=expired`);
  if (readScope(auth.permissions, "application") === "none") return <NoAccess what="view applications" />;

  const db = getAuthRuntime().db;
  let app: ApplicationDetail;
  try {
    app = await getApplication(db, auth, applicationId);
  } catch (error) {
    // Not found and "not yours to see" are the same page on purpose.
    if (error instanceof RecruitmentError && error.code === "not_found") notFound();
    throw error;
  }
  const canAssign = auth.permissions.has("application:assign");
  const canMove = auth.permissions.has("application:move_stage");
  const canNote = auth.permissions.has("application:note");
  const canSeeCandidate = readScope(auth.permissions, "candidate") !== "none";
  const [{ timezone }, recruiters] = await Promise.all([getOrganizationSettings(db, auth), canAssign ? listAssignableRecruiters(db, auth) : Promise.resolve([])]);
  const s = app.snapshot;

  // One timeline: stage changes and changes of the responsible HR person, newest first.
  const timeline = [
    ...app.history.map((h) => ({
      id: `h-${h.id}`,
      at: h.createdAt,
      title: h.from === null ? "Application received" : `${STAGE_LABELS[h.from]} → ${STAGE_LABELS[h.to]}`,
      by: h.byName,
      detail: h.reason,
    })),
    ...app.assignments.map((a) => ({
      id: `a-${a.id}`,
      at: a.createdAt,
      title: a.unassigned ? "Responsible person removed" : `Assigned to ${a.recruiterName ?? "a former team member"}`,
      by: a.byName,
      detail: null as string | null,
    })),
  ].sort((x, y) => y.at.getTime() - x.at.getTime());

  return (
    <div className="space-y-6">
      <Link href="/recruitment/applications" className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        Applications
      </Link>

      <PageHeader title={app.candidate.name} description={`Application for ${app.job.title} · ${app.referenceNumber}`} />

      {query.saved === "created" && <Alert tone="success">Application added.</Alert>}

      <Card>
        <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
          <StageBadge stage={app.stage} />
          <span className="text-fg-muted">
            Applied {formatDate(app.appliedAt, timezone)}
            {app.enteredByStaff ? ` · entered by ${app.enteredByName ?? "a team member"}` : " · through the careers page"}
          </span>
          <span className="text-fg-muted">In this stage since {formatDate(app.stageChangedAt, timezone)}</span>
          {app.stage === "REJECTED" && app.rejectionReason && <span className="basis-full text-fg">Reason: {app.rejectionReason}</span>}
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Submitted details</CardTitle>
                <CardDescription>Exactly what was entered with this application.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              {s ? (
                <dl className="grid gap-x-6 gap-y-4 text-[13px] sm:grid-cols-2">
                  <Detail label="Full name">{s.fullName}</Detail>
                  <Detail label="Email">
                    <a href={`mailto:${s.email}`} className="text-accent-fg hover:underline">
                      {s.email}
                    </a>
                  </Detail>
                  <Detail label="Phone">{s.phone || "Not given"}</Detail>
                  <Detail label="City">{s.city ?? "Not given"}</Detail>
                  <Detail label="Education" wide>
                    {s.education ? [s.education.degree, s.education.course, s.education.institution, s.education.graduationYear].filter(Boolean).join(" · ") : "Not given"}
                  </Detail>
                  <Detail label="Skills" wide>
                    {s.skills.length > 0 ? (
                      <span className="flex flex-wrap gap-1.5">
                        {s.skills.map((skill) => (
                          <Badge key={skill}>{skill}</Badge>
                        ))}
                      </span>
                    ) : (
                      "Not given"
                    )}
                  </Detail>
                  <Detail label="Experience" wide>
                    {s.experience ? (
                      <>
                        {s.experience.title} at {s.experience.company}
                        {s.experience.description && <span className="mt-1 block font-normal whitespace-pre-line text-fg-muted">{s.experience.description}</span>}
                      </>
                    ) : s.experienceNote ? (
                      <span className="font-normal whitespace-pre-line">{s.experienceNote}</span>
                    ) : (
                      "Not given"
                    )}
                  </Detail>
                  <Detail label="LinkedIn">{s.linkedinUrl ? <ExternalLink href={s.linkedinUrl} /> : "Not given"}</Detail>
                  <Detail label="Portfolio or GitHub">{s.portfolioUrl ? <ExternalLink href={s.portfolioUrl} /> : "Not given"}</Detail>
                  {app.source && <Detail label="How they heard about the job">{app.source}</Detail>}
                </dl>
              ) : (
                <p className="text-[13px] text-fg-muted">No details were stored with this application.</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Resume and documents</CardTitle>
            </CardHeader>
            <CardBody>
              {!auth.permissions.has("document:read") ? (
                <p className="text-[13px] text-fg-muted">Your role does not include viewing candidate documents.</p>
              ) : app.documents.length === 0 ? (
                <p className="text-[13px] text-fg-muted">No resume was attached to this application.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {app.documents.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="flex min-w-0 items-center gap-2 text-[13px]">
                        <FileText className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                        <span className="truncate font-medium text-fg">{d.name}</span>
                        <span className="shrink-0 text-fg-muted">{formatFileSize(d.sizeBytes)}</span>
                      </span>
                      {/* A plain link to the permission-checked download route; the file has no public address. */}
                      <a href={`/api/documents/${d.id}`} download className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-accent-fg hover:underline">
                        <Download className="size-4" aria-hidden />
                        Download
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Internal notes</CardTitle>
                <CardDescription>Only your team sees these.</CardDescription>
              </div>
            </CardHeader>
            <CardBody className="space-y-4">
              {canNote && <NoteForm applicationId={app.id} />}
              {app.notes.length === 0 ? (
                <p className="text-[13px] text-fg-muted">No notes yet.</p>
              ) : (
                <ul className="space-y-3">
                  {app.notes.map((n) => (
                    <li key={n.id} className="rounded-md border border-border bg-surface-muted/50 px-3 py-2.5">
                      <p className="text-sm whitespace-pre-line text-fg">{n.body}</p>
                      <p className="mt-1.5 text-xs text-fg-muted">
                        {n.authorName ?? "A former team member"} · {formatDateTime(n.createdAt, timezone)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          {canMove && (
            <Card>
              <CardHeader>
                <CardTitle>Status</CardTitle>
              </CardHeader>
              <CardBody>
                <StageMover applicationId={app.id} stage={app.stage} />
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Responsible HR person</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3 text-[13px]">
              <p>
                <span className="font-medium text-fg">{app.recruiter?.name ?? "Unassigned"}</span>
                {app.recruiter && app.assignedAt && <span className="text-fg-muted"> · since {formatDate(app.assignedAt, timezone)}</span>}
              </p>
              {canAssign && <RecruiterPicker applicationId={app.id} currentId={app.recruiter?.id ?? null} recruiters={recruiters} />}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Links</CardTitle>
            </CardHeader>
            <CardBody className="space-y-2 text-[13px]">
              {canSeeCandidate && (
                <p>
                  <Link href={`/recruitment/candidates/${app.candidate.id}`} className="font-medium text-accent-fg hover:underline">
                    Candidate profile
                  </Link>
                  <span className="text-fg-muted"> · all of {app.candidate.name}&apos;s applications</span>
                </p>
              )}
              {auth.permissions.has("job:read") && (
                <p>
                  <Link href={`/recruitment/jobs/${app.job.id}`} className="font-medium text-accent-fg hover:underline">
                    {app.job.title}
                  </Link>
                  <span className="text-fg-muted"> · the job opening</span>
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Activity</CardTitle>
                <CardDescription>Every change, newest first. Entries cannot be edited.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              <ol className="space-y-4">
                {timeline.map((t) => (
                  <li key={t.id} className="relative border-l-2 border-border pl-3 text-[13px]">
                    <p className="font-medium text-fg">{t.title}</p>
                    {t.detail && <p className="mt-0.5 whitespace-pre-line text-fg">“{t.detail}”</p>}
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {t.by ?? "A former team member"} · {formatDateTime(t.at, timezone)}
                    </p>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-0.5 min-w-0 font-medium break-words text-fg">{children}</dd>
    </div>
  );
}

// Links typed by candidates open in a new tab without giving that site any handle on ours.
function ExternalLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-accent-fg hover:underline">
      {href.replace(/^https:\/\//, "")}
    </a>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading application">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-14" />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    </div>
  );
}
