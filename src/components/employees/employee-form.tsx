"use client";

import Link from "next/link";
import { useActionState } from "react";
import { FormField, FormSection } from "@/components/recruitment/form-bits";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { EMPLOYMENT_TYPE_LABELS, EMPLOYMENT_TYPES } from "@/lib/employees/rules";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/recruitment/form-state";

// Adding an employee, or changing one. The server checks everything again.

export type Option = { id: string; label: string };

export function EmployeeForm({
  action,
  initial,
  outlets,
  departments,
  designations,
  managers,
  submitLabel,
  cancelHref,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  initial: Record<string, string | undefined>;
  outlets: Option[];
  departments: Option[];
  designations: Option[];
  managers: Option[];
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  const values = state.values ?? initial;
  const errors = state.fieldErrors;
  // React resets uncontrolled fields after an action; a new key re-applies the returned values.
  const formKey = state.values ? JSON.stringify(state.values) : "initial";

  const pick = (name: string, label: string, options: Option[], emptyLabel: string) => (
    <FormField name={name} label={label} optional error={errors[name]}>
      {(p) => (
        <Select {...p} defaultValue={values[name] ?? ""}>
          <option value="">{emptyLabel}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </FormField>
  );

  return (
    <form key={formKey} action={formAction} noValidate className="space-y-6">
      {state.message && <Alert tone="danger">{state.message}</Alert>}

      <FormSection title="Who they are">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="employeeCode" label="Employee code" hint="For example TTC-014." error={errors.employeeCode}>
            {(p) => <Input {...p} defaultValue={values.employeeCode} maxLength={32} required />}
          </FormField>
          <FormField name="fullName" label="Full name" error={errors.fullName}>
            {(p) => <Input {...p} defaultValue={values.fullName} maxLength={120} required />}
          </FormField>
          <FormField name="email" label="Email" optional error={errors.email}>
            {(p) => <Input {...p} type="email" defaultValue={values.email} maxLength={254} />}
          </FormField>
          <FormField name="phone" label="Phone" optional error={errors.phone}>
            {(p) => <Input {...p} type="tel" defaultValue={values.phone} maxLength={20} />}
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Employment">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="employmentType" label="Employment type" error={errors.employmentType}>
            {(p) => (
              <Select {...p} defaultValue={values.employmentType || "FULL_TIME"}>
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EMPLOYMENT_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField name="joinedOn" label="Joining date" error={errors.joinedOn}>
            {(p) => <Input {...p} type="date" defaultValue={values.joinedOn} required />}
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Where they work" description="Changes to these are kept in the employee's assignment history.">
        <div className="grid gap-4 sm:grid-cols-2">
          {pick("outletId", "Outlet", outlets, "No outlet")}
          {pick("departmentId", "Department", departments, "No department")}
          {pick("designationId", "Designation", designations, "No designation")}
          {pick("managerId", "Manager", managers, "No manager")}
        </div>
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
