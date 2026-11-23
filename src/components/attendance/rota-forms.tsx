"use client";

import { useActionState, useRef, useState } from "react";
import { cancelShiftAction, copyWeekAction, createShiftAction, updateShiftAction } from "@/app/(app)/attendance/actions";
import { FormMessage, SelectField, TextField } from "@/components/attendance/form-bits";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";

// HR's rota controls. Ordinary forms posting to Server Actions; the server and the database decide.

type Outlet = { id: string; name: string };
export type ShiftDefaults = { day: string; start: string; end: string; breakMinutes: string; note: string; outletId: string };

// Add a shift (no `shift`) or edit a planned one (`shift` given: its employee comes along in a hidden field).
export function ShiftForm({ employees, outlets, defaults, shift }: { employees?: { id: string; label: string }[]; outlets: Outlet[]; defaults: ShiftDefaults; shift?: { id: string; employeeId: string } }) {
  const [state, formAction, pending] = useActionState(shift ? updateShiftAction : createShiftAction, EMPTY_FORM_STATE);
  const v = state.values ?? {};
  const e = state.fieldErrors;
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-3">
      {shift && (
        <>
          <input type="hidden" name="shiftId" value={shift.id} />
          <input type="hidden" name="employeeId" value={shift.employeeId} />
        </>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {!shift && (
          <SelectField label="Employee" name="employeeId" defaultValue={v.employeeId ?? ""} error={e.employeeId}>
            <option value="">Choose an employee…</option>
            {(employees ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </SelectField>
        )}
        <SelectField label="Outlet" name="outletId" defaultValue={v.outletId ?? defaults.outletId} error={e.outletId}>
          <option value="">Choose an outlet…</option>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </SelectField>
        <TextField label="Day" name="day" type="date" defaultValue={v.day ?? defaults.day} error={e.day} required />
        <TextField label="Start" name="start" type="time" defaultValue={v.start ?? defaults.start} error={e.start} required />
        <TextField label="End" name="end" type="time" defaultValue={v.end ?? defaults.end} error={e.end} required />
        <TextField label="Break (minutes)" name="breakMinutes" inputMode="numeric" defaultValue={v.breakMinutes ?? defaults.breakMinutes} error={e.breakMinutes} placeholder="0" />
      </div>
      <TextField label="Note" name="note" maxLength={500} defaultValue={v.note ?? defaults.note} error={e.note} placeholder="Optional" />
      <FormMessage state={state} />
      <Button type="submit" size={shift ? "sm" : "md"} loading={pending}>
        {shift ? "Save shift" : "Add shift"}
      </Button>
    </form>
  );
}

export function CancelShiftForm({ shiftId }: { shiftId: string }) {
  const [state, formAction, pending] = useActionState(cancelShiftAction, EMPTY_FORM_STATE);
  const [confirm, setConfirm] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form key={state.done ?? 0} ref={formRef} action={formAction} noValidate className="space-y-2">
      <input type="hidden" name="shiftId" value={shiftId} />
      <TextField label="Reason for cancelling" name="reason" maxLength={500} defaultValue={state.values?.reason} error={state.fieldErrors.reason} required />
      {state.message && !state.fieldErrors.reason && <FormMessage state={state} />}
      <Button size="sm" variant="danger" disabled={pending} onClick={() => setConfirm(true)}>
        Cancel shift
      </Button>
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirm(false)}
          title="Cancel this shift?"
          description="The shift stays on the rota, struck through, and can no longer be changed."
          confirmLabel="Cancel shift"
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

export function CopyWeekForm({ week, outletId }: { week: string; outletId: string }) {
  const [state, formAction, pending] = useActionState(copyWeekAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="week" value={week} />
      <input type="hidden" name="outlet" value={outletId} />
      <Button type="submit" variant="secondary" loading={pending}>
        Copy this week to next week
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
