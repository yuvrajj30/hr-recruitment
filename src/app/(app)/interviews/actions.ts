"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import {
  cancelInterview,
  recordDecision,
  recordInterviewOutcome,
  saveFeedback,
  scheduleInterview,
  updateInterview,
} from "@/lib/interviews/interviews";
import {
  formDataToFeedbackFields,
  formDataToScheduleFields,
  parseCancelReason,
  parseDecisionInput,
  parseFeedbackInput,
  parseScheduleInput,
} from "@/lib/interviews/rules";
import { actionFailure, signedInAction, singleString } from "@/lib/recruitment/action-helpers";
import type { FormState } from "@/lib/recruitment/form-state";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";

// Entry points for the interview screens. Each one checks the session itself, reads only the fields it
// expects, and leaves every decision (permission, organisation, who may take part, what may change) to the
// service in src/lib/interviews and to the database.

const done = (prev: FormState): FormState => ({ message: null, fieldErrors: {}, done: (prev.done ?? 0) + 1 });

// The values to give back to a rejected form (participants travel as a comma-separated list).
function scheduleValues(formData: FormData): Record<string, string | undefined> {
  const f = formDataToScheduleFields(formData);
  return { ...f, participantIds: (f.participantIds ?? []).join(",") };
}

export async function scheduleInterviewAction(applicationId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const values = scheduleValues(formData);
  let interviewId: string;
  try {
    const { ctx, deps } = await signedInAction();
    const { timezone } = await getOrganizationSettings(deps.db, ctx);
    const parsed = parseScheduleInput(formDataToScheduleFields(formData), { timeZone: timezone, now: deps.now });
    if (!parsed.ok) return { message: "Check the highlighted fields.", fieldErrors: parsed.errors, values };
    interviewId = (await scheduleInterview(deps, ctx, applicationId, parsed.value)).id;
  } catch (error) {
    return actionFailure(error, "interview.schedule", values);
  }
  redirect(`/interviews/${interviewId}?saved=scheduled`);
}

export async function updateInterviewAction(interviewId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const values = scheduleValues(formData);
  try {
    const { ctx, deps } = await signedInAction();
    const { timezone } = await getOrganizationSettings(deps.db, ctx);
    // An unchanged start time that has already passed is fine when editing (only a NEW time must be ahead).
    const parsed = parseScheduleInput(formDataToScheduleFields(formData), { timeZone: timezone, now: deps.now, requireFuture: false });
    if (!parsed.ok) return { message: "Check the highlighted fields.", fieldErrors: parsed.errors, values };
    await updateInterview(deps, ctx, interviewId, parsed.value);
  } catch (error) {
    return actionFailure(error, "interview.update", values);
  }
  redirect(`/interviews/${interviewId}?saved=updated`);
}

// Completed, no-show or cancelled (the buttons on a scheduled interview).
export async function interviewStatusAction(prev: FormState, formData: FormData): Promise<FormState> {
  const interviewId = singleString(formData, "interviewId");
  const op = singleString(formData, "op");
  if (!interviewId || (op !== "complete" && op !== "no_show" && op !== "cancel")) return { message: "That change is not possible.", fieldErrors: {} };
  const reason = singleString(formData, "reason");
  try {
    const { ctx, deps } = await signedInAction();
    if (op === "cancel") {
      const parsed = parseCancelReason(reason);
      if (!parsed.ok) return { message: parsed.errors.reason ?? "Say why the interview is cancelled.", fieldErrors: parsed.errors, values: { reason: reason ?? "" } };
      await cancelInterview(deps, ctx, interviewId, parsed.value);
    } else {
      await recordInterviewOutcome(deps, ctx, interviewId, op === "complete" ? "COMPLETED" : "NO_SHOW");
    }
  } catch (error) {
    return actionFailure(error, `interview.${op}`, { reason: reason ?? "" });
  }
  refresh();
  return done(prev);
}

export async function feedbackAction(interviewId: string, prev: FormState, formData: FormData): Promise<FormState> {
  const fields = formDataToFeedbackFields(formData);
  const intent = singleString(formData, "intent") === "submit" ? "submit" : "draft";
  const values = { ...fields } as Record<string, string | undefined>;
  const parsed = parseFeedbackInput(fields, intent);
  if (!parsed.ok) return { message: intent === "submit" ? "Complete the highlighted fields before submitting." : "Check the highlighted fields.", fieldErrors: parsed.errors, values };
  try {
    const { ctx, deps } = await signedInAction();
    await saveFeedback(deps, ctx, interviewId, parsed.value, intent);
  } catch (error) {
    return actionFailure(error, "feedback.save", values);
  }
  refresh();
  return { ...done(prev), values, reference: intent };
}

export async function decisionAction(applicationId: string, prev: FormState, formData: FormData): Promise<FormState> {
  const values = { outcome: singleString(formData, "outcome") ?? undefined, rationale: singleString(formData, "rationale") ?? undefined };
  const parsed = parseDecisionInput(values);
  if (!parsed.ok) return { message: "Check the highlighted fields.", fieldErrors: parsed.errors, values };
  try {
    const { ctx, deps } = await signedInAction();
    await recordDecision(deps, ctx, applicationId, parsed.value);
  } catch (error) {
    return actionFailure(error, "decision.record", values);
  }
  refresh();
  return done(prev);
}
