"use client";

import { type ReactNode, useActionState, useState } from "react";
import {
  adjustLeaveAction,
  cancelLeaveAction,
  decideLeaveAction,
  hrRecordLeaveAction,
  removeHolidayAction,
  requestLeaveAction,
  saveHolidayAction,
  saveLeaveTypeAction,
  withdrawLeaveAction,
} from "@/app/(app)/leave/actions";
import { FormMessage, SelectField, TextField } from "@/components/attendance/form-bits";
import { Button } from "@/components/ui/button";
import { ACCRUAL_LABELS, LEAVE_ACCRUALS } from "@/lib/leave/rules";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";

// The leave forms. Ordinary forms posting to Server Actions; the server and the database decide. Props are plain values.

function Check({ name, label, defaultChecked, disabled, hint }: { name: string; label: string; defaultChecked?: boolean; disabled?: boolean; hint?: ReactNode }) {
  return (
    <label className="flex items-start gap-2 text-[13px] text-fg">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} disabled={disabled} className="mt-0.5" />
      <span>
        {label}
        {hint && <span className="block text-xs text-fg-muted">{hint}</span>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
export type LeaveTypeChoice = { id: string; name: string; paid: boolean; configured: boolean; noteRequired: boolean };

function RequestFields({ types, defaultDay, errors, values }: { types: LeaveTypeChoice[]; defaultDay: string; errors: Record<string, string>; values: Record<string, string | undefined> }) {
  const [start, setStart] = useState(values.start ?? defaultDay);
  const [end, setEnd] = useState(values.end ?? defaultDay);
  const crossesYear = /^\d{4}-/.test(start) && /^\d{4}-/.test(end) && start.slice(0, 4) !== end.slice(0, 4);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField label="Leave type" name="typeId" defaultValue={values.typeId ?? ""} error={errors.typeId} required>
          <option value="">Choose a type</option>
          {types.map((t) => (
            <option key={t.id} value={t.id} disabled={t.paid && !t.configured}>
              {t.name}
              {t.paid && !t.configured ? " (not set up)" : ""}
            </option>
          ))}
        </SelectField>
        <TextField label="First day" name="start" type="date" value={start} onChange={(e) => setStart(e.target.value)} error={errors.start} required />
        <TextField label="Last day" name="end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} error={errors.end} required />
      </div>
      <div className="space-y-1">
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <Check name="startHalf" label="Half day on the first day" defaultChecked={values.startHalf === "on"} />
          <Check name="endHalf" label="Half day on the last day" defaultChecked={values.endHalf === "on"} />
        </div>
        <p className="text-xs text-fg-muted">For a single half day, tick either one.</p>
      </div>
      <TextField
        label="Note (optional)"
        name="note"
        maxLength={500}
        defaultValue={values.note}
        error={errors.note}
        hint={crossesYear ? "A request over 31 December is saved as one request per year." : "Some leave types need a note."}
      />
    </>
  );
}

// One form for "ask for leave" (employees) and "record paper leave" (HR, when `employees` is given).
export function LeaveRequestForm({ types, defaultDay, hasStandard, employees }: { types: LeaveTypeChoice[]; defaultDay: string; hasStandard?: boolean; employees?: { id: string; label: string }[] }) {
  const hr = employees !== undefined;
  const [state, formAction, pending] = useActionState(hr ? hrRecordLeaveAction : requestLeaveAction, EMPTY_FORM_STATE);
  const v = state.values ?? {};
  const e = state.fieldErrors;
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-3">
      {employees && (
        <SelectField label="Employee" name="employeeId" defaultValue={v.employeeId ?? ""} error={e.employeeId} required className="sm:max-w-sm">
          <option value="">Choose an employee</option>
          {employees.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </SelectField>
      )}
      <RequestFields types={types} defaultDay={defaultDay} errors={e} values={v} />
      {!hr && hasStandard === false && (
        <p className="text-[13px] text-fg-muted">No working days are set for you, so every day except holidays counts. Ask HR to set your standard shifts.</p>
      )}
      <FormMessage state={state} />
      <Button type="submit" loading={pending}>
        {hr ? "Record as approved" : "Send request to HR"}
      </Button>
    </form>
  );
}

export function WithdrawLeaveButton({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState(withdrawLeaveAction, EMPTY_FORM_STATE);
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
export function DecideLeaveControls({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState(decideLeaveAction, EMPTY_FORM_STATE);
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

export function CancelLeaveForm({ requestId, children }: { requestId: string; children?: ReactNode }) {
  const [state, formAction, pending] = useActionState(cancelLeaveAction, EMPTY_FORM_STATE);
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-3">
      <input type="hidden" name="requestId" value={requestId} />
      <TextField label="Reason" name="reason" maxLength={500} defaultValue={state.values?.reason} error={state.fieldErrors.reason} hint="Days not yet taken go back to the balance." required />
      {children}
      <FormMessage state={state} />
      <Button type="submit" variant="danger" loading={pending}>
        Cancel this leave
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------
export function AdjustLeaveForm({ employeeId, year, types }: { employeeId: string; year: number; types: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(adjustLeaveAction, EMPTY_FORM_STATE);
  const v = state.values ?? {};
  const e = state.fieldErrors;
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-3">
      <input type="hidden" name="employeeId" value={employeeId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField label="Leave type" name="typeId" defaultValue={v.typeId ?? ""} error={e.typeId} required>
          <option value="">Choose a type</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </SelectField>
        <TextField label="Year" name="year" inputMode="numeric" defaultValue={v.year ?? String(year)} error={e.year} required />
        <TextField label="Days" name="days" inputMode="decimal" placeholder="1.5 or -1" defaultValue={v.days} error={e.days} required />
      </div>
      <TextField
        label="Reason"
        name="reason"
        maxLength={500}
        defaultValue={v.reason}
        error={e.reason}
        hint="Use a minus to take days away. Every adjustment is kept with its reason."
        required
      />
      <FormMessage state={state} />
      <Button type="submit" loading={pending}>
        Add adjustment
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Set-up
// ---------------------------------------------------------------------------
export type LeaveTypeValues = {
  id: string; code: string; name: string; paid: boolean; accrual: string; daysPerYear: string; carryOverMax: string; noteRequired: boolean; isActive: boolean;
};

// An existing type (type given: code and paid are shown, not editable) or a new one (no type).
export function LeaveTypeForm({ type }: { type?: LeaveTypeValues }) {
  const [state, formAction, pending] = useActionState(saveLeaveTypeAction, EMPTY_FORM_STATE);
  const v = state.values ?? {};
  const e = state.fieldErrors;
  const noBalance = type ? !type.paid : false;
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-3">
      {type && <input type="hidden" name="typeId" value={type.id} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {!type && <TextField label="Code" name="code" maxLength={10} defaultValue={v.code} error={e.code} placeholder="CL" required />}
        <TextField label="Name" name="name" maxLength={60} defaultValue={v.name ?? type?.name} error={e.name} required />
        <SelectField label="How days are credited" name="accrual" defaultValue={noBalance ? "NONE" : (v.accrual ?? type?.accrual ?? "NONE")} error={e.accrual} disabled={noBalance}>
          {LEAVE_ACCRUALS.map((a) => (
            <option key={a} value={a}>
              {ACCRUAL_LABELS[a]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Days per year"
          name="daysPerYear"
          inputMode="decimal"
          defaultValue={noBalance ? "" : (v.daysPerYear ?? type?.daysPerYear ?? "0")}
          placeholder={noBalance ? "No balance" : undefined}
          error={e.daysPerYear}
          disabled={noBalance}
        />
        <TextField
          label="Carry-over (most days)"
          name="carryOverMax"
          inputMode="decimal"
          defaultValue={noBalance ? "" : (v.carryOverMax ?? type?.carryOverMax ?? "0")}
          placeholder={noBalance ? "No balance" : undefined}
          error={e.carryOverMax}
          disabled={noBalance}
        />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {!type && <Check name="paid" label="Paid leave (has a balance)" defaultChecked={v.paid === "on"} hint="Unpaid leave has no balance: keep no balance, 0 days and 0 carry-over." />}
        <Check name="noteRequired" label="Requests need a note" defaultChecked={state.values ? v.noteRequired === "on" : (type?.noteRequired ?? false)} />
        <Check name="isActive" label="In use" defaultChecked={state.values ? v.isActive === "on" : (type?.isActive ?? true)} />
      </div>
      <FormMessage state={state} />
      <Button type="submit" size={type ? "sm" : "md"} loading={pending}>
        {type ? "Save settings" : "Add leave type"}
      </Button>
    </form>
  );
}

export function HolidayForm({ outlets, defaultDay }: { outlets: { id: string; name: string }[]; defaultDay: string }) {
  const [state, formAction, pending] = useActionState(saveHolidayAction, EMPTY_FORM_STATE);
  const v = state.values ?? {};
  const e = state.fieldErrors;
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label="Day" name="day" type="date" defaultValue={v.day ?? defaultDay} error={e.day} required />
        <TextField label="Name" name="name" maxLength={80} defaultValue={v.name} error={e.name} placeholder="Diwali" required />
        <SelectField label="Outlet" name="outletId" defaultValue={v.outletId ?? ""} error={e.outletId}>
          <option value="">All outlets</option>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </SelectField>
      </div>
      <FormMessage state={state} />
      <Button type="submit" loading={pending}>
        Add holiday
      </Button>
    </form>
  );
}

export function RemoveHolidayButton({ holidayId }: { holidayId: string }) {
  const [state, formAction, pending] = useActionState(removeHolidayAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="holidayId" value={holidayId} />
      <Button type="submit" size="sm" variant="ghost" loading={pending}>
        Remove
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
