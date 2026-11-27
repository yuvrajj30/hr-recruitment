"use client";

import { type ReactNode, useActionState, useId, useState } from "react";
import {
  addNoteAction,
  addResourceFileAction,
  addResourceLinkAction,
  assignTaskAction,
  cancelTaskAction,
  editTaskAction,
  removeResourceAction,
  reviewTaskAction,
  startTaskAction,
  submitTaskAction,
} from "@/app/(app)/tasks/actions";
import { FormMessage, SelectField, TextField } from "@/components/attendance/form-bits";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";
import {
  PROOF_KINDS, PROOF_LABELS, RATING_LABELS, TASK_LIMITS, TASK_PRIORITIES, TASK_PRIORITY_LABELS, type TaskRating,
} from "@/lib/tasks/rules";

// The task forms. Ordinary forms posting to Server Actions; the server and the database decide. Props are plain values.

const FILE_TYPES = "image/jpeg,image/png,image/webp,image/heic,application/pdf";

function TextAreaField({ label, name, error, hint, defaultValue, maxLength, required, rows = 3 }: {
  label: string; name: string; error?: string; hint?: string; defaultValue?: string; maxLength?: number; required?: boolean; rows?: number;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} name={name} rows={rows} maxLength={maxLength} defaultValue={defaultValue} required={required}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined} />
      {hint && !error && <p className="text-xs text-fg-muted">{hint}</p>}
      {error && (
        <p id={`${id}-e`} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// A group of choices with one error line.
function Group({ legend, error, hint, children }: { legend: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-[13px] font-medium text-fg">{legend}</legend>
      {children}
      {hint && !error && <p className="text-xs text-fg-muted">{hint}</p>}
      {error && <p className="text-xs font-medium text-danger">{error}</p>}
    </fieldset>
  );
}

// A file picker that tells the person about too many or too large files before they send anything. The server checks again.
function FilesInput({ name, multiple, error, label, hint }: { name: string; multiple?: boolean; error?: string; label: string; hint: string }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} type="file" multiple={multiple} accept={FILE_TYPES} className="h-auto py-1.5"
        aria-invalid={error ? true : undefined} aria-describedby={`${id}-h`} />
      <p id={`${id}-h`} className={error ? "text-xs font-medium text-danger" : "text-xs text-fg-muted"}>{error ?? hint}</p>
    </div>
  );
}

// Returns a message when the chosen files break a limit, so the form is not sent.
function fileProblem(form: HTMLFormElement, name: string, max: number): string | null {
  const input = form.elements.namedItem(name);
  if (!(input instanceof HTMLInputElement) || !input.files) return null;
  const files = [...input.files];
  if (files.length > max) return `Attach at most ${max} files.`;
  const big = files.find((f) => f.size > TASK_LIMITS.fileMaxBytes);
  if (big) return `"${big.name.slice(0, 60)}" is larger than 5 MB.`;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  return total > TASK_LIMITS.uploadTotalMaxBytes ? "Attach at most 5 MB in total. Use fewer or smaller photos." : null;
}

// ---------------------------------------------------------------------------
// Assigning and editing
// ---------------------------------------------------------------------------
export type Choice = { id: string; label: string };

function TaskFields({ employees, outlets, today, values, errors }: {
  employees: Choice[]; outlets: Choice[]; today: string; values: Record<string, string | undefined>; errors: Record<string, string>;
}) {
  const proof = (values.proof ?? "").split(",");
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="Employee" name="ownerId" defaultValue={values.ownerId ?? ""} error={errors.ownerId} required
          hint="Search by typing the name. The employee ID is shown in brackets.">
          <option value="">Choose an employee</option>
          {employees.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </SelectField>
        <SelectField label="Outlet where the work happens" name="outletId" defaultValue={values.outletId ?? ""} error={errors.outletId} required
          hint="Can differ from the employee's home outlet.">
          <option value="">Choose an outlet</option>
          {outlets.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </SelectField>
      </div>
      <TextField label="Title" name="title" maxLength={TASK_LIMITS.titleMax} defaultValue={values.title} error={errors.title} required />
      <TextAreaField label="Description" name="description" rows={4} maxLength={TASK_LIMITS.descriptionMax} defaultValue={values.description}
        error={errors.description} required hint="What needs to be done, and how HR will judge it." />
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label="Deadline" name="dueOn" type="date" min={today} defaultValue={values.dueOn} error={errors.dueOn} required />
        <TextField label="Time (optional)" name="dueTime" type="time" defaultValue={values.dueTime} error={errors.dueTime} hint="Leave empty for the end of the day." />
        <SelectField label="Priority" name="priority" defaultValue={values.priority || "NORMAL"} error={errors.priority}>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {TASK_PRIORITY_LABELS[p]}
            </option>
          ))}
        </SelectField>
      </div>
      <Group legend="Proof required" error={errors.proof} hint="The employee must give every kind you tick before they can submit.">
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {PROOF_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-2 text-[13px] text-fg">
              <input type="checkbox" name="proof" value={k} defaultChecked={proof.includes(k)} />
              {PROOF_LABELS[k]}
            </label>
          ))}
        </div>
      </Group>
    </>
  );
}

