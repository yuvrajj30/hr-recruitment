import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { type ReactNode, Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { BACKUP_RETENTION_DAYS, MINIMUM_APPLICANT_AGE, PRIVACY_NOTICE_VERSION } from "@/lib/recruitment/privacy-rules";
import { getPublicOrganization } from "@/lib/recruitment/public-jobs";

// The candidate privacy notice of one organisation. Built from the organisation's own settings (the name it
// is given in, the privacy contact and the retention period) and from what HRSM actually collects.
// The wording must be reviewed by a lawyer before it is relied on in production.

export const metadata: Metadata = { title: "Privacy notice · Careers" };

export default function PrivacyNoticePage(props: PageProps<"/careers/[orgSlug]/privacy">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Notice params={props.params} />
    </Suspense>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="space-y-2">
    <h2 className="text-base font-semibold text-fg">{title}</h2>
    <div className="space-y-2 text-sm leading-relaxed text-fg-muted">{children}</div>
  </section>
);

async function Notice({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  await connection();
  const org = await getPublicOrganization(getAuthRuntime().db, orgSlug);
  if (!org) notFound();
  const who = org.privacyNoticeName ?? org.name;
  const months = org.candidateRetentionMonths;
  const contact = org.privacyContactEmail;

  return (
    <div className="space-y-6">
      <header>
        <Link href={`/careers/${org.slug}`} className="text-sm font-medium text-accent-fg">
          Careers at {org.name}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">Candidate privacy notice</h1>
        <p className="mt-2 text-sm text-fg-muted">How {who} handles the details you give when you apply for a job. Version {PRIVACY_NOTICE_VERSION}.</p>
      </header>

      {!contact && (
        <Alert tone="warning">
          {who} has not published a privacy contact yet. Until it does, quote your application reference number to the person who is handling your
          application.
        </Alert>
      )}

      <Card>
        <CardBody className="space-y-6">
          <Section title="Who is responsible">
            <p>
              {who} decides how your application details are used. They are stored in {who}&apos;s recruitment system on its behalf, and only {who}&apos;s
              HR staff (its Super Admins and HR Managers) can see them.
            </p>
          </Section>

          <Section title="What we collect">
            <ul className="list-disc space-y-1 pl-5">
              <li>Your name, email address and phone number.</li>
              <li>If you give them: your city, education (college, course, qualification, graduation year), skills, most recent job, and links to LinkedIn or a portfolio.</li>
              <li>Your resume, and where you heard about the job.</li>
              <li>The job you applied for, when you applied, your application reference number, and how your application progresses.</li>
              <li>Notes {who}&apos;s HR staff add while considering your application.</li>
            </ul>
            <p>We do not ask for your date of birth, and we do not record your IP address or browser when you apply.</p>
          </Section>

          <Section title="Why we use it">
            <p>
              Only to consider you for the job you applied for and to contact you about it. Your details are not sold, not shared for marketing, and not
              used for advertising or tracking.
            </p>
          </Section>

          <Section title="Who can apply">
            <p>You must be at least {MINIMUM_APPLICANT_AGE} years old to apply. Please do not apply if you are younger.</p>
          </Section>

          <Section title="How long we keep it">
            <p>
              If you are not hired, your personal details and resume are removed {months} month{months === 1 ? "" : "s"} after your last application with{" "}
              {who} was closed. Copies in security backups are deleted within a further {BACKUP_RETENTION_DAYS} days. What remains is only a record that an
              application was made and how far it got, with nothing that identifies you.
            </p>
            <p>If you are hired, your details become part of your employee records.</p>
          </Section>

          <Section title="Your choices">
            <p>You can ask {who} at any time to:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>tell you what it holds about you,</li>
              <li>correct anything that is wrong,</li>
              <li>remove your details, or stop considering your application (withdraw your consent).</li>
            </ul>
            <p>
              {contact ? (
                <>
                  Write to{" "}
                  <a href={`mailto:${contact}`} className="font-medium text-accent-fg underline">
                    {contact}
                  </a>{" "}
                  and include your application reference number if you have it.
                </>
              ) : (
                <>Contact the person handling your application and quote your application reference number.</>
              )}
            </p>
          </Section>

          <Section title="Questions and complaints">
            <p>
              {contact ? <>Send any question or complaint about how your details are handled to {contact}.</> : <>Ask the person handling your application.</>}{" "}
              If you are not satisfied with the answer, you may also complain to the Data Protection Board of India.
            </p>
          </Section>
        </CardBody>
      </Card>
    </div>
  );
}
