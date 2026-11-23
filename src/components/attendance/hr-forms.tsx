"use client";

import { useActionState, useRef, useState } from "react";
import { confirmShiftAction, hrCorrectAction, hrRecordAction, hrVoidAction } from "@/app/(app)/attendance/actions";
import { FormMessage, SelectField, TextField } from "@/components/attendance/form-bits";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/input";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";

// HR's controls for worked time. Ordinary forms posting to Server Actions; the server and the database decide.

type Outlet = { id: string; name: string };

// "Record time": add worked time for someone (no end = still working).
export function RecordTimeForm({ employees, outlets, defaultDay }: { employees: { id: string; label: string }[]; outlets: Outlet[]; defaultDay: string }) {
  const [state, formAction, pending] = useActionState(hrRecordAction, EMPTY_FORM_STATE);
  const v = state.values ?? {};
  const e = state.fieldErrors;
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField label="Employee" name="employeeId" defaultValue={v.employeeId ?? ""} error={e.employeeId}>
          <option value="">Choose an employee…</option>
          {employees.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </SelectField>
        <SelectField label="Outlet" name="outletId" defaultValue={v.outletId ?? ""} error={e.outletId}>
          <option value="">No outlet</option>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </SelectField>
        <TextField label="Day" name="day" type="date" defaultValue={v.day ?? defaultDay} error={e.day} required />
        <TextField label="Start" name="start" type="time" defaultValue={v.start} error={e.start} required />
        <TextField label="End" name="end" type="time" defaultValue={v.end} error={e.end} hint="Leave empty if still working." />
        <TextField label="Break (minutes)" name="breakMinutes" inputMode="numeric" defaultValue={v.breakMinutes} error={e.breakMinutes} placeholder="Optional" />
      </div>
      <TextField label="Reason" name="reason" maxLength={500} defaultValue={v.reason} error={e.reason} placeholder="Optional" />
      <FormMessage state={state} />
      <Button type="submit" loading={pending}>
        Record time
      </Button>
    </form>
  );
}

// "Worked as planned" on a missed shift.
export function ConfirmShiftButton({ shiftId }: { shiftId: string }) {
  const [state, formAction, pending] = useActionState(confirmShiftAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="shiftId" value={shiftId} />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        Worked as planned
      </Button>
      {state.message && <p className="text-xs font-medium text-danger">{state.message}</p>}
    </form>
  );
}

export type CorrectDefaults = { day: string; start: string; end: string; breakMinutes: string; outletId: string };

export function CorrectRecordForm({ recordId, endOptional, defaults, outlets }: { recordId: string; endOptional: boolean; defaults: CorrectDefaults; outlets: Outlet[] }) {
  const [state, formAction, pending] = useActionState(hrCorrectAction, EMPTY_FORM_STATE);
  const v = state.values ?? {};
  const e = state.fieldErrors;
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-3">
      <input type="hidden" name="recordId" value={recordId} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label="Day" name="day" type="date" defaultValue={v.day ?? defaults.day} error={e.day} required />
        <TextField label="Start" name="start" type="time" defaultValue={v.start ?? defaults.start} error={e.start} required />
        <TextField
          label="End"
          name="end"
          type="time"
          defaultValue={v.end ?? defaults.end}
          error={e.end}
          required={!endOptional}
          hint={endOptional ? "Leave empty while the person is still working." : undefined}
        />
        <TextField label="Break (minutes)" name="breakMinutes" inputMode="numeric" defaultValue={v.breakMinutes ?? defaults.breakMinutes} error={e.breakMinutes} placeholder="Optional" />
        <SelectField label="Outlet" name="outletId" defaultValue={v.outletId ?? defaults.outletId} error={e.outletId}>
          <option value="">Keep the current outlet</option>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </SelectField>
        <div className="flex items-end pb-2">
          <Label className="flex items-center gap-2 font-normal">
            <input type="checkbox" name="setBreak" defaultChecked={v.setBreak ? true : undefined} className="size-4 rounded border-border-strong" />
            Set break minutes
          </Label>
        </div>
      </div>
      <p className="text-xs text-fg-muted">Tick “Set break minutes” to replace the recorded breaks with the number above (empty = use the recorded breaks).</p>
      <TextField label="Reason" name="reason" maxLength={500} defaultValue={v.reason} error={e.reason} required />
      <FormMessage state={state} />
      <Button type="submit" loading={pending}>
        Save correction
      </Button>
    </form>
  );
}

export function VoidRecordForm({ recordId }: { recordId: string }) {
  const [state, formAction, pending] = useActionState(hrVoidAction, EMPTY_FORM_STATE);
  const [confirm, setConfirm] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form key={state.done ?? 0} ref={formRef} action={formAction} noValidate className="space-y-3">
      <input type="hidden" name="recordId" value={recordId} />
      <TextField label="Reason" name="reason" maxLength={500} defaultValue={state.values?.reason} error={state.fieldErrors.reason} required />
      {state.message && !state.fieldErrors.reason && <FormMessage state={state} />}
      <Button variant="danger" disabled={pending} onClick={() => setConfirm(true)}>
        Void record
      </Button>
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirm(false)}
          title="Void this record?"
          description="The record stops counting as worked time and can no longer be changed. It stays in the history."
          confirmLabel="Void record"
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
