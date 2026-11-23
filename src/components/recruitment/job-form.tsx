"use client";

import Link from "next/link";
import { type ReactNode, useActionState, useId, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/recruitment/form-state";
import { COMPENSATION_PERIODS, EMPLOYMENT_TYPES, JOB_LIMITS, JOB_VISIBILITIES, WORK_MODES } from "@/lib/recruitment/job-input";
import { EMPLOYMENT_TYPE_LABELS, VISIBILITY_LABELS, WORK_MODE_LABELS } from "@/lib/recruitment/labels";

export type JobFormValues = Record<string, string | undefined>;

// One form for creating and editing a job opening. It works before JavaScript loads (a plain form post);
// once loaded, errors appear without a page reload and what was typed is kept.
export function JobForm({ action, initial, departments, currency, submitLabel, cancelHref }: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  initial: JobFormValues;
  departments: { id: string; name: string }[];
  currency: string;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  const values = state.values ?? initial;
  const errors = state.fieldErrors;
  const [employmentType, setEmploymentType] = useState(values.employmentType ?? "FULL_TIME");
  // After a failed submit the form is re-created with what was typed (the key changes),
  // because React resets uncontrolled fields once an action has run.
  const formKey = state.values ? JSON.stringify(state.values) : "initial";

  return (
    <form key={formKey} action={formAction} noValidate className="space-y-6">
      {state.message && <Alert tone="danger">{state.message}</Alert>}

      <Section title="The role" description="What candidates see first.">
        <Field name="title" label="Job title" error={errors.title}>
          {(p) => <Input {...p} defaultValue={values.title} maxLength={JOB_LIMITS.title} required placeholder="e.g. Barista" />}
        </Field>
        <Field name="description" label="Description" hint="Responsibilities, a typical day, and what makes the role worth applying for." error={errors.description}>
          {(p) => <Textarea {...p} defaultValue={values.description} rows={8} maxLength={JOB_LIMITS.description} required />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="departmentId" label="Department" hint={departments.length === 0 ? "No departments have been set up yet." : undefined} error={errors.departmentId}>
            {(p) => (
              <Select {...p} defaultValue={values.departmentId ?? ""} disabled={departments.length === 0}>
                <option value="">No department</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field name="location" label="Location" error={errors.location}>
            {(p) => <Input {...p} defaultValue={values.location} maxLength={JOB_LIMITS.location} placeholder="e.g. Indore" />}
          </Field>
        </div>
      </Section>

      <Section title="Terms" description="How and where the person will work.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field name="employmentType" label="Employment type" error={errors.employmentType}>
            {(p) => (
              <Select {...p} value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EMPLOYMENT_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field name="workMode" label="Work mode" error={errors.workMode}>
            {(p) => (
              <Select {...p} defaultValue={values.workMode ?? "ON_SITE"}>
                {WORK_MODES.map((m) => (
                  <option key={m} value={m}>
                    {WORK_MODE_LABELS[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field name="openingsCount" label="Openings" error={errors.openingsCount}>
            {(p) => <Input {...p} defaultValue={values.openingsCount ?? "1"} inputMode="numeric" />}
          </Field>
        </div>
        {employmentType === "INTERNSHIP" && (
          <div className="sm:w-1/3">
            <Field name="internshipMonths" label="Internship length (months)" error={errors.internshipMonths}>
              {(p) => <Input {...p} defaultValue={values.internshipMonths} inputMode="numeric" />}
            </Field>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field name="compensationMin" label={`Minimum pay (${currency})`} error={errors.compensationMin}>
            {(p) => <Input {...p} defaultValue={values.compensationMin} inputMode="decimal" />}
          </Field>
          <Field name="compensationMax" label={`Maximum pay (${currency})`} error={errors.compensationMax}>
            {(p) => <Input {...p} defaultValue={values.compensationMax} inputMode="decimal" />}
          </Field>
          <Field name="compensationPeriod" label="Paid" error={errors.compensationPeriod}>
            {(p) => (
              <Select {...p} defaultValue={values.compensationPeriod ?? ""}>
                <option value="">Not shown</option>
                {COMPENSATION_PERIODS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Section>

      <Section title="Requirements" description="Helps candidates decide whether to apply.">
        <Field name="requiredSkills" label="Skills" hint="Separate skills with commas." error={errors.requiredSkills}>
          {(p) => <Input {...p} defaultValue={values.requiredSkills} placeholder="e.g. Espresso, Latte art, Customer service" />}
        </Field>
        <Field name="qualifications" label="Qualifications" error={errors.qualifications}>
          {(p) => <Textarea {...p} defaultValue={values.qualifications} rows={3} maxLength={JOB_LIMITS.qualifications} />}
        </Field>
        <Field name="experienceRequirement" label="Experience" error={errors.experienceRequirement}>
          {(p) => <Input {...p} defaultValue={values.experienceRequirement} maxLength={JOB_LIMITS.experience} placeholder="e.g. 1+ year in a café" />}
        </Field>
      </Section>

      <Section title="Publishing" description="Saving keeps the job as it is; publish it from the job page when it is ready.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="visibility" label="Who can see it" error={errors.visibility}>
            {(p) => (
              <Select {...p} defaultValue={values.visibility ?? "PUBLIC"}>
                {JOB_VISIBILITIES.map((v) => (
                  <option key={v} value={v}>
                    {VISIBILITY_LABELS[v]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field name="applicationDeadline" label="Application deadline" hint="Applications close at the end of this day." error={errors.applicationDeadline}>
            {(p) => <Input {...p} type="date" defaultValue={values.applicationDeadline} />}
          </Field>
        </div>
      </Section>

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

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">{children}</CardBody>
    </Card>
  );
}

type FieldProps = { id: string; name: string; "aria-invalid"?: true; "aria-describedby"?: string };

function Field({ name, label, hint, error, children }: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  children: (props: FieldProps) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children({ id, name, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {hint && (
        <p id={hintId} className="text-xs text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
