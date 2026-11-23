"use client";

import { type ComponentProps, type ReactNode, useId } from "react";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Select } from "@/components/ui/input";
import type { FormState } from "@/lib/recruitment/form-state";
import { cn } from "@/lib/ui/cn";

// Small pieces shared by the attendance forms: a labelled field with its error, and the message under a form.

function FieldShell({ id, label, error, hint, className, children }: { id: string; label: string; error?: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-fg-muted">{hint}</p>}
      {error && (
        <p id={`${id}-e`} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

type Shared = { label: string; name: string; error?: string; hint?: string; className?: string };

export function TextField({ label, name, error, hint, className, ...input }: Shared & Omit<ComponentProps<"input">, "name">) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} error={error} hint={hint} className={className}>
      <Input id={id} name={name} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined} {...input} />
    </FieldShell>
  );
}

export function SelectField({ label, name, error, hint, className, children, ...select }: Shared & Omit<ComponentProps<"select">, "name">) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} error={error} hint={hint} className={className}>
      <Select id={id} name={name} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined} {...select}>
        {children}
      </Select>
    </FieldShell>
  );
}

// The result of an action under its form. A message with `done` set is good news (or a notice), without it an error.
export function FormMessage({ state, tone }: { state: FormState; tone?: "success" | "warning" }) {
  if (!state.message) return null;
  // Field errors are shown at their fields; the generic "check the fields" line is enough above them.
  return <Alert tone={state.done ? (tone ?? "success") : "danger"}>{state.message}</Alert>;
}
