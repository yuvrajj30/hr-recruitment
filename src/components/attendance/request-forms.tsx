"use client";

import { useActionState } from "react";
import { decideRequestAction, requestCorrectionAction, withdrawRequestAction } from "@/app/(app)/attendance/actions";
import { FormMessage, TextField } from "@/components/attendance/form-bits";
import { Button } from "@/components/ui/button";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";

// "Forgot to clock in?" / "Ask for a correction": one form for both (recordId present = a correction of that record).
export function CorrectionRequestForm({ recordId, defaults }: { recordId?: string; defaults: { day: string; start: string; end: string; breakMinutes: string } }) {
  const [state, formAction, pending] = useActionState(requestCorrectionAction, EMPTY_FORM_STATE);
  const v = state.values ?? {};
  const e = state.fieldErrors;
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-3">
      {recordId && <input type="hidden" name="recordId" value={recordId} />}
      <div className="grid gap-3 sm:grid-cols-4">
        <TextField label="Day" name="day" type="date" defaultValue={v.day ?? defaults.day} error={e.day} required />
        <TextField label="Start" name="start" type="time" defaultValue={v.start ?? defaults.start} error={e.start} required />
        <TextField label="End" name="end" type="time" defaultValue={v.end ?? defaults.end} error={e.end} required />
        <TextField label="Break (minutes)" name="breakMinutes" inputMode="numeric" placeholder="Optional" defaultValue={v.breakMinutes ?? defaults.breakMinutes} error={e.breakMinutes} />
      </div>
      <TextField label="Reason" name="reason" maxLength={500} defaultValue={v.reason} error={e.reason} placeholder="What happened?" required />
      <FormMessage state={state} />
      <Button type="submit" loading={pending}>
        Send request to HR
      </Button>
    </form>
  );
}

export function WithdrawButton({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState(withdrawRequestAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="requestId" value={requestId} />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        Withdraw
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

// Approve, or reject with a note: one form, the button pressed says which.
export function DecideControls({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState(decideRequestAction, EMPTY_FORM_STATE);
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-2">
      <input type="hidden" name="requestId" value={requestId} />
      <TextField label="Note (required to reject)" name="note" maxLength={500} defaultValue={state.values?.note} error={state.fieldErrors.note} />
      {state.message && !state.fieldErrors.note && <FormMessage state={state} />}
      <div className="flex gap-2">
        <Button type="submit" size="sm" name="decision" value="approve" loading={pending}>
          Approve
        </Button>
        <Button type="submit" size="sm" name="decision" value="reject" variant="danger" loading={pending}>
          Reject
        </Button>
      </div>
    </form>
  );
}
