"use client";

import { useActionState, useId } from "react";
import { changePasswordAction, updateNameAction } from "@/app/(app)/me/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";

export function NameForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState(updateNameAction, EMPTY_FORM_STATE);
  const id = useId();
  return (
    <form action={action} className="space-y-2">
      <Label htmlFor={id}>Your name</Label>
      <div className="flex gap-2">
        <Input id={id} name="name" defaultValue={state.values?.name ?? name} maxLength={120} autoComplete="name" aria-invalid={state.fieldErrors.name ? true : undefined} />
        <Button type="submit" variant="secondary" loading={pending}>
          Save
        </Button>
      </div>
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      {state.done && !pending && !state.message && (
        <p role="status" className="text-xs text-success">
          Saved.
        </p>
      )}
    </form>
  );
}

export function PasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, EMPTY_FORM_STATE);
  const id = useId();
  const e = state.fieldErrors;
  const field = (name: string, label: string, auto: string, hint?: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      <Input id={`${id}-${name}`} name={name} type="password" autoComplete={auto} required aria-invalid={e[name] ? true : undefined} />
      {hint && <p className="text-xs text-fg-muted">{hint}</p>}
      {e[name] && <p className="text-xs font-medium text-danger">{e[name]}</p>}
    </div>
  );
  return (
    // The key clears all three boxes after a successful change.
    <form key={state.done ?? 0} action={action} noValidate className="space-y-4">
      {field("currentPassword", "Current password", "current-password")}
      {field("newPassword", "New password", "new-password", "At least 12 characters. Do not use your name, email or the company name.")}
      {field("confirmPassword", "Type the new password again", "new-password")}
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      {state.done && !pending && !state.message && <Alert tone="success">Password changed. Your other devices have been signed out.</Alert>}
      <Button type="submit" loading={pending}>
        Change password
      </Button>
    </form>
  );
}
