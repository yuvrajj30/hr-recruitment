"use server";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { readResume, singleString } from "@/lib/recruitment/action-helpers";
import { allowPublicApplication, checkFormToken, getApplyLimiters, TRAP_FIELD } from "@/lib/recruitment/abuse";
import { formDataToApplicationFields, parseApplicationInput } from "@/lib/recruitment/application-input";
import { applyPublicly } from "@/lib/recruitment/applications";
import { RecruitmentError } from "@/lib/recruitment/errors";
import type { FormState } from "@/lib/recruitment/form-state";
import { recruitmentDeps } from "@/lib/recruitment/runtime";
import { logger } from "@/lib/security/logger";

// The one public way to create an application. There is no sign-in, so nothing from the browser is
// trusted: the job is looked up again from its public address, every field is validated, the resume's
// real content is checked, and submissions are rate limited.
//
// The organisation and the stage are never taken from the form: the job decides the organisation,
// and a new application always starts at "Applied".

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const fail = (message: string, values?: FormState["values"], fieldErrors: Record<string, string> = {}): FormState => ({ message, fieldErrors, values });

export async function submitApplicationAction(organizationSlug: string, jobSlug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const values = formDataToApplicationFields(formData);
  try {
    if (!SLUG.test(organizationSlug) || !SLUG.test(jobSlug)) return fail("This job is no longer available.");

    // 1. The hidden trap field. People never see it; a filled one means an automated submission.
    //    The answer looks like any other failure, so a bot learns nothing.
    if ((singleString(formData, TRAP_FIELD) ?? "x") !== "") return fail("We could not accept this submission. Please try again.", values);

    // 2. The signed time stamp issued with the form.
    const rt = getAuthRuntime();
    const now = rt.now();
    const token = checkFormToken(rt.authSecret, `${organizationSlug}/${jobSlug}`, singleString(formData, "formToken"), now);
    if (token === "too_fast") return fail("Please take a moment to check your details, then submit again.", values);
    if (token !== "ok") return fail("This form has been open for too long. Reload the page and fill it in again.", values);

    // 3. The details themselves.
    const parsed = parseApplicationInput(values);
    const fieldErrors: Record<string, string> = parsed.ok ? {} : { ...parsed.errors };
    if (singleString(formData, "consent") !== "yes") fieldErrors.consent = "Please agree so that we can process your application.";
    const file = await readResume(formData, true);
    if (!file.ok) fieldErrors.resume = file.message;
    if (!parsed.ok || !file.ok || !file.resume || Object.keys(fieldErrors).length > 0) return fail("Please check the highlighted fields.", values, fieldErrors);

    // 4. Rate limits, counted only for submissions that were otherwise valid.
    const deps = recruitmentDeps(await headers());
    if (!allowPublicApplication(getApplyLimiters(), { ipAddress: deps.client.ipAddress, email: parsed.value.email }, now)) {
      return fail("Too many applications have been sent in a short time. Please try again in a little while.", values);
    }

    const created = await applyPublicly(deps, { organizationSlug, jobSlug }, parsed.value, file.resume);
    return { message: null, fieldErrors: {}, reference: created.referenceNumber, done: 1 };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof RecruitmentError) {
      if (error.code === "not_found") return fail("This job is no longer available.");
      return fail(error.message, error.code === "duplicate" ? undefined : values);
    }
    logger.error("recruitment.public_apply_failed", { errorName: error instanceof Error ? error.name : typeof error });
    return fail("Something went wrong and your application was not sent. Please try again.", values);
  }
}
