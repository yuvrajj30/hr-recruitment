"use client";

import { useActionState, useId, useRef, useState } from "react";
import { linkAccountAction, markLeftAction } from "@/app/(app)/employees/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";

// "Mark as left" and "Link login" on an employee's page. Ordinary forms posting to Server Actions; the server
// (and the database) decide whether each is allowed.

export function MarkLeftControl({ employeeId, joinedOn }: { employeeId: string; joinedOn: string }) {
  const [state, formAction, pending] = useActionState(markLeftAction, EMPTY_FORM_STATE);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const id = useId();
  const error = state.fieldErrors.exitedOn;

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Mark as left
      </Button>
    );
  }
  return (
    <form key={state.done ?? 0} ref={formRef} action={formAction} noValidate className="space-y-2 rounded-md border border-border p-3">
      <input type="hidden" name="employeeId" value={employeeId} />
      <Label htmlFor={id}>Last working day</Label>
      <Input id={id} name="exitedOn" type="date" min={joinedOn} defaultValue={state.values?.exitedOn} required aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined} />
      {error && (
        <p id={`${id}-e`} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
      {state.message && !error && <Alert tone="danger">{state.message}</Alert>}
      <div className="flex gap-2">
        <Button size="sm" variant="danger" disabled={pending} onClick={() => setConfirm(true)}>
          Mark as left
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
          Keep as active
        </Button>
      </div>
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirm(false)}
          title="Mark this employee as left?"
          description="This cannot be undone. Their record can no longer be changed, and it stays on file for your history."
          confirmLabel="Mark as left"
          busy={pending}
          onConfirm={() => {
            setConfirm(false);
            formRef.current?.requestSubmit();
          }}
        />
      )}
    </form>
  );
}

export function LinkAccountControl({
  employeeId,
  account,
  choices,
}: {
  employeeId: string;
  account: { name: string; email: string } | null;
  choices: { memberId: string; name: string; email: string }[];
}) {
  const [state, formAction, pending] = useActionState(linkAccountAction, EMPTY_FORM_STATE);
  const id = useId();
  return (
    <div className="space-y-2">
      {account ? (
        <form action={formAction} className="space-y-2">
          <input type="hidden" name="employeeId" value={employeeId} />
          <input type="hidden" name="op" value="unlink" />
          <p className="text-[13px] text-fg">
            Linked to {account.name} <span className="text-fg-muted">({account.email})</span>
          </p>
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            Unlink login
          </Button>
        </form>
      ) : (
        <form key={state.done ?? 0} action={formAction} className="space-y-2">
          <input type="hidden" name="employeeId" value={employeeId} />
          <input type="hidden" name="op" value="link" />
          <Label htmlFor={id}>Staff account</Label>
          <Select id={id} name="memberId" defaultValue="" aria-invalid={state.fieldErrors.memberId ? true : undefined}>
            <option value="">Choose an account…</option>
            {choices.map((c) => (
              <option key={c.memberId} value={c.memberId}>
                {c.name} ({c.email})
              </option>
            ))}
          </Select>
          {state.fieldErrors.memberId && <p className="text-xs font-medium text-danger">{state.fieldErrors.memberId}</p>}
          <p className="text-xs text-fg-muted">Once linked, that person sees this record under My account.</p>
          <Button type="submit" size="sm" loading={pending} disabled={choices.length === 0}>
            Link login
          </Button>
          {choices.length === 0 && <p className="text-xs text-fg-muted">There are no staff accounts left to link.</p>}
        </form>
      )}
      {state.message && !state.fieldErrors.memberId && <Alert tone="danger">{state.message}</Alert>}
    </div>
  );
}
