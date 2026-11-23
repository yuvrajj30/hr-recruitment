import { ArrowLeft, Download, FileText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import { formatSlot, InterviewStatusBadge, roundTitle, typeLabel } from "@/components/interviews/interview-bits";
import { CandidateNotesForm } from "@/components/recruitment/application-controls";
import { listInterviewsFor } from "@/lib/interviews/interviews";
import { NoAccess, StageBadge } from "@/components/recruitment/job-bits";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { readScope } from "@/lib/auth/permissions";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { type CandidateDetail, getCandidate } from "@/lib/recruitment/candidates";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";
import { formatDate, formatFileSize } from "@/lib/recruitment/labels";
import { REMOVABLE_STAGES } from "@/lib/recruitment/privacy-rules";
import { RemoveCandidateButton } from "@/components/recruitment/privacy-controls";

export const metadata: Metadata = { title: "Candidate · HRMS" };

export default function CandidatePage(props: PageProps<"/recruitment/candidates/[candidateId]">) {
  return (
    <Suspense fallback={<Skeleton className="h-[36rem]" />}>
      <CandidateContent params={props.params} />
    </Suspense>
  );
}

async function CandidateContent({ params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId } = await params;
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/recruitment/candidates/${candidateId}`)}&reason=expired`);
  if (readScope(auth.permissions, "candidate") === "none") return <NoAccess what="view candidates" />;

  const db = getAuthRuntime().db;
  let c: CandidateDetail;
  try {
    c = await getCandidate(db, auth, candidateId);
  } catch (error) {
    if (error instanceof RecruitmentError && error.code === "not_found") notFound();
    throw error;
  }
  const [{ timezone }, interviews] = await Promise.all([
    getOrganizationSettings(db, auth),
    auth.permissions.has("interview:read") ? listInterviewsFor(db, auth, { organizationCandidateId: c.id }) : Promise.resolve(null),
  ]);
  const latest = c.latest;
  const canEditNotes = auth.permissions.has("candidate:update");
  const canRemove = auth.permissions.has("candidate:delete");
  // Removal is possible once every application is closed without a hire (the database checks this again).
  const removable = c.applications.every((a) => (REMOVABLE_STAGES as readonly string[]).includes(a.stage));

  return (
    <div className="space-y-6">
      <Link href="/recruitment/candidates" className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        Candidates
      </Link>

      <PageHeader title={c.name} description={`${c.applications.length} application${c.applications.length === 1 ? "" : "s"} · first applied ${formatDate(c.firstSeenAt, timezone)}`} />

      {c.possibleDuplicates.length > 0 && (
        <Alert tone="warning">
          Possibly the same person under another email (same phone number):{" "}
          {c.possibleDuplicates.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ", "}
              <Link href={`/recruitment/candidates/${d.id}`} className="font-medium underline">
                {d.name}
              </Link>{" "}
              ({d.email})
            </span>
          ))}
          . The profiles are kept separate because this cannot be confirmed automatically.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Personal information</CardTitle>
                {c.latestFrom && <CardDescription>From their most recent application ({c.latestFrom.referenceNumber}, {formatDate(c.latestFrom.appliedAt, timezone)}).</CardDescription>}
              </div>
            </CardHeader>
            <CardBody>
              <dl className="grid gap-x-6 gap-y-4 text-[13px] sm:grid-cols-2">
                <Detail label="Full name">{c.name}</Detail>
                <Detail label="Email">
                  <a href={`mailto:${c.email}`} className="text-accent-fg hover:underline">
                    {c.email}
                  </a>
                </Detail>
                <Detail label="Phone">{latest?.phone || c.phone || "Not given"}</Detail>
                <Detail label="City">{latest?.city ?? "Not given"}</Detail>
                <Detail label="LinkedIn">{latest?.linkedinUrl ? <ExternalLink href={latest.linkedinUrl} /> : "Not given"}</Detail>
                <Detail label="Portfolio or GitHub">{latest?.portfolioUrl ? <ExternalLink href={latest.portfolioUrl} /> : "Not given"}</Detail>
                {latest && latest.fullName !== c.name && <Detail label="Name used on the latest application">{latest.fullName}</Detail>}
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Education</CardTitle>
            </CardHeader>
            <CardBody>
              {c.educations.length === 0 ? (
                <p className="text-[13px] text-fg-muted">No education details given.</p>
              ) : (
                <ul className="space-y-3 text-[13px]">
                  {c.educations.map((e, i) => (
                    <li key={i}>
                      <p className="font-medium text-fg">{e.institution}</p>
                      <p className="text-fg-muted">{[e.degree, e.course, e.graduationYear ? `graduating ${e.graduationYear}` : null].filter(Boolean).join(" · ") || "No further details"}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Skills and experience</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4 text-[13px]">
              {c.skills.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {c.skills.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </div>
              ) : (
                <p className="text-fg-muted">No skills listed.</p>
              )}
              {c.experiences.map((e, i) => (
                <div key={i}>
                  <p className="font-medium text-fg">
                    {e.title} at {e.company}
                  </p>
                  {e.description && <p className="mt-0.5 whitespace-pre-line text-fg-muted">{e.description}</p>}
                </div>
              ))}
              {c.experiences.length === 0 && latest?.experienceNote && <p className="whitespace-pre-line text-fg">{latest.experienceNote}</p>}
              {c.experiences.length === 0 && !latest?.experienceNote && <p className="text-fg-muted">No experience given.</p>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Applications</CardTitle>
                <CardDescription>Every job this person has applied for at your organisation.</CardDescription>
              </div>
            </CardHeader>
            {c.applications.length === 0 ? (
              <CardBody>
                <p className="text-[13px] text-fg-muted">No applications you can see.</p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-border">
                {c.applications.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3 text-[13px]">
                    <div className="min-w-0">
                      <Link href={`/recruitment/applications/${a.id}`} className="font-medium text-fg hover:text-accent hover:underline">
                        {a.job.title}
                      </Link>
                      <p className="mt-0.5 text-xs text-fg-muted">
                        <span className="font-mono">{a.referenceNumber}</span> · applied {formatDate(a.appliedAt, timezone)} · {a.recruiterName ?? "unassigned"}
                      </p>
                    </div>
                    <StageBadge stage={a.stage} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Interview history</CardTitle>
                <CardDescription>Every interview across this person&apos;s applications, newest first.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              {interviews === null ? (
                <p className="text-[13px] text-fg-muted">Your role does not include viewing interviews.</p>
              ) : interviews.length === 0 ? (
                <p className="text-[13px] text-fg-muted">No interviews recorded.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {interviews.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px] first:pt-0 last:pb-0">
                      <span className="min-w-0">
                        <Link href={`/interviews/${i.id}`} className="font-medium text-fg hover:text-accent hover:underline">
                          {i.jobTitle} · {roundTitle(i.roundNumber, i.roundName)}
                        </Link>
                        <span className="block text-xs text-fg-muted">
                          {formatSlot(i.start, i.end, timezone)} · {typeLabel(i.type)}
                        </span>
                      </span>
                      <InterviewStatusBadge status={i.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Resume and documents</CardTitle>
            </CardHeader>
            <CardBody>
              {!auth.permissions.has("document:read") ? (
                <p className="text-[13px] text-fg-muted">Your role does not include viewing candidate documents.</p>
              ) : c.documents.length === 0 ? (
                <p className="text-[13px] text-fg-muted">No documents on file.</p>
              ) : (
                <ul className="space-y-3">
                  {c.documents.map((d) => (
                    <li key={d.id} className="text-[13px]">
                      <a href={`/api/documents/${d.id}`} download className="inline-flex items-center gap-1.5 font-medium text-accent-fg hover:underline">
                        <FileText className="size-4 shrink-0" aria-hidden />
                        <span className="break-all">{d.name}</span>
                        <Download className="size-3.5 shrink-0" aria-hidden />
                      </a>
                      <p className="mt-0.5 text-xs text-fg-muted">
                        {formatFileSize(d.sizeBytes)} · with {d.applicationReference} · {formatDate(d.uploadedAt, timezone)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {canRemove && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Remove personal data</CardTitle>
                  <CardDescription>
                    For a candidate who asks to be removed, or whose data is no longer needed. Their details, resume and notes are deleted for good.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardBody>
                {removable ? (
                  <RemoveCandidateButton candidateId={c.id} name={c.name} />
                ) : (
                  <p className="text-[13px] text-fg-muted">
                    Not possible while an application is still open or ended in a hire. Reject or withdraw their open applications first.
                  </p>
                )}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Internal HR notes</CardTitle>
                <CardDescription>About the person, across all their applications. Only your team sees these.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              {canEditNotes ? (
                <CandidateNotesForm candidateId={c.id} notes={c.notes ?? ""} />
              ) : (
                <p className="text-[13px] whitespace-pre-line text-fg">{c.notes || <span className="text-fg-muted">No notes.</span>}</p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-0.5 min-w-0 font-medium break-words text-fg">{children}</dd>
    </div>
  );
}

function ExternalLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-accent-fg hover:underline">
      {href.replace(/^https:\/\//, "")}
    </a>
  );
}
