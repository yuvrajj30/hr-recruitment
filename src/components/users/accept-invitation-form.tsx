"use client";

import { useActionState, useId } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/recruitment/form-state";

// The form on an invitation page. New people choose a name and password; people who already have an
// account (for another organisation) confirm it with their existing password.
export function AcceptInvitationForm({ action, email, name, accountExists }: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  email: string;
  name: string;
  accountExists: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  const id = useId();
  const e = state.fieldErrors;
  return (
    <form action={formAction} noValidate className="space-y-4 rounded-[10px] border border-border bg-surface p-6 shadow-sm">
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-email`}>Email</Label>
        <Input id={`${id}-email`} value={email} readOnly disabled autoComplete="username" />
      </div>
      {accountExists ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-pw`}>Your current password</Label>
          <Input id={`${id}-pw`} name="password" type="password" autoComplete="current-password" required aria-invalid={e.password ? true : undefined} />
          <p className="text-xs text-fg-muted">You already have an account with this email. Enter its password to join; it stays the same.</p>
          {e.password && <p className="text-xs font-medium text-danger">{e.password}</p>}
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`}>Your name</Label>
            <Input id={`${id}-name`} name="name" defaultValue={state.values?.name ?? name} maxLength={120} autoComplete="name" required aria-invalid={e.name ? true : undefined} />
            {e.name && <p className="text-xs font-medium text-danger">{e.name}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-pw`}>Choose a password</Label>
            <Input id={`${id}-pw`} name="password" type="password" autoComplete="new-password" required aria-invalid={e.password ? true : undefined} />
            <p className="text-xs text-fg-muted">At least 12 characters. Do not use your name, email or the company name.</p>
            {e.password && <p className="text-xs font-medium text-danger">{e.password}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-pw2`}>Type it again</Label>
            <Input id={`${id}-pw2`} name="confirmPassword" type="password" autoComplete="new-password" required aria-invalid={e.confirmPassword ? true : undefined} />
            {e.confirmPassword && <p className="text-xs font-medium text-danger">{e.confirmPassword}</p>}
          </div>
        </>
      )}
      <Button type="submit" loading={pending} className="w-full">
        {accountExists ? "Join" : "Create my account"}
      </Button>
    </form>
  );
}
