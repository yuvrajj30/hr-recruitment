"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { isRoleKey } from "@/lib/auth/roles";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { actionFailure, signedInAction, singleString } from "@/lib/recruitment/action-helpers";
import type { FormState } from "@/lib/recruitment/form-state";
import { recruitmentDeps } from "@/lib/recruitment/runtime";
import { changeRole, createInvitation, resendInvitation, revokeInvitation, setHrCanInviteEmployees, setMemberStatus, type UserDeps } from "@/lib/users/members";

// Entry points for the User and Role Management page. Each checks the session itself and reads only the
// fields it expects; the service (src/lib/users/members.ts) and the database decide what is allowed.

async function deps(): Promise<UserDeps> {
  const base = recruitmentDeps(await headers());
  return { db: base.db, now: base.now, writeAudit: base.writeAudit, client: base.client, appOrigin: getAuthRuntime().appOrigin };
}

const done = (prev: FormState, extra: Partial<FormState> = {}): FormState => ({ message: null, fieldErrors: {}, done: (prev.done ?? 0) + 1, ...extra });

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "Enter an email address.").max(254).pipe(z.email("Enter a valid email address.")),
  name: z.string().trim().min(2, "Enter the person's name.").max(120, "Keep the name under 120 characters."),
  role: z.string().refine(isRoleKey, "Choose a role."),
});

export async function inviteAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = { email: singleString(formData, "email") ?? "", name: singleString(formData, "name") ?? "", role: singleString(formData, "role") ?? "" };
  const parsed = inviteSchema.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) if (typeof issue.path[0] === "string" && !fieldErrors[issue.path[0]]) fieldErrors[issue.path[0]] = issue.message;
    return { message: "Check the highlighted fields.", fieldErrors, values };
  }
  try {
    const { ctx } = await signedInAction();
    const r = await createInvitation(await deps(), ctx, { email: parsed.data.email, name: parsed.data.name, role: parsed.data.role as never });
    refresh();
    // The link is returned once, to the person who created it. Only its hash is stored.
    return done(prev, { reference: r.link });
  } catch (error) {
    return actionFailure(error, "invitation.create", values);
  }
}

export async function invitationAction(prev: FormState, formData: FormData): Promise<FormState> {
  const id = singleString(formData, "invitationId");
  const op = singleString(formData, "op");
  if (!id || (op !== "revoke" && op !== "resend")) return { message: "That change is not possible.", fieldErrors: {} };
  try {
    const { ctx } = await signedInAction();
    if (op === "revoke") {
      await revokeInvitation(await deps(), ctx, id);
      refresh();
      return done(prev);
    }
    const r = await resendInvitation(await deps(), ctx, id);
    refresh();
    return done(prev, { reference: r.link });
  } catch (error) {
    return actionFailure(error, `invitation.${op}`);
  }
}

export async function memberAction(prev: FormState, formData: FormData): Promise<FormState> {
  const memberId = singleString(formData, "memberId");
  const op = singleString(formData, "op");
  if (!memberId) return { message: "That change is not possible.", fieldErrors: {} };
  try {
    const { ctx } = await signedInAction();
    if (op === "deactivate" || op === "reactivate") {
      await setMemberStatus(await deps(), ctx, memberId, op === "deactivate" ? "SUSPENDED" : "ACTIVE");
    } else if (op === "role") {
      const role = singleString(formData, "role");
      if (!isRoleKey(role)) return { message: "Choose a role.", fieldErrors: {} };
      await changeRole(await deps(), ctx, memberId, role);
    } else {
      return { message: "That change is not possible.", fieldErrors: {} };
    }
  } catch (error) {
    return actionFailure(error, `member.${op}`);
  }
  refresh();
  return done(prev);
}

export async function inviteSettingAction(prev: FormState, formData: FormData): Promise<FormState> {
  const value = singleString(formData, "hrCanInviteEmployees");
  if (value !== "on" && value !== "off") return { message: "That change is not possible.", fieldErrors: {} };
  try {
    const { ctx } = await signedInAction();
    await setHrCanInviteEmployees(await deps(), ctx, value === "on");
  } catch (error) {
    return actionFailure(error, "settings.hr_invite");
  }
  refresh();
  return done(prev);
}
