"use client";

import { CheckCircle2 } from "lucide-react";
import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/recruitment/form-state";
import { MINIMUM_APPLICANT_AGE } from "@/lib/recruitment/privacy-rules";
import { ApplicationFields } from "./application-fields";

// The application form candidates fill in. It works without JavaScript (a plain form post) and,
// with it, shows errors in place and keeps what was typed.
export function PublicApplicationForm({ action, formToken, trapField, organizationName, jobTitle, privacyHref }: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  formToken: string;
  trapField: string;
  organizationName: string;
  jobTitle: string;
  privacyHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);

  if (state.reference) {
    return (
      <Card>
        <CardBody className="flex flex-col items-center px-6 py-10 text-center" role="status">
          <CheckCircle2 className="size-10 text-success" aria-hidden />
          <h2 className="mt-3 text-lg font-semibold text-fg">Application received</h2>
          <p className="mt-1 max-w-md text-sm text-fg-muted">
            Thank you for applying for {jobTitle} at {organizationName}. Please keep your reference number; quote it if you contact us about this application.
          </p>
          <p className="mt-5 text-xs font-medium tracking-wide text-fg-muted uppercase">Your reference number</p>
          <p className="tabular mt-1 rounded-md border border-border bg-surface-muted px-4 py-2 font-mono text-xl font-semibold tracking-wider text-fg select-all">{state.reference}</p>
        </CardBody>
      </Card>
    );
  }

  const values = state.values ?? {};
  const errors = state.fieldErrors;
  return (
    <form key={state.values ? JSON.stringify(state.values) : "initial"} action={formAction} noValidate className="space-y-6">
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      <input type="hidden" name="formToken" value={formToken} />
      {/* A trap for automated submissions: hidden from people and from screen readers, never to be filled in. */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Leave this field empty
          <input type="text" name={trapField} tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>

      <ApplicationFields values={values} errors={errors} voice="candidate" resumeRequired />

      <Card>
        <CardBody className="space-y-3">
          <label className="flex items-start gap-2.5 text-sm text-fg">
            <input type="checkbox" name="ageConfirmed" value="yes" required className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" aria-invalid={errors.ageConfirmed ? true : undefined} />
            <span>I am at least {MINIMUM_APPLICANT_AGE} years old.</span>
          </label>
          {errors.ageConfirmed && <p className="text-xs font-medium text-danger">{errors.ageConfirmed}</p>}
          <label className="flex items-start gap-2.5 text-sm text-fg">
            <input type="checkbox" name="consent" value="yes" required className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" aria-invalid={errors.consent ? true : undefined} />
            <span>
              I agree that {organizationName} may store and use the details and resume I have provided to consider me for this job and to contact me
              about it, as described in the{" "}
              <a href={privacyHref} target="_blank" rel="noopener" className="font-medium text-accent-fg underline">
                privacy notice
              </a>
              .
            </span>
          </label>
          {errors.consent && <p className="text-xs font-medium text-danger">{errors.consent}</p>}
          <Button type="submit" loading={pending} className="w-full sm:w-auto">
            Submit application
          </Button>
        </CardBody>
      </Card>
    </form>
  );
}
