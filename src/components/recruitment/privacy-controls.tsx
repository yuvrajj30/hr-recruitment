"use client";

import { useActionState, useRef, useState } from "react";
import { removeCandidateAction, savePrivacySettingsAction } from "@/app/(app)/recruitment/privacy-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";
import { RETENTION_MONTHS } from "@/lib/recruitment/privacy-rules";
import { FormField } from "./form-bits";

// The organisation's candidate privacy settings (Super Admins).
export function PrivacySettingsForm({ noticeName, contactEmail, retentionMonths }: { noticeName: string; contactEmail: string; retentionMonths: number }) {
  const [state, action, pending] = useActionState(savePrivacySettingsAction, EMPTY_FORM_STATE);
  const values = state.values ?? {};
  const errors = state.fieldErrors;
  return (
    <form action={action} className="space-y-4" key={state.done ?? 0}>
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      {(state.done ?? 0) > 0 && !state.message && <Alert tone="success">Saved. The privacy notice now shows these details.</Alert>}
      <FormField name="noticeName" label="Name the notice is given in" hint="Usually the organisation's legal or trading name." error={errors.noticeName} optional>
        {(p) => <Input {...p} defaultValue={values.noticeName ?? noticeName} maxLength={160} />}
      </FormField>
      <FormField name="contactEmail" label="Privacy contact email" hint="For candidates' requests and complaints. Shown on the privacy notice." error={errors.contactEmail} optional>
        {(p) => <Input {...p} type="email" defaultValue={values.contactEmail ?? contactEmail} maxLength={254} />}
      </FormField>
      <FormField
        name="retentionMonths"
        label="Keep candidates who were not hired for (months)"
        hint="Counted from when their last application was closed. After that they appear in the list below."
        error={errors.retentionMonths}
      >
        {(p) => <Input {...p} type="number" min={RETENTION_MONTHS.min} max={RETENTION_MONTHS.max} step={1} defaultValue={values.retentionMonths ?? String(retentionMonths)} className="w-32" />}
      </FormField>
      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}

// Removes one candidate's personal data after a clear, permanent-action confirmation.
export function RemoveCandidateButton({ candidateId, name, size = "sm" }: { candidateId: string; name: string; size?: "sm" | "md" }) {
  const [state, action, pending] = useActionState(removeCandidateAction, EMPTY_FORM_STATE);
  const [confirming, setConfirming] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <div className="space-y-2">
      <form ref={formRef} action={action} onSubmit={() => setConfirming(false)}>
        <input type="hidden" name="candidateId" value={candidateId} />
        <Button type="button" variant="danger" size={size} disabled={pending} onClick={() => setConfirming(true)}>
          Remove personal data
        </Button>
      </form>
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      {confirming && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(false)}
          title={`Remove ${name}'s personal data?`}
          description="Their details, resume and notes are deleted for good, and they disappear from every list. Only a record that the applications were made remains, with nothing that identifies them. This cannot be undone."
          confirmLabel="Remove permanently"
          tone="danger"
          busy={pending}
          onConfirm={() => formRef.current?.requestSubmit()}
        />
      )}
    </div>
  );
}
