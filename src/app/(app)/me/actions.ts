"use server";

import { refresh } from "next/cache";
import { createRateLimiter, type RateLimiter } from "@/lib/recruitment/abuse";
import { actionFailure, signedInAction, singleString } from "@/lib/recruitment/action-helpers";
import type { FormState } from "@/lib/recruitment/form-state";
import { changeMyPassword, updateMyName } from "@/lib/users/self";

// Self-service actions. The account is always the one in the session; nothing here accepts a user id.

const done = (prev: FormState): FormState => ({ message: null, fieldErrors: {}, done: (prev.done ?? 0) + 1 });

// Wrong "current password" attempts are limited per account, so a forgotten browser session cannot be
// used to guess the password.
const globalForLimit = globalThis as unknown as { __hrSelfPasswordLimiter?: RateLimiter };
const limiter = () => (globalForLimit.__hrSelfPasswordLimiter ??= createRateLimiter(5, 15 * 60_000));

export async function updateNameAction(prev: FormState, formData: FormData): Promise<FormState> {
  const name = singleString(formData, "name") ?? "";
  try {
    const { ctx, deps } = await signedInAction();
    await updateMyName(deps, ctx, name);
  } catch (error) {
    return actionFailure(error, "self.name", { name });
  }
  refresh();
  return done(prev);
}

export async function changePasswordAction(prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { ctx, deps } = await signedInAction();
    if (!limiter().hit(ctx.user.id, deps.now)) {
      return { message: "Too many attempts. Wait a few minutes and try again.", fieldErrors: {} };
    }
    await changeMyPassword(deps, ctx, {
      currentPassword: singleString(formData, "currentPassword") ?? "",
      newPassword: singleString(formData, "newPassword") ?? "",
      confirmPassword: singleString(formData, "confirmPassword") ?? "",
    });
  } catch (error) {
    return actionFailure(error, "self.password");
  }
  return done(prev);
}
