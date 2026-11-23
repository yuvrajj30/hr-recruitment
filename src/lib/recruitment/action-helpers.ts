import "server-only";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import type { AuthContext } from "@/lib/auth/context";
import { AuthError, UnauthorizedError } from "@/lib/auth/errors";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { logger } from "@/lib/security/logger";
import type { AppDeps, ResumeUpload } from "./applications";
import { RecruitmentError } from "./errors";
import type { FormState } from "./form-state";
import { checkResume, RESUME_MAX_BYTES } from "./resume";
import { recruitmentDeps } from "./runtime";

// Shared plumbing for the recruitment Server Actions. Anyone can POST to an action directly, so each
// one starts here: the real session is checked, and failures become safe messages (never internals).

export async function signedInAction(): Promise<{ ctx: AuthContext; deps: AppDeps }> {
  const ctx = await getCurrentAuth();
  if (!ctx) throw new UnauthorizedError("no session in server action");
  return { ctx, deps: recruitmentDeps(await headers()) };
}

export function actionFailure(error: unknown, action: string, values?: FormState["values"]): FormState {
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

// A form field that must be present exactly once and be text.
export function singleString(formData: FormData, key: string): string | null {
  const v = formData.getAll(key);
  return v.length === 1 && typeof v[0] === "string" ? v[0] : null;
}

export type ResumeRead = { ok: true; resume: ResumeUpload | null } | { ok: false; message: string };

// Reads and checks the uploaded resume. The size is checked BEFORE the file is read into memory.
export async function readResume(formData: FormData, required: boolean): Promise<ResumeRead> {
  const entries = formData.getAll("resume");
  const file = entries.length === 1 && typeof entries[0] !== "string" ? entries[0]! : null;
  if (!file || file.size === 0) return required ? { ok: false, message: "Attach your resume." } : { ok: true, resume: null };
  if (file.size > RESUME_MAX_BYTES) return { ok: false, message: "The resume must be 5 MB or smaller." };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkResume({ name: file.name, size: file.size }, bytes);
  if (!check.ok) return { ok: false, message: check.message };
  return { ok: true, resume: { bytes, kind: check.kind, safeName: check.safeName } };
}