export function NewTaskForm({ employees, outlets, today }: { employees: Choice[]; outlets: Choice[]; today: string }) {
  const [state, formAction, pending] = useActionState(assignTaskAction, EMPTY_FORM_STATE);
  const v = state.values ?? {};
  const e = state.fieldErrors;
  return (
    <form action={formAction} noValidate className="space-y-4">
      <TaskFields employees={employees} outlets={outlets} today={today} values={v} errors={e} />
      <TextField label="Link to a guide (optional)" name="link" inputMode="url" placeholder="https://" defaultValue={v.link} error={e.link}
        hint="One link starting with https://. You can add files and more links on the task page after assigning." />
      <FormMessage state={state} />
      <Button type="submit" loading={pending}>
        Assign task
      </Button>
    </form>
  );
}

export type EditableTask = {
  id: string; ownerId: string; outletId: string; title: string; description: string; dueOn: string; dueTime: string | null; priority: string; proof: string[];
};

export function EditTaskForm({ task, employees, outlets, today }: { task: EditableTask; employees: Choice[]; outlets: Choice[]; today: string }) {
  const [state, formAction, pending] = useActionState(editTaskAction, EMPTY_FORM_STATE);
  const v = state.values ?? {
    ownerId: task.ownerId, outletId: task.outletId, title: task.title, description: task.description, dueOn: task.dueOn,
    dueTime: task.dueTime ?? "", priority: task.priority, proof: task.proof.join(","),
  };
  const e = state.fieldErrors;
  return (
    <form action={formAction} noValidate className="space-y-4">
      <input type="hidden" name="taskId" value={task.id} />
      <TaskFields employees={employees} outlets={outlets} today={today} values={v} errors={e} />
      <TextAreaField label="Reason for the change" name="reason" rows={2} maxLength={TASK_LIMITS.noteMax} defaultValue={state.values?.reason} error={e.reason}
        hint="Moving the task to another person needs a reason and sends it back to Assigned. Other changes need one too." />
      <FormMessage state={state} />
      <Button type="submit" loading={pending}>
        Save changes
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------
export function StartTaskButton({ taskId, again }: { taskId: string; again?: boolean }) {
  const [state, formAction, pending] = useActionState(startTaskAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="taskId" value={taskId} />
      <Button type="submit" loading={pending}>
        {again ? "Start task again" : "Start task"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function NoteForm({ taskId }: { taskId: string }) {
  const [state, formAction, pending] = useActionState(addNoteAction, EMPTY_FORM_STATE);
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-3">
      <input type="hidden" name="taskId" value={taskId} />
      <TextAreaField label="Add a note" name="note" rows={2} maxLength={TASK_LIMITS.noteMax} defaultValue={state.values?.note} error={state.fieldErrors.note}
        hint="Notes are kept in the history of this task." />
      <FormMessage state={state} />
      <Button type="submit" variant="secondary" loading={pending}>
        Add note
      </Button>
    </form>
  );
}

export function SubmitTaskForm({ taskId, needsText, needsFiles }: { taskId: string; needsText: boolean; needsFiles: boolean }) {
  const [state, formAction, pending] = useActionState(submitTaskAction, EMPTY_FORM_STATE);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      key={state.done ?? 0}
      action={formAction}
      noValidate
      className="space-y-3"
      onSubmit={(event) => {
        const found = fileProblem(event.currentTarget, "files", TASK_LIMITS.filesMax);
        setProblem(found);
        if (found) event.preventDefault();
      }}
    >
      <input type="hidden" name="taskId" value={taskId} />
      <TextAreaField label={needsText ? "Written explanation" : "Written explanation (optional)"} name="text" rows={5} maxLength={TASK_LIMITS.textMax}
        defaultValue={state.values?.text} error={state.fieldErrors.text} required={needsText} />
      <FilesInput name="files" multiple label={needsFiles ? "Photos or PDF" : "Photos or PDF (optional)"} error={problem ?? state.fieldErrors.files}
        hint={`Photos or PDF, at most ${TASK_LIMITS.filesMax} files and 5 MB in total.`} />
      <FormMessage state={state} />
      <Button type="submit" loading={pending}>
        Submit for review
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// HR: review, cancel, resources
// ---------------------------------------------------------------------------
export function ReviewTaskForm({ taskId }: { taskId: string }) {
  const [state, formAction, pending] = useActionState(reviewTaskAction, EMPTY_FORM_STATE);
  const v = state.values ?? {};
  const e = state.fieldErrors;
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-4">
      <input type="hidden" name="taskId" value={taskId} />
      <Group legend="Your decision" error={e.decision}>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input type="radio" name="decision" value="approve" defaultChecked={v.decision === "approve"} />
            Approve
          </label>
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input type="radio" name="decision" value="changes" defaultChecked={v.decision === "changes"} />
            Request changes
          </label>
        </div>
      </Group>
      <Group legend="Rating (needed to approve)" error={e.rating}>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {([1, 2, 3, 4, 5] as TaskRating[]).map((r) => (
            <label key={r} className="flex items-center gap-2 text-[13px] text-fg">
              <input type="radio" name="rating" value={r} defaultChecked={v.rating === String(r)} />
              {r} {RATING_LABELS[r]}
            </label>
          ))}
        </div>
      </Group>
      <TextAreaField label="Comment" name="note" rows={3} maxLength={TASK_LIMITS.noteMax} defaultValue={v.note} error={e.note}
        hint="Needed when you request changes. When you approve, the employee sees your rating and comment." />
      <FormMessage state={state} />
      <Button type="submit" loading={pending}>
        Save decision
      </Button>
    </form>
  );
}

export function CancelTaskForm({ taskId }: { taskId: string }) {
  const [state, formAction, pending] = useActionState(cancelTaskAction, EMPTY_FORM_STATE);
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-3">
      <input type="hidden" name="taskId" value={taskId} />
      <TextAreaField label="Reason" name="reason" rows={2} maxLength={500} defaultValue={state.values?.reason} error={state.fieldErrors.reason}
        hint="A cancelled task cannot be opened again. The employee is told." required />
      <FormMessage state={state} />
      <Button type="submit" variant="danger" loading={pending}>
        Cancel task
      </Button>
    </form>
  );
}

export function AddLinkForm({ taskId }: { taskId: string }) {
  const [state, formAction, pending] = useActionState(addResourceLinkAction, EMPTY_FORM_STATE);
  return (
    <form key={state.done ?? 0} action={formAction} noValidate className="space-y-2">
      <input type="hidden" name="taskId" value={taskId} />
      <TextField label="Link" name="url" inputMode="url" placeholder="https://" defaultValue={state.values?.url} error={state.fieldErrors.url} />
      <FormMessage state={state} />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        Add link
      </Button>
    </form>
  );
}

export function AddFileForm({ taskId }: { taskId: string }) {
  const [state, formAction, pending] = useActionState(addResourceFileAction, EMPTY_FORM_STATE);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      key={state.done ?? 0}
      action={formAction}
      noValidate
      className="space-y-2"
      onSubmit={(event) => {
        const found = fileProblem(event.currentTarget, "file", 1);
        setProblem(found);
        if (found) event.preventDefault();
      }}
    >
      <input type="hidden" name="taskId" value={taskId} />
      <FilesInput name="file" label="File" error={problem ?? state.fieldErrors.file} hint="A photo or PDF, up to 5 MB." />
      <FormMessage state={state} />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        Add file
      </Button>
    </form>
  );
}

export function RemoveResourceButton({ resourceId }: { resourceId: string }) {
  const [state, formAction, pending] = useActionState(removeResourceAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="resourceId" value={resourceId} />
      <Button type="submit" size="sm" variant="ghost" loading={pending}>
        Remove
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
