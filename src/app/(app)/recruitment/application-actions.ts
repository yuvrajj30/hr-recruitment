"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { actionFailure, readResume, signedInAction, singleString } from "@/lib/recruitment/action-helpers";
import { formDataToApplicationFields, parseApplicationInput } from "@/lib/recruitment/application-input";
import { addApplicationNote, assignRecruiter, createApplicationManually, moveApplicationStage } from "@/lib/recruitment/applications";
import { updateCandidateNotes } from "@/lib/recruitment/candidates";
import type { FormState } from "@/lib/recruitment/form-state";
import { isPipelineStage } from "@/lib/recruitment/stages";

// Entry points for the signed-in application screens. Each one checks the session itself, reads only
// the fields it expects, and leaves every decision (permission, organisation, visibility, rules)
// to the services in src/lib/recruitment.

const done = (prev: FormState): FormState => ({ message: null, fieldErrors: {}, done: (prev.done ?? 0) + 1 });

// An HR user entering an application by hand.
export async function createApplicationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = { ...formDataToApplicationFields(formData), jobId: singleString(formData, "jobId") ?? undefined };
  const parsed = parseApplicationInput(values);
  const fieldErrors: Record<string, string> = parsed.ok ? {} : { ...parsed.errors };
  if (!values.jobId) fieldErrors.jobId = "Choose the job this application is for.";
  if (singleString(formData, "consent") !== "yes") fieldErrors.consent = "Confirm that the candidate agreed to their details being kept.";
  const file = await readResume(formData, false);
  if (!file.ok) fieldErrors.resume = file.message;
  if (!parsed.ok || !file.ok || Object.keys(fieldErrors).length > 0) {
    return { message: "Check the highlighted fields.", fieldErrors, values };
  }
  let applicationId: string;
  try {
    const { ctx, deps } = await signedInAction();
    applicationId = (await createApplicationManually(deps, ctx, values.jobId!, parsed.value, file.resume)).id;
  } catch (error) {
    return actionFailure(error, "application.create", values);
  }
  redirect(`/recruitment/applications/${applicationId}?saved=created`);
}

export async function moveStageAction(prev: FormState, formData: FormData): Promise<FormState> {
  const applicationId = singleString(formData, "applicationId");
  const to = singleString(formData, "to");
  if (!applicationId || !isPipelineStage(to)) return { message: "That move is not possible.", fieldErrors: {} };
  try {
    const { ctx, deps } = await signedInAction();
    await moveApplicationStage(deps, ctx, applicationId, to, singleString(formData, "reason"));
  } catch (error) {
    return actionFailure(error, "application.move_stage");
  }
  refresh();
  return done(prev);
}

export async function assignRecruiterAction(prev: FormState, formData: FormData): Promise<FormState> {
  const applicationId = singleString(formData, "applicationId");
  const recruiterId = singleString(formData, "recruiterId");
  if (!applicationId || recruiterId === null) return { message: "Choose a recruiter from the list.", fieldErrors: {} };
  try {
    const { ctx, deps } = await signedInAction();
    await assignRecruiter(deps, ctx, applicationId, recruiterId === "" ? null : recruiterId);
  } catch (error) {
    return actionFailure(error, "application.assign");
  }
  refresh();
  return done(prev);
}

export async function addNoteAction(prev: FormState, formData: FormData): Promise<FormState> {
  const applicationId = singleString(formData, "applicationId");
  const body = singleString(formData, "body");
  if (!applicationId || body === null) return { message: "Write something before saving the note.", fieldErrors: {} };
  try {
    const { ctx, deps } = await signedInAction();
    await addApplicationNote(deps, ctx, applicationId, body);
  } catch (error) {
    return actionFailure(error, "application.note", { body });
  }
  refresh();
  return done(prev);
}

export async function updateCandidateNotesAction(prev: FormState, formData: FormData): Promise<FormState> {
  const candidateId = singleString(formData, "candidateId");
  const notes = singleString(formData, "notes");
  if (!candidateId || notes === null) return { message: "The notes could not be saved.", fieldErrors: {} };
  try {
    const { ctx, deps } = await signedInAction();
    await updateCandidateNotes(deps, ctx, candidateId, notes);
  } catch (error) {
    return actionFailure(error, "candidate.notes", { notes });
  }
  refresh();
  return done(prev);
}
