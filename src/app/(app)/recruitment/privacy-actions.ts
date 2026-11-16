"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { actionFailure, signedInAction, singleString } from "@/lib/recruitment/action-helpers";
import type { FormState } from "@/lib/recruitment/form-state";
import { removeCandidate, updatePrivacySettings } from "@/lib/recruitment/privacy";

// Candidate privacy: the organisation's notice settings (Super Admins) and removing a candidate's personal
// data (Super Admins and HR Managers). Each action checks the session; the services and the database check
// the permission again.

export async function savePrivacySettingsAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = {
    noticeName: singleString(formData, "noticeName") ?? "",
    contactEmail: singleString(formData, "contactEmail") ?? "",
    retentionMonths: singleString(formData, "retentionMonths") ?? "",
  };
  try {
    const { ctx, deps } = await signedInAction();
    await updatePrivacySettings(deps, ctx, values);
  } catch (error) {
    return actionFailure(error, "privacy.settings", values);
  }
  refresh();
  return { message: null, fieldErrors: {}, done: (prev.done ?? 0) + 1 };
}

export async function removeCandidateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const candidateId = singleString(formData, "candidateId");
  if (!candidateId) return { message: "That candidate could not be found.", fieldErrors: {} };
  let notDeleted = 0;
  try {
    const { ctx, deps } = await signedInAction();
    notDeleted = (await removeCandidate(deps, ctx, candidateId)).filesNotDeleted;
  } catch (error) {
    return actionFailure(error, "privacy.remove_candidate");
  }
  redirect(`/recruitment/privacy?removed=1${notDeleted > 0 ? `&filesLeft=${notDeleted}` : ""}`);
}
