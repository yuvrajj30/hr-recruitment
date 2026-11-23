"use server";

import { cookies, headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { sessionCookieName } from "@/lib/auth/cookies";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { createRateLimiter, type RateLimiter } from "@/lib/recruitment/abuse";
import { singleString } from "@/lib/recruitment/action-helpers";
import { RecruitmentError } from "@/lib/recruitment/errors";
import type { FormState } from "@/lib/recruitment/form-state";
import { getClientIp } from "@/lib/security/client-ip";
import { logger } from "@/lib/security/logger";
import { hashToken, isWellFormedToken } from "@/lib/security/tokens";
import { acceptInvitation, LINK_NOT_VALID } from "@/lib/users/accept";

// Accepting an invitation. Public (the person has no session yet), so everything is checked here and
// again in the database. Attempts per link are limited, so an "existing account" password cannot be
// guessed through an invitation link.

const globalForLimit = globalThis as unknown as { __hrInviteLimiter?: RateLimiter };
const limiter = () => (globalForLimit.__hrInviteLimiter ??= createRateLimiter(8, 15 * 60_000));

export async function acceptInvitationAction(token: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const values = { name: singleString(formData, "name") ?? "" };
  try {
    if (!isWellFormedToken(token)) return { message: LINK_NOT_VALID, fieldErrors: {} };
    const rt = getAuthRuntime();
    const now = rt.now();
    if (!limiter().hit(hashToken(token), now)) {
      return { message: "Too many attempts with this link. Wait a few minutes and try again.", fieldErrors: {}, values };
    }
    const h = await headers();
    const result = await acceptInvitation(
      {
        db: rt.db,
        now,
        timings: rt.timings,
        client: { ipAddress: getClientIp(h, { hops: rt.trustedProxyHops, header: rt.clientIpHeader }), userAgent: h.get("user-agent") },
      },
      token,
      {
        name: values.name,
        password: singleString(formData, "password") ?? "",
        confirmPassword: singleString(formData, "confirmPassword") ?? undefined,
      },
    );
    // The same cookie that signing in sets: HttpOnly, SameSite=Lax, Secure on https, until the hard deadline.
    const https = new URL(rt.appOrigin).protocol === "https:";
    (await cookies()).set(sessionCookieName(rt.appOrigin), result.sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: https,
      path: "/",
      expires: result.absoluteExpiresAt,
      maxAge: Math.max(0, Math.floor((result.absoluteExpiresAt.getTime() - now.getTime()) / 1000)),
    });
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof RecruitmentError) return { message: error.message, fieldErrors: error.fieldErrors ?? {}, values };
    logger.error("invitation.accept_failed", { errorName: error instanceof Error ? error.name : typeof error });
    return { message: "Something went wrong and your account was not set up. Please try again.", fieldErrors: {}, values };
  }
  redirect("/dashboard");
}
