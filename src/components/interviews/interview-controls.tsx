"use client";

import { type ReactNode, useActionState, useId, useRef, useState } from "react";
import { decisionAction, feedbackAction, interviewStatusAction } from "@/app/(app)/interviews/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Label, Select, Textarea } from "@/components/ui/input";
import {
  DECISION_LABELS,
  DECISION_OUTCOMES,
  type DecisionOutcome,
  INTERVIEW_LIMITS,
  RATING_CRITERIA,
  RATING_LABELS,
  RECOMMENDATION_LABELS,
  RECOMMENDATIONS,
} from "@/lib/interviews/rules";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/recruitment/form-state";

// The controls on an interview and on an application's decision. Each is an ordinary form posting to a
// Server Action; the server (and the database) decide whether it is allowed.

// ---------------------------------------------------------------------------
// Completed / No-show / Cancel
// ---------------------------------------------------------------------------

export function InterviewStatusControls({ interviewId, canRecordOutcome, canCancel }: { interviewId: string; canRecordOutcome: boolean; canCancel: boolean }) {
  const [state, formAction, pending] = useActionState(interviewStatusAction, EMPTY_FORM_STATE);
  const [confirm, setConfirm] = useState<"complete" | "no_show" | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const opRef = useRef<HTMLInputElement>(null);
  const reasonId = useId();

  const run = (op: "complete" | "no_show") => {
    if (opRef.current) opRef.current.value = op;
    setConfirm(null);
    formRef.current?.requestSubmit();
  };

  return (
    <div className="space-y-3">
      <form ref={formRef} action={formAction} className="flex flex-wrap gap-2">
        <input type="hidden" name="interviewId" value={interviewId} />
        <input ref={opRef} type="hidden" name="op" defaultValue="" />
        {canRecordOutcome && (
          <>
            <Button size="sm" disabled={pending} onClick={() => setConfirm("complete")}>
              Mark completed
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => setConfirm("no_show")}>
              Candidate did not attend
            </Button>
          </>
        )}
        {canCancel && !cancelling && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setCancelling(true)}>
            Cancel interview
          </Button>
        )}
      </form>
      {cancelling && (
        <form key={state.done ?? 0} action={formAction} className="space-y-2 rounded-md border border-border p-3">
          <input type="hidden" name="interviewId" value={interviewId} />
          <input type="hidden" name="op" value="cancel" />
          <Label htmlFor={reasonId}>Why is it cancelled?</Label>
          <Textarea
            id={reasonId}
            name="reason"
            rows={2}
            maxLength={INTERVIEW_LIMITS.cancelReason}
            required
            defaultValue={state.values?.reason}
            aria-invalid={state.fieldErrors.reason ? true : undefined}
            aria-describedby={state.fieldErrors.reason ? `${reasonId}-e` : undefined}
            className="min-h-16"
          />
          {state.fieldErrors.reason && (
            <p id={`${reasonId}-e`} className="text-xs font-medium text-danger">
              {state.fieldErrors.reason}
            </p>
          )}
          <p className="text-xs text-fg-muted">Kept with the interview for your team. The candidate does not see it.</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="danger" loading={pending}>
              Cancel interview
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => setCancelling(false)}>
              Keep it
            </Button>
          </div>
        </form>
      )}
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          title={confirm === "complete" ? "Mark this interview completed?" : "Record that the candidate did not attend?"}
          description={
            confirm === "complete"
              ? "This cannot be undone. Interviewers can still give their feedback afterwards. If this was the last scheduled interview, the application moves to Interview completed."
              : "This cannot be undone. Schedule a new interview if the candidate is given another chance."
          }
          confirmLabel={confirm === "complete" ? "Mark completed" : "Record no-show"}
          tone={confirm === "complete" ? "primary" : "danger"}
          busy={pending}
          onConfirm={() => run(confirm)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The interviewer's own feedback
// ---------------------------------------------------------------------------

export type FeedbackFormValues = Record<string, string | undefined>;

export function FeedbackForm({ interviewId, initial }: { interviewId: string; initial: FeedbackFormValues }) {
  const [state, formAction, pending] = useActionState(feedbackAction.bind(null, interviewId), EMPTY_FORM_STATE);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const intentRef = useRef<HTMLInputElement>(null);
  const values = state.values ?? initial;
  const errors = state.fieldErrors;
  const formKey = state.values ? JSON.stringify(state.values) : "initial";
  const send = (intent: "draft" | "submit") => {
    if (intentRef.current) intentRef.current.value = intent;
    setConfirmSubmit(false);
    formRef.current?.requestSubmit();
  };
  const savedDraft = state.done && !pending && !state.message && state.reference === "draft";

  return (
    <form key={formKey} ref={formRef} action={formAction} noValidate className="space-y-4">
      <input ref={intentRef} type="hidden" name="intent" defaultValue="draft" />
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        {RATING_CRITERIA.map((c) => (
          <Rating key={c.key} name={c.key} label={c.label} value={values[c.key]} error={errors[c.key]} />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Rating name="overallRating" label="Overall" value={values.overallRating} error={errors.overallRating} required />
        <Choice name="recommendation" label="Your recommendation" value={values.recommendation} error={errors.recommendation} required>
          {RECOMMENDATIONS.map((r) => (
            <option key={r} value={r}>
              {RECOMMENDATION_LABELS[r]}
            </option>
          ))}
        </Choice>
      </div>
      <Text name="strengths" label="Strengths" value={values.strengths} error={errors.strengths} />
      <Text name="weaknesses" label="Concerns" value={values.weaknesses} error={errors.weaknesses} />
      <Text name="notes" label="Other notes" value={values.notes} error={errors.notes} />
      <p className="text-xs text-fg-muted">
        Write about the interview only, in a way you would be comfortable for the candidate to read: they may ask to see what is held about them.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" loading={pending} onClick={() => send("draft")}>
          Save draft
        </Button>
        <Button size="sm" disabled={pending} onClick={() => setConfirmSubmit(true)}>
          Submit feedback
        </Button>
        {savedDraft && (
          <span role="status" className="text-xs text-success">
            Draft saved. Only you can see it.
          </span>
        )}
      </div>
      {confirmSubmit && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmSubmit(false)}
          title="Submit your feedback?"
          description="Once submitted it cannot be changed, and the other HR staff can read it."
          confirmLabel="Submit feedback"
          tone="primary"
          busy={pending}
          onConfirm={() => send("submit")}
        />
      )}
    </form>
  );
}

function Rating({ name, label, value, error, required }: { name: string; label: string; value?: string; error?: string; required?: boolean }) {
  return (
    <Choice name={name} label={label} value={value} error={error} required={required}>
      {[1, 2, 3, 4, 5].map((n) => (
        <option key={n} value={n}>
          {RATING_LABELS[n]}
        </option>
      ))}
    </Choice>
  );
}

function Choice({ name, label, value, error, required, children }: { name: string; label: string; value?: string; error?: string; required?: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {!required && <span className="ml-1 font-normal text-fg-subtle">(optional)</span>}
      </Label>
      <Select id={id} name={name} defaultValue={value ?? ""} aria-required={required || undefined} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined}>
        <option value="">{required ? "Choose…" : "No score"}</option>
        {children}
      </Select>
      {error && (
        <p id={`${id}-e`} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function Text({ name, label, value, error }: { name: string; label: string; value?: string; error?: string }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        <span className="ml-1 font-normal text-fg-subtle">(optional)</span>
      </Label>
      <Textarea
        id={id}
        name={name}
        rows={3}
        maxLength={INTERVIEW_LIMITS.feedbackText}
        defaultValue={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-e` : undefined}
      />
      {error && (
        <p id={`${id}-e`} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The hiring decision on an application
// ---------------------------------------------------------------------------

export function DecisionForm({ applicationId, current }: { applicationId: string; current: DecisionOutcome | null }) {
  const [state, formAction, pending] = useActionState(decisionAction.bind(null, applicationId), EMPTY_FORM_STATE);
  // React resets a form's fields after its action runs. The fields below are therefore uncontrolled and are
  // re-created from what the server sent back: empty after a success, the person's choice and words after a
  // refusal (the key changes whenever either changes).
  return <DecisionFields key={`${state.done ?? 0}:${JSON.stringify(state.values ?? {})}`} state={state} formAction={formAction} pending={pending} current={current} />;
}

function DecisionFields({ state, formAction, pending, current }: { state: FormState; formAction: (formData: FormData) => void; pending: boolean; current: DecisionOutcome | null }) {
  const [outcome, setOutcome] = useState<DecisionOutcome | "">((state.values?.outcome as DecisionOutcome) ?? "");
  const outcomeId = useId();
  const reasonId = useId();
  const errors = state.fieldErrors;
  const effect: Record<DecisionOutcome, string> = {
    SELECTED: "The application moves to Selected.",
    REJECTED: "The application is rejected, with this reason.",
    ON_HOLD: "The application stays in its current stage.",
  };
  return (
    <form action={formAction} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={outcomeId}>{current ? "Change the decision" : "Decision"}</Label>
        <Select
          id={outcomeId}
          name="outcome"
          defaultValue={outcome}
          onChange={(e) => setOutcome(e.target.value as DecisionOutcome | "")}
          aria-invalid={errors.outcome ? true : undefined}
          aria-describedby={errors.outcome ? `${outcomeId}-e` : undefined}
        >
          <option value="">Choose…</option>
          {DECISION_OUTCOMES.filter((o) => o !== current).map((o) => (
            <option key={o} value={o}>
              {DECISION_LABELS[o]}
            </option>
          ))}
        </Select>
        {outcome && <p className="text-xs text-fg-muted">{effect[outcome]}</p>}
        {errors.outcome && (
          <p id={`${outcomeId}-e`} className="text-xs font-medium text-danger">
            {errors.outcome}
          </p>
        )}
      </div>
      {outcome && (
        <div className="space-y-1.5">
          <Label htmlFor={reasonId}>Why</Label>
          <Textarea
            id={reasonId}
            name="rationale"
            rows={3}
            maxLength={INTERVIEW_LIMITS.rationale}
            required
            defaultValue={state.values?.rationale}
            aria-invalid={errors.rationale ? true : undefined}
            aria-describedby={errors.rationale ? `${reasonId}-e` : undefined}
            className="min-h-20"
          />
          <p className="text-xs text-fg-muted">For your team. The candidate does not see it.</p>
          {errors.rationale && (
            <p id={`${reasonId}-e`} className="text-xs font-medium text-danger">
              {errors.rationale}
            </p>
          )}
        </div>
      )}
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      <Button type="submit" size="sm" variant={outcome === "REJECTED" ? "danger" : "primary"} loading={pending} disabled={!outcome}>
        {outcome ? `Record: ${DECISION_LABELS[outcome]}` : "Record decision"}
      </Button>
    </form>
  );
}
