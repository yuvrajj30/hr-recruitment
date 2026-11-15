import { ArrowLeft, Briefcase, CalendarClock, MapPin, Users, Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { type ReactNode, Suspense } from "react";
import { submitApplicationAction } from "@/app/careers/actions";
import { PublicApplicationForm } from "@/components/recruitment/public-application-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { issueFormToken, TRAP_FIELD } from "@/lib/recruitment/abuse";
import { EMPLOYMENT_TYPE_LABELS, formatDate, formatPay, WORK_MODE_LABELS } from "@/lib/recruitment/labels";
import { getPublicJob, getPublicOrganization } from "@/lib/recruitment/public-jobs";

// The public page for one job: what candidates read, and the form they apply with.
// No sign-in. Only a published, public job of an active organisation is ever shown;
// anything else (draft, internal, closed, archived, unknown) is a plain "not found".

export const metadata: Metadata = { title: "Apply · Careers", robots: { index: true, follow: true } };

export default function PublicJobPage(props: PageProps<"/careers/[orgSlug]/jobs/[jobSlug]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <JobAndForm params={props.params} />
    </Suspense>
  );
}

async function JobAndForm({ params }: { params: Promise<{ orgSlug: string; jobSlug: string }> }) {
  const { orgSlug, jobSlug } = await params;
  await connection(); // this page depends on the current time and the live database
  const rt = getAuthRuntime();
  const now = rt.now();
  const [organization, job] = await Promise.all([getPublicOrganization(rt.db, orgSlug), getPublicJob(rt.db, orgSlug, jobSlug, now)]);
  if (!organization || !job) notFound();

  const pay = formatPay(job.compensationMin, job.compensationMax, job.compensationCurrency, job.compensationPeriod);
  return (
    <div className="space-y-6">
      <Link href={`/careers/${organization.slug}`} className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        All jobs at {organization.name}
      </Link>

      <header>
        <p className="text-sm font-medium text-accent-fg">{organization.name}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">{job.title}</h1>
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-fg-muted">
          <Fact icon={<Briefcase className="size-4" aria-hidden />}>
            {[EMPLOYMENT_TYPE_LABELS[job.employmentType], WORK_MODE_LABELS[job.workMode], job.departmentName].filter(Boolean).join(" · ")}
          </Fact>
          {job.location && <Fact icon={<MapPin className="size-4" aria-hidden />}>{job.location}</Fact>}
          {pay && <Fact icon={<Wallet className="size-4" aria-hidden />}>{pay}</Fact>}
          {job.openingsCount > 1 && <Fact icon={<Users className="size-4" aria-hidden />}>{job.openingsCount} openings</Fact>}
          {job.applicationDeadline && <Fact icon={<CalendarClock className="size-4" aria-hidden />}>Apply by {formatDate(job.applicationDeadline, organization.timezone)}</Fact>}
        </ul>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>About the job</CardTitle>
        </CardHeader>
        <CardBody className="space-y-5 text-sm leading-6 text-fg">
          <p className="whitespace-pre-line">{job.description}</p>
          {job.internshipMonths && <p className="text-fg-muted">Internship length: {job.internshipMonths} month{job.internshipMonths === 1 ? "" : "s"}.</p>}
          {job.requiredSkills.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-[13px] font-semibold text-fg">Skills</h3>
              <div className="flex flex-wrap gap-1.5">
                {job.requiredSkills.map((s) => (
                  <Badge key={s}>{s}</Badge>
                ))}
              </div>
            </div>
          )}
          {job.experienceRequirement && (
            <div>
              <h3 className="mb-1 text-[13px] font-semibold text-fg">Experience</h3>
              <p>{job.experienceRequirement}</p>
            </div>
          )}
          {job.qualifications && (
            <div>
              <h3 className="mb-1 text-[13px] font-semibold text-fg">Qualifications</h3>
              <p className="whitespace-pre-line">{job.qualifications}</p>
            </div>
          )}
        </CardBody>
      </Card>

      <section aria-labelledby="apply-heading" className="space-y-4">
        <h2 id="apply-heading" className="text-lg font-semibold text-fg">
          Apply for this job
        </h2>
        {job.accepting ? (
          <PublicApplicationForm
            action={submitApplicationAction.bind(null, organization.slug, job.slug)}
            formToken={issueFormToken(rt.authSecret, `${organization.slug}/${job.slug}`, now)}
            trapField={TRAP_FIELD}
            organizationName={organization.name}
            jobTitle={job.title}
          />
        ) : (
          <Alert tone="warning">The deadline for this job has passed, so it is no longer accepting applications.</Alert>
        )}
      </section>
    </div>
  );
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className="text-fg-subtle">{icon}</span>
      {children}
    </li>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading job">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-64" />
      <Skeleton className="h-96" />
    </div>
  );
}
