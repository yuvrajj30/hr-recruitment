"use client";

import { useActionState } from "react";
import { applyStandardAction, setEmployeeStandardAction, setOutletHoursAction } from "@/app/(app)/attendance/actions";
import { FormMessage, SelectField, TextField } from "@/components/attendance/form-bits";
import { Button } from "@/components/ui/button";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";

// HR's standard-shift controls. Ordinary forms posting to Server Actions; the server and the database decide.

export type OutletHoursValues = { outletId: string; opening: string; changeover: string; closing: string; breakMinutes: string; hasHours: boolean };

export function OutletHoursForm({ outlet }: { outlet: OutletHoursValues }) {
  const [state, formAction, pending] = useActionState(setOutletHoursAction, EMPTY_FORM_STATE);
  const v = state.values ?? {};
  const e = state.fieldErrors;
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-3">
      <input type="hidden" name="outletId" value={outlet.outletId} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextField label="Opening" name="opening" type="time" defaultValue={v.opening ?? outlet.opening} error={e.opening} />
        <TextField label="Evening starts" name="changeover" type="time" defaultValue={v.changeover ?? outlet.changeover} error={e.changeover} />
        <TextField label="Closing" name="closing" type="time" defaultValue={v.closing ?? outlet.closing} error={e.closing} />
        <TextField label="Standard break (minutes)" name="breakMinutes" inputMode="numeric" defaultValue={v.breakMinutes ?? outlet.breakMinutes} error={e.breakMinutes} placeholder="0" />
      </div>
      <FormMessage state={state} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={pending}>
          Save
        </Button>
        {outlet.hasHours && (
          <Button type="submit" name="intent" value="clear" size="sm" variant="secondary" disabled={pending}>
            Remove hours
          </Button>
        )}
      </div>
    </form>
  );
}

export type EmployeeStandardValues = { employeeId: string; standardShift: string; workDays: number[] };

export function EmployeeStandardForm({ employee, weekdays }: { employee: EmployeeStandardValues; weekdays: { n: number; short: string }[] }) {
  const [state, formAction, pending] = useActionState(setEmployeeStandardAction, EMPTY_FORM_STATE);
  const e = state.fieldErrors;
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-2">
      <input type="hidden" name="employeeId" value={employee.employeeId} />
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <SelectField label="Standard shift" name="standardShift" defaultValue={state.values?.standardShift ?? employee.standardShift} error={e.standardShift} className="w-40">
          <option value="NONE">No standard</option>
          <option value="MORNING">Morning</option>
          <option value="EVENING">Evening</option>
        </SelectField>
        <fieldset className="space-y-1">
          <legend className="text-xs text-fg-muted">Working days</legend>
          <div className="flex flex-wrap gap-3 py-1.5">
            {weekdays.map((d) => (
              <label key={d.n} className="flex items-center gap-1 text-[13px] text-fg">
                <input type="checkbox" name="workDays" value={d.n} defaultChecked={employee.workDays.includes(d.n)} />
                {d.short}
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" size="sm" loading={pending}>
          Save
        </Button>
      </div>
      {e.workDays && <p className="text-xs font-medium text-danger">{e.workDays}</p>}
      <FormMessage state={state} />
    </form>
  );
}

export function ApplyStandardForm() {
  const [state, formAction, pending] = useActionState(applyStandardAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="space-y-3">
      <FormMessage state={state} />
      <Button type="submit" loading={pending}>
        Apply to the rota now
      </Button>
    </form>
  );
}
