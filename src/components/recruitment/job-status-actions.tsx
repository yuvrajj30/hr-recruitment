"use client";

import { useActionState, useRef, useState } from "react";
import { changeJobStatusAction } from "@/app/(app)/recruitment/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";
import { JOB_ACTION_LABELS, type JobAction } from "@/lib/recruitment/job-status";

// What each change means, said plainly before it happens.
const CONFIRM: Partial<Record<JobAction, { title: string; description: string; tone: "danger" | "primary" }>> = {
  publish: { title: "Publish this job?", description: "It becomes visible to candidates and starts accepting applications.", tone: "primary" },
  unpublish: { title: "Move back to draft?", description: "Candidates will no longer see it or be able to apply. Existing applications are kept.", tone: "danger" },
  close: { title: "Close applications?", description: "No new applications will be accepted. Candidates already in the pipeline are not affected.", tone: "danger" },
  archive: { title: "Archive this job?", description: "Archived jobs are kept for the record but can no longer be edited or reopened.", tone: "danger" },
};

export function JobStatusActions({ jobId, actions }: { jobId: string; actions: JobAction[] }) {
  const [state, formAction, pending] = useActionState(changeJobStatusAction, EMPTY_FORM_STATE);
  const [confirming, setConfirming] = useState<JobAction | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const actionRef = useRef<HTMLInputElement>(null);

  if (actions.length === 0) return null;

  const run = (action: JobAction) => {
    if (actionRef.current) actionRef.current.value = action;
    formRef.current?.requestSubmit();
  };

  const primary: JobAction | undefined = actions.find((a) => a === "publish" || a === "reopen");
  const dialog = confirming ? CONFIRM[confirming] : undefined;

  return (
    <div className="space-y-2">
      <form ref={formRef} action={formAction} className="flex flex-wrap justify-end gap-2" onSubmit={() => setConfirming(null)}>
        <input type="hidden" name="jobId" value={jobId} />
        <input ref={actionRef} type="hidden" name="action" defaultValue="" />
        {actions.map((a) => (
          <Button
            key={a}
            variant={a === primary ? "primary" : "secondary"}
            size="sm"
            disabled={pending}
            onClick={() => (CONFIRM[a] ? setConfirming(a) : run(a))}
          >
            {JOB_ACTION_LABELS[a]}
          </Button>
        ))}
      </form>
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      {confirming && dialog && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(null)}
          title={dialog.title}
          description={dialog.description}
          confirmLabel={JOB_ACTION_LABELS[confirming]}
          tone={dialog.tone}
          busy={pending}
          onConfirm={() => run(confirming)}
        />
      )}
    </div>
  );
}
