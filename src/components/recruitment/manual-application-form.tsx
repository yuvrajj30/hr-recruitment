"use client";

import Link from "next/link";
import { useActionState } from "react";
import { createApplicationAction } from "@/app/(app)/recruitment/application-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { APPLICATION_LIMITS } from "@/lib/recruitment/application-input";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";
import { MINIMUM_APPLICANT_AGE } from "@/lib/recruitment/privacy-rules";
import { ApplicationFields } from "./application-fields";
import { FormField, FormSection } from "./form-bits";

// HR entering an application for someone who applied in person, by phone or by email.
// The candidate fields are the same component the public page uses.
export function ManualApplicationForm({ jobs, defaultJobId }: { jobs: { id: string; title: string }[]; defaultJobId?: string }) {
  const [state, formAction, pending] = useActionState(createApplicationAction, EMPTY_FORM_STATE);
  const values = state.values ?? { jobId: defaultJobId };
  const errors = state.fieldErrors;

  return (
    <form key={state.values ? JSON.stringify(state.values) : "initial"} action={formAction} noValidate className="space-y-6">
      {state.message && <Alert tone="danger">{state.message}</Alert>}

      <FormSection title="Job" description="Applications can be added to published jobs.">
        <FormField name="jobId" label="Applying for" error={errors.jobId} hint={jobs.length === 0 ? "There are no published jobs. Publish a job first." : undefined}>
          {(p) => (
            <Select {...p} defaultValue={values.jobId ?? ""} required>
              <option value="">Choose a job…</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField name="source" label="How did they apply or hear about the job?" optional error={errors.source}>
          {(p) => <Input {...p} defaultValue={values.source} maxLength={APPLICATION_LIMITS.source} placeholder="e.g. Walk-in, referral from a staff member, WhatsApp" />}
        </FormField>
      </FormSection>

      <ApplicationFields values={values} errors={errors} voice="staff" resumeRequired={false} />

      <Card>
        <CardBody className="space-y-3">
          <label className="flex items-start gap-2.5 text-sm text-fg">
            <input type="checkbox" name="ageConfirmed" value="yes" required className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" aria-invalid={errors.ageConfirmed ? true : undefined} />
            <span>The candidate has confirmed they are at least {MINIMUM_APPLICANT_AGE} years old.</span>
          </label>
          {errors.ageConfirmed && <p className="text-xs font-medium text-danger">{errors.ageConfirmed}</p>}
          <label className="flex items-start gap-2.5 text-sm text-fg">
            <input type="checkbox" name="consent" value="yes" required className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" aria-invalid={errors.consent ? true : undefined} />
            <span>The candidate has agreed that their details and resume may be kept and used to consider them for this job, as described in the organisation&apos;s candidate privacy notice.</span>
          </label>
          {errors.consent && <p className="text-xs font-medium text-danger">{errors.consent}</p>}
          <p className="text-xs text-fg-muted">
            If this email address has applied before, the application is added to that person&apos;s existing profile. No second profile is created.
          </p>
        </CardBody>
      </Card>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" asChild>
          <Link href="/recruitment/applications">Cancel</Link>
        </Button>
        <Button type="submit" loading={pending} disabled={jobs.length === 0}>
          Add application
        </Button>
      </div>
    </form>
  );
}
