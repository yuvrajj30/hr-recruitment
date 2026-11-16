import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/recruitment/job-bits";
import { PrivacySettingsForm, RemoveCandidateButton } from "@/components/recruitment/privacy-controls";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { readScope } from "@/lib/auth/permissions";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";
import { formatDate } from "@/lib/recruitment/labels";
import { getPrivacySettings, listDueForRemoval } from "@/lib/recruitment/privacy";
import { BACKUP_RETENTION_DAYS, MINIMUM_APPLICANT_AGE, privacyNoticePath } from "@/lib/recruitment/privacy-rules";

// Candidate privacy: the organisation's notice settings and the candidates whose personal data is due for removal.

export const metadata: Metadata = { title: "Candidate privacy · HRMS" };

export default function PrivacyPage(props: PageProps<"/recruitment/privacy">) {
  return (
    <Suspense fallback={<Skeleton className="h-[30rem]" />}>
      <PrivacyContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function PrivacyContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Frecruitment%2Fprivacy&reason=expired");
  if (readScope(auth.permissions, "candidate") === "none") return <NoAccess what="view candidate privacy settings" />;

  const sp = await searchParams;
  const rt = getAuthRuntime();
  const now = rt.now();
  const settings = await getPrivacySettings(rt.db, auth);
  const { timezone } = await getOrganizationSettings(rt.db, auth);
  const due = settings.canRemove ? await listDueForRemoval(rt.db, auth, now) : null;
  const slug = auth.organization?.slug ?? "";
  const filesLeft = Number(typeof sp.filesLeft === "string" ? sp.filesLeft : 0) || 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Candidate privacy"
        description={`What candidates are told, how long their details are kept, and who is due for removal. Applicants must be at least ${MINIMUM_APPLICANT_AGE}.`}
      />

      {sp.removed === "1" && (
        <Alert tone={filesLeft > 0 ? "warning" : "success"}>
          {filesLeft > 0
            ? `The candidate's personal data was removed, but ${filesLeft} file${filesLeft === 1 ? "" : "s"} could not be deleted from storage. They are no longer reachable; ask an administrator to delete them (they are listed in the server log).`
            : "The candidate's personal data was removed."}
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Privacy notice</CardTitle>
            <CardDescription>
              Shown to candidates at{" "}
              <Link href={privacyNoticePath(slug)} target="_blank" className="font-medium text-accent-fg underline">
                {privacyNoticePath(slug)}
              </Link>{" "}
              and linked from every application form. Backups that may still contain removed candidates are deleted after {BACKUP_RETENTION_DAYS} days.
            </CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {!settings.contactEmail && <Alert tone="warning" className="mb-4">No privacy contact is set yet. Candidates are told to contact the person handling their application instead.</Alert>}
          {settings.canEdit ? (
            <PrivacySettingsForm noticeName={settings.noticeName ?? ""} contactEmail={settings.contactEmail ?? ""} retentionMonths={settings.retentionMonths} />
          ) : (
            <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
              <div>
                <dt className="text-fg-muted">Name on the notice</dt>
                <dd className="font-medium text-fg">{settings.noticeName ?? settings.organizationName}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">Privacy contact</dt>
                <dd className="font-medium text-fg">{settings.contactEmail ?? "Not set"}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">Candidates kept for</dt>
                <dd className="font-medium text-fg">{settings.retentionMonths} months</dd>
              </div>
              <p className="text-fg-muted sm:col-span-3">Only a Super Admin can change these.</p>
            </dl>
          )}
        </CardBody>
      </Card>

      {due && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Due for removal</CardTitle>
              <CardDescription>
                People whose applications were all closed without a hire more than {due.retentionMonths} months ago (before {formatDate(due.cutoff, timezone)}).
                Review each one, then remove their personal data. Anyone can also be removed earlier from their candidate page, for example when they ask.
              </CardDescription>
            </div>
          </CardHeader>
          {due.items.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="Nobody is due for removal" description="Candidates appear here once the retention period has passed." />
          ) : (
            <ul className="divide-y divide-border">
              {due.items.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3 text-[13px]">
                  <div className="min-w-0">
                    <Link href={`/recruitment/candidates/${d.id}`} className="font-medium text-fg hover:text-accent hover:underline">
                      {d.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {d.email} · {d.applications} application{d.applications === 1 ? "" : "s"} · last closed {formatDate(d.lastClosedAt, timezone)}
                    </p>
                  </div>
                  <RemoveCandidateButton candidateId={d.id} name={d.name} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
