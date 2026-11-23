"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { FormField, FormSection } from "@/components/recruitment/form-bits";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { DURATION_CHOICES, INTERVIEW_LIMITS, INTERVIEW_TYPE_LABELS, INTERVIEW_TYPES, type InterviewType } from "@/lib/interviews/rules";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/recruitment/form-state";

// Scheduling a new interview, or changing a scheduled one. The times are the organisation's local time; the
// server converts them and checks everything again.

export type ScheduleFormValues = Record<string, string | undefined>;

export function ScheduleForm({
  action,
  initial,
  interviewers,
  timeZone,
  submitLabel,
  cancelHref,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  initial: ScheduleFormValues;
  interviewers: { id: string; name: string }[];
  timeZone: string;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  const values = state.values ?? initial;
  const errors = state.fieldErrors;
  const [type, setType] = useState<InterviewType>((values.type as InterviewType) || "IN_PERSON");
  const chosen = new Set((values.participantIds ?? "").split(",").filter(Boolean));
  // React resets uncontrolled fields after an action; a new key re-applies the returned values.
  const formKey = state.values ? JSON.stringify(state.values) : "initial";
  const durationValue = values.duration || "45";

  return (
    <form key={formKey} action={formAction} noValidate className="space-y-6">
      {state.message && <Alert tone="danger">{state.message}</Alert>}

      <FormSection title="When and how" description={`Times are in the organisation's time zone (${timeZone}).`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="start" label="Date and time" error={errors.start}>
            {(p) => <Input {...p} type="datetime-local" defaultValue={values.start} required />}
          </FormField>
          <FormField name="duration" label="Length" error={errors.duration}>
            {(p) => (
              <Select {...p} defaultValue={durationValue}>
                {!DURATION_CHOICES.includes(Number(durationValue) as (typeof DURATION_CHOICES)[number]) && <option value={durationValue}>{durationValue} minutes</option>}
                {DURATION_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
        <FormField name="type" label="Kind of interview" error={errors.type}>
          {(p) => (
            <Select {...p} defaultValue={type} onChange={(e) => setType(e.target.value as InterviewType)}>
              {INTERVIEW_TYPES.map((t) => (
                <option key={t} value={t}>
                  {INTERVIEW_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        {type === "IN_PERSON" && (
          <FormField name="location" label="Where" hint="For example the outlet's address, or which room." error={errors.location}>
            {(p) => <Input {...p} defaultValue={values.location} maxLength={INTERVIEW_LIMITS.location} />}
          </FormField>
        )}
        {type === "ONLINE" && (
          <FormField name="meetingLink" label="Meeting link" hint="Starts with https://" error={errors.meetingLink}>
            {(p) => <Input {...p} type="url" inputMode="url" defaultValue={values.meetingLink} maxLength={INTERVIEW_LIMITS.meetingLink} placeholder="https://" />}
          </FormField>
        )}
        <FormField name="roundName" label="Name of this round" optional hint="For example “Trial shift” or “Manager interview”." error={errors.roundName}>
          {(p) => <Input {...p} defaultValue={values.roundName} maxLength={INTERVIEW_LIMITS.roundName} />}
        </FormField>
      </FormSection>

      <FormSection title="Interviewers" description="HR Managers and Super Admins. Each gives their own feedback, which colleagues see once they have submitted theirs. Interviewers can be changed until the interview starts.">
        {interviewers.length === 0 ? (
          <p className="text-[13px] text-fg-muted">Nobody in this organisation is an active HR Manager or Super Admin.</p>
        ) : (
          <fieldset aria-describedby={errors.participantIds ? "participants-error" : undefined}>
            <legend className="sr-only">Interviewers</legend>
            <ul className="grid gap-2 sm:grid-cols-2">
              {interviewers.map((i) => (
                <li key={i.id}>
                  <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px] hover:bg-surface-muted/60">
                    <input type="checkbox" name="participantIds" value={i.id} defaultChecked={chosen.has(i.id)} className="size-4 shrink-0 accent-[var(--accent)]" />
                    <span className="font-medium text-fg">{i.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            {errors.participantIds && (
              <p id="participants-error" className="mt-2 text-xs font-medium text-danger">
                {errors.participantIds}
              </p>
            )}
          </fieldset>
        )}
      </FormSection>

      <FormSection title="Notes for the interviewers" description="Internal only. The candidate never sees these.">
        <FormField name="instructions" label="Notes" optional error={errors.instructions}>
          {(p) => <Textarea {...p} rows={4} defaultValue={values.instructions} maxLength={INTERVIEW_LIMITS.instructions} />}
        </FormField>
      </FormSection>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" asChild>
          <Link href={cancelHref}>Cancel</Link>
        </Button>
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
