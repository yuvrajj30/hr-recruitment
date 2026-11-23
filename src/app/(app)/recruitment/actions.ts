"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { writeAudit } from "@/lib/auth/audit";
import type { AuthContext } from "@/lib/auth/context";
import { AuthError, UnauthorizedError } from "@/lib/auth/errors";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { RecruitmentError } from "@/lib/recruitment/errors";
import type { FormState } from "@/lib/recruitment/form-state";
import { formDataToJobFields, parseJobInput } from "@/lib/recruitment/job-input";
import { isJobAction } from "@/lib/recruitment/job-status";
import { changeJobStatus, createJob, type JobDeps, updateJob } from "@/lib/recruitment/jobs";
import { getClientIp } from "@/lib/security/client-ip";
import { logger } from "@/lib/security/logger";

// The entry points the job forms call. Anyone can POST to these directly, so each one checks the
// session itself, reads only the fields it expects, and hands the real decisions (permission,
// organisation, rules) to the service in src/lib/recruitment/jobs.ts.

async function actionContext(): Promise<{ ctx: AuthContext; deps: JobDeps }> {
  const ctx = await getCurrentAuth();
  if (!ctx) throw new UnauthorizedError("no session in server action");
  const rt = getAuthRuntime();
  const h = await headers();
  return {
    ctx,
    deps: {
      db: rt.db,
      now: rt.now(),
      writeAudit,
      client: {
        ipAddress: getClientIp(h, { hops: rt.trustedProxyHops, header: rt.clientIpHeader }),
        userAgent: h.get("user-agent"),
      },
    },
  };
}

function failure(error: unknown, action: string, values?: FormState["values"]): FormState {
  unstable_rethrow(error); // redirects and other Next.js signals are not failures
  if (error instanceof RecruitmentError) return { message: error.message, fieldErrors: error.fieldErrors ?? {}, values };
  if (error instanceof AuthError) {
    return {
      message: error.status === 401 ? "Your session has ended. Sign in again to continue." : "You do not have permission to do that.",
      fieldErrors: {},
      values,
    };
  }
  logger.error("recruitment.action_failed", { action, errorName: error instanceof Error ? error.name : typeof error });
  return { message: "Something went wrong and nothing was saved. Please try again.", fieldErrors: {}, values };
}

const singleString = (formData: FormData, key: string): string | null => {
  const v = formData.getAll(key);
  return v.length === 1 && typeof v[0] === "string" ? v[0] : null;
};

export async function createJobAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = formDataToJobFields(formData);
  const parsed = parseJobInput(values);
  if (!parsed.ok) return { message: "Check the highlighted fields.", fieldErrors: parsed.errors, values };
  let jobId: string;
  try {
    const { ctx, deps } = await actionContext();
    jobId = (await createJob(deps, ctx, parsed.value)).id;
  } catch (error) {
    return failure(error, "job.create", values);
  }
  redirect(`/recruitment/jobs/${jobId}?saved=created`);
}

export async function updateJobAction(jobId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const values = formDataToJobFields(formData);
  const parsed = parseJobInput(values);
  if (!parsed.ok) return { message: "Check the highlighted fields.", fieldErrors: parsed.errors, values };
  try {
    const { ctx, deps } = await actionContext();
    await updateJob(deps, ctx, jobId, parsed.value);
  } catch (error) {
    return failure(error, "job.update", values);
  }
  redirect(`/recruitment/jobs/${jobId}?saved=updated`);
}

export async function changeJobStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const jobId = singleString(formData, "jobId");
  const action = singleString(formData, "action");
  if (!jobId || !isJobAction(action)) return { message: "That change is not possible.", fieldErrors: {} };
  try {
    const { ctx, deps } = await actionContext();
    await changeJobStatus(deps, ctx, jobId, action);
  } catch (error) {
    return failure(error, `job.${action}`);
  }
  // A fresh address, so an older "Changes saved." notice from the URL is replaced by this one.
  redirect(`/recruitment/jobs/${jobId}?saved=${action}`);
}
