"use client";

import Link from "next/link";
import { type DragEvent, startTransition, useActionState, useId, useState } from "react";
import { moveStageAction } from "@/app/(app)/recruitment/application-actions";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/dialog";
import { focusRing } from "@/components/ui/focus";
import { Label, Textarea } from "@/components/ui/input";
import type { ApplicationListItem, PipelineColumn } from "@/lib/recruitment/applications";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";
import { formatDate } from "@/lib/recruitment/labels";
import { allowedMoves, MAX_REASON_LENGTH, type MoveKind, moveKind, moveNeedsReason, type PipelineStage, STAGE_LABELS } from "@/lib/recruitment/stages";
import { cn } from "@/lib/ui/cn";

// The pipeline board: one column per stage, one card per application.
//
// Two ways to move a card, both ending in the same server action (which re-checks everything):
//   - drag it to another column with a mouse, or
//   - use the "Move to" menu on the card, which works with a keyboard, a screen reader and on a phone.
// Moves that need a reason (rejecting, moving back, reopening) ask for it first.

type Pending = { application: ApplicationListItem; to: PipelineStage; kind: MoveKind };

export function PipelineBoard({ columns, timeZone, canMove, limit }: { columns: PipelineColumn[]; timeZone: string; canMove: boolean; limit: number }) {
  const [state, dispatch, busy] = useActionState(moveStageAction, EMPTY_FORM_STATE);
  const [dragging, setDragging] = useState<ApplicationListItem | null>(null);
  const [over, setOver] = useState<PipelineStage | null>(null);
  const [asking, setAsking] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const reasonId = useId();

  const send = (application: ApplicationListItem, to: PipelineStage, why: string) => {
    const data = new FormData();
    data.set("applicationId", application.id);
    data.set("to", to);
    data.set("reason", why);
    startTransition(() => dispatch(data));
  };

  const request = (application: ApplicationListItem, to: PipelineStage) => {
    setNotice(null);
    const kind = moveKind(application.stage, to);
    if (!kind) {
      if (application.stage !== to) setNotice(`${application.candidate.name} cannot move from ${STAGE_LABELS[application.stage]} to ${STAGE_LABELS[to]}.`);
      return;
    }
    if (moveNeedsReason(kind)) {
      setReason("");
      setReasonError(false);
      setAsking({ application, to, kind });
    } else {
      send(application, to, "");
    }
  };

  const onDrop = (event: DragEvent, to: PipelineStage) => {
    event.preventDefault();
    setOver(null);
    if (dragging) request(dragging, to);
    setDragging(null);
  };

  return (
    <div className="space-y-3">
      {(notice || state.message) && <Alert tone="danger">{notice ?? state.message}</Alert>}
      <p className="sr-only" role="status">
        {busy ? "Moving the application…" : ""}
      </p>

      <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        <ol className={cn("flex min-w-max gap-3", busy && "opacity-70")} aria-label="Pipeline stages">
          {columns.map((column) => (
            <li
              key={column.stage}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                setOver(column.stage);
              }}
              onDragLeave={() => setOver((s) => (s === column.stage ? null : s))}
              onDrop={(e) => onDrop(e, column.stage)}
              className={cn(
                "flex w-64 shrink-0 flex-col rounded-[10px] border border-border bg-surface-muted/60",
                over === column.stage && dragging && moveKind(dragging.stage, column.stage) && "border-accent bg-accent-soft",
              )}
            >
              <h2 className="flex items-center justify-between px-3 pt-3 pb-2 text-[13px] font-semibold text-fg">
                {STAGE_LABELS[column.stage]}
                <span className="tabular rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-fg-muted">{column.total}</span>
              </h2>
              <ul className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2">
                {column.items.map((a) => (
                  <li
                    key={a.id}
                    draggable={canMove && !busy}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", a.referenceNumber);
                      setDragging(a);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    className={cn("rounded-md border border-border bg-surface p-2.5 text-[13px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]", canMove && "cursor-grab", dragging?.id === a.id && "opacity-50")}
                  >
                    <Link href={`/recruitment/applications/${a.id}`} className={cn("font-medium text-fg hover:text-accent hover:underline", focusRing)}>
                      {a.candidate.name}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-fg-muted">{a.job.title}</p>
                    <p className="mt-1 text-xs text-fg-subtle">
                      Applied {formatDate(a.appliedAt, timeZone)} · {a.recruiter?.name ?? "Unassigned"}
                    </p>
                    {canMove && allowedMoves(a.stage).length > 0 && (
                      <label className="mt-2 block">
                        <span className="sr-only">Move {a.candidate.name} to another stage</span>
                        <select
                          value=""
                          disabled={busy}
                          onChange={(e) => e.target.value && request(a, e.target.value as PipelineStage)}
                          className={cn("block h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-xs text-fg-muted", focusRing)}
                        >
                          <option value="">Move to…</option>
                          {allowedMoves(a.stage).map((m) => (
                            <option key={m.to} value={m.to}>
                              {STAGE_LABELS[m.to]}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </li>
                ))}
                {column.items.length === 0 && <li className="px-1 py-4 text-center text-xs text-fg-subtle">No applications</li>}
                {column.total > column.items.length && (
                  <li className="px-1 pt-1 text-center text-xs text-fg-muted">
                    Showing the {limit} most recent of {column.total}. Use the filters, or the Applications list, to see the rest.
                  </li>
                )}
              </ul>
            </li>
          ))}
        </ol>
      </div>

      {asking && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setAsking(null)}
          title={asking.kind === "reject" ? `Reject ${asking.application.candidate.name}?` : `Move ${asking.application.candidate.name} to ${STAGE_LABELS[asking.to]}?`}
          tone={asking.kind === "reject" ? "danger" : "primary"}
          confirmLabel={asking.kind === "reject" ? "Reject application" : "Move"}
          busy={busy}
          onConfirm={() => {
            if (!reason.trim()) {
              setReasonError(true); // stay open and say what is missing
              return;
            }
            send(asking.application, asking.to, reason);
            setAsking(null);
          }}
          description={
            <div className="space-y-1.5 text-left">
              <Label htmlFor={reasonId}>
                {asking.kind === "reject" ? "Reason for rejecting" : asking.kind === "restore" ? "Why is it being reopened?" : "Why is it moving back?"}
              </Label>
              <Textarea
                id={reasonId}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (e.target.value.trim()) setReasonError(false);
                }}
                rows={3}
                maxLength={MAX_REASON_LENGTH}
                autoFocus
                required
                aria-invalid={reasonError || undefined}
                aria-describedby={`${reasonId}-help`}
                className="min-h-20"
              />
              <p id={`${reasonId}-help`} className={cn("text-xs", reasonError && "font-medium text-danger")} role={reasonError ? "alert" : undefined}>
                {reasonError ? "Enter a reason before continuing." : "Required. Saved in the application’s history; the candidate does not see it."}
              </p>
            </div>
          }
        />
      )}
    </div>
  );
}
