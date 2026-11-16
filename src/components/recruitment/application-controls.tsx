"use client";

import { useActionState, useId, useState } from "react";
import { addNoteAction, assignRecruiterAction, moveStageAction, updateCandidateNotesAction } from "@/app/(app)/recruitment/application-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea } from "@/components/ui/input";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";
import { allowedMoves, type AnyStage, MAX_REASON_LENGTH, moveNeedsReason, type PipelineStage, STAGE_LABELS } from "@/lib/recruitment/stages";

// The controls on an application: move its stage, choose the responsible HR person, add a note.
// Each is an ordinary form posting to a Server Action; the server decides whether it is allowed.

const REASON_LABEL = { reject: "Reason for rejecting", backward: "Why is it moving back?", restore: "Why is it being reopened?", forward: "Comment", withdraw: "Comment" } as const;

export function StageMover({ applicationId, stage }: { applicationId: string; stage: AnyStage }) {
  const [state, formAction, pending] = useActionState(moveStageAction, EMPTY_FORM_STATE);
  const moves = allowedMoves(stage);
  const [to, setTo] = useState<PipelineStage | "">("");
  const selectId = useId();
  const reasonId = useId();
  if (moves.length === 0) return <p className="text-[13px] text-fg-muted">This stage is managed elsewhere and cannot be changed here.</p>;
  const chosen = moves.find((m) => m.to === to);
  const needsReason = chosen ? moveNeedsReason(chosen.kind) : false;

  return (
    // The key resets the form after each successful move (the page has fresh data by then).
    <form key={state.done ?? 0} action={formAction} className="space-y-3" onSubmit={() => setTo("")}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <div className="space-y-1.5">
        <Label htmlFor={selectId}>Move to</Label>
        <Select id={selectId} name="to" value={to} onChange={(e) => setTo(e.target.value as PipelineStage | "")} required>
          <option value="">Choose a stage…</option>
          {moves.map((m) => (
            <option key={m.to} value={m.to}>
              {STAGE_LABELS[m.to]}
              {m.kind === "backward" ? " (move back)" : m.kind === "restore" ? " (reopen)" : ""}
            </option>
          ))}
        </Select>
      </div>
      {chosen && (
        <div className="space-y-1.5">
          <Label htmlFor={reasonId}>
            {REASON_LABEL[chosen.kind]}
            {!needsReason && <span className="ml-1 font-normal text-fg-subtle">(optional)</span>}
          </Label>
          <Textarea id={reasonId} name="reason" rows={2} maxLength={MAX_REASON_LENGTH} required={needsReason} className="min-h-16" />
          <p className="text-xs text-fg-muted">Saved in the application&apos;s history. The candidate does not see it.</p>
        </div>
      )}
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      <Button type="submit" size="sm" variant={chosen?.kind === "reject" ? "danger" : "primary"} loading={pending} disabled={!chosen}>
        {chosen ? (chosen.kind === "reject" ? "Reject application" : `Move to ${STAGE_LABELS[chosen.to]}`) : "Move"}
      </Button>
    </form>
  );
}

export function RecruiterPicker({ applicationId, currentId, recruiters }: { applicationId: string; currentId: string | null; recruiters: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(assignRecruiterAction, EMPTY_FORM_STATE);
  const [value, setValue] = useState(currentId ?? "");
  const id = useId();
  // Someone assigned earlier who can no longer be chosen (for example, their role changed) still shows as current.
  const known = currentId === null || recruiters.some((r) => r.id === currentId);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="applicationId" value={applicationId} />
      <Label htmlFor={id}>Assign to</Label>
      <div className="flex gap-2">
        <Select id={id} name="recruiterId" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Nobody (unassigned)</option>
          {!known && currentId && <option value={currentId}>Current responsible person</option>}
          {recruiters.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
        <Button type="submit" size="md" variant="secondary" loading={pending} disabled={value === (currentId ?? "")}>
          Save
        </Button>
      </div>
      {recruiters.length === 0 && <p className="text-xs text-fg-muted">Nobody in this organisation is an active HR Manager or Super Admin yet.</p>}
      {state.message && <Alert tone="danger">{state.message}</Alert>}
    </form>
  );
}

export function NoteForm({ applicationId }: { applicationId: string }) {
  const [state, formAction, pending] = useActionState(addNoteAction, EMPTY_FORM_STATE);
  const id = useId();
  return (
    <form key={state.done ?? 0} action={formAction} className="space-y-2">
      <input type="hidden" name="applicationId" value={applicationId} />
      <Label htmlFor={id}>Add an internal note</Label>
      <Textarea id={id} name="body" rows={3} maxLength={4000} required defaultValue={state.values?.body} placeholder="Visible to your team only, never to the candidate." />
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        Save note
      </Button>
    </form>
  );
}

export function CandidateNotesForm({ candidateId, notes }: { candidateId: string; notes: string }) {
  const [state, formAction, pending] = useActionState(updateCandidateNotesAction, EMPTY_FORM_STATE);
  const id = useId();
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="candidateId" value={candidateId} />
      <Label htmlFor={id} className="sr-only">
        Notes about this candidate
      </Label>
      <Textarea id={id} name="notes" rows={5} maxLength={8000} defaultValue={state.values?.notes ?? notes} placeholder="Anything your team should remember about this person, across all their applications." />
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="secondary" loading={pending}>
          Save notes
        </Button>
        {state.done && !pending && !state.message && (
          <span role="status" className="text-xs text-success">
            Saved.
          </span>
        )}
      </div>
    </form>
  );
}
