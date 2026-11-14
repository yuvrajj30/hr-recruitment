import "server-only";
import { checkSameOrigin } from "@/lib/security/origin";
import { getClientIp } from "@/lib/security/client-ip";
import { logger } from "@/lib/security/logger";
import { readJsonBody } from "@/lib/http/body";
import { errorResponse, jsonResponse } from "@/lib/http/responses";
import { REQUEST_LIMITS } from "./config";
import { type AuthContext, getAuthContext } from "./context";
import { buildClearedSessionCookie, buildSessionCookie, readSessionToken, sessionCookieName } from "./cookies";
import { loginWithPassword } from "./login-service";
import { switchActiveOrganization } from "./org-switch";
import { sanitizeRedirectPath } from "./redirect";
import type { AuthRuntime } from "./runtime";
import { loginBodySchema, switchOrganizationBodySchema } from "./schemas";
import { purgeEndedSessions, revokeAllSessionsForUser, revokeSessionByToken } from "./session-store";
import { purgeOldLoginAttempts } from "./throttle";

// The five auth endpoints as plain functions: Request in, Response out, everything else passed in
// through `rt`. The files under src/app/api/auth/ are thin wrappers around these.

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

// Blocks requests that were not sent from our own pages (cross-site request forgery).
const crossSiteRefusal = (request: Request, rt: AuthRuntime): Response | null =>
  checkSameOrigin(request, rt.appOrigin).ok ? null : errorResponse("forbidden", 403);

const clientInfo = (request: Request, rt: AuthRuntime) => ({
  // null unless the address can be trusted (see client-ip.ts): forged headers are ignored.
  ipAddress: getClientIp(request.headers, { hops: rt.trustedProxyHops, header: rt.clientIpHeader }),
  userAgent: request.headers.get("user-agent"),
});

const cookieToken = (request: Request, rt: AuthRuntime) =>
  readSessionToken(request.headers.get("cookie"), rt.appOrigin);

// True when the browser sent a session cookie at all (even a broken one), so we know to tidy it away.
const sentSessionCookie = (request: Request, rt: AuthRuntime) =>
  (request.headers.get("cookie") ?? "").includes(`${sessionCookieName(rt.appOrigin)}=`);

async function authenticate(request: Request, rt: AuthRuntime, touch: boolean): Promise<AuthContext | null> {
  const token = cookieToken(request, rt);
  if (!token) return null;
  const result = await getAuthContext(rt.db, token, { now: rt.now(), timings: rt.timings, touch });
  return result.ok ? result.ctx : null; // the reason is never shown to the browser
}

const unauthorized = (request: Request, rt: AuthRuntime): Response =>
  errorResponse("unauthorized", 401, {
    cookies: sentSessionCookie(request, rt) ? [buildClearedSessionCookie(rt.appOrigin)] : [],
  });

function scheduleCleanup(rt: AuthRuntime): void {
  if (!rt.shouldRunCleanup()) return;
  rt.runLater(async () => {
    try {
      const now = rt.now();
      await purgeOldLoginAttempts(rt.db, now, rt.retention.loginAttemptDays);
      await purgeEndedSessions(rt.db, now, rt.retention.sessionDays);
    } catch (error) {
      logger.warn("auth.cleanup_failed", { errorName: error instanceof Error ? error.name : typeof error });
    }
  });
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

export async function handleLogin(request: Request, rt: AuthRuntime): Promise<Response> {
  const refused = crossSiteRefusal(request, rt);
  if (refused) return refused;

  const body = await readJsonBody(request, REQUEST_LIMITS.maxBodyBytes);
  if (!body.ok) return errorResponse(body.code, body.status);
  const parsed = loginBodySchema.safeParse(body.value);
  if (!parsed.success) return errorResponse("invalid_request", 400); // no field details: nothing to learn

  const { ipAddress, userAgent } = clientInfo(request, rt);
  const now = rt.now();
  const result = await loginWithPassword(
    rt.db,
    {
      email: parsed.data.email,
      password: parsed.data.password,
      ipAddress,
      userAgent,
      now,
      timings: rt.timings,
      authSecret: rt.authSecret,
    },
    rt.deps,
  );

  if (!result.ok) {
    if (result.reason === "throttled") {
      return errorResponse("too_many_attempts", 429, {
        headers: { "retry-after": String(result.retryAfterSeconds) },
        extra: { retryAfterSeconds: result.retryAfterSeconds },
      });
    }
    return errorResponse("invalid_credentials", 401); // identical for every kind of failure
  }

  // If the browser still held an older session, end it so it cannot linger unused.
  const oldToken = cookieToken(request, rt);
  if (oldToken) await revokeSessionByToken(rt.db, oldToken, "logout", now).catch(() => {});
  scheduleCleanup(rt);

  return jsonResponse(
    {
      user: result.user,
      organization: result.organization,
      redirectTo: sanitizeRedirectPath(parsed.data.next),
    },
    200,
    {
      cookies: [
        buildSessionCookie({ appOrigin: rt.appOrigin, token: result.token, absoluteExpiresAt: result.absoluteExpiresAt, now }),
      ],
    },
  );
}

// ---------------------------------------------------------------------------
// POST /api/auth/logout   (safe to repeat; works even when already signed out)
// ---------------------------------------------------------------------------

export async function handleLogout(request: Request, rt: AuthRuntime): Promise<Response> {
  const refused = crossSiteRefusal(request, rt); // so another site cannot sign people out
  if (refused) return refused;

  const cleared = [buildClearedSessionCookie(rt.appOrigin)];
  const token = cookieToken(request, rt);
  if (token) {
    const now = rt.now();
    try {
      const result = await revokeSessionByToken(rt.db, token, "logout", now);
      if (result.revoked) {
        const { ipAddress, userAgent } = clientInfo(request, rt);
        // The session is already ended; a failing audit write must not stop the person from signing out.
        await rt.deps
          .writeAudit(rt.db, {
            organizationId: result.organizationId,
            actorUserId: result.userId,
            action: "auth.logout",
            entityType: "session",
            entityId: null,
            ipAddress,
            userAgent,
            now,
          })
          .catch((error: unknown) =>
            logger.error("auth.logout_audit_failed", { errorName: error instanceof Error ? error.name : typeof error }),
          );
      }
    } catch (error) {
      // The database could not be reached. Still remove the cookie from the browser, but say it failed.
      logger.error("auth.logout_failed", { errorName: error instanceof Error ? error.name : typeof error });
      return errorResponse("server_error", 500, { cookies: cleared });
    }
  }
  return jsonResponse({ ok: true }, 200, { cookies: cleared });
}

// ---------------------------------------------------------------------------
// POST /api/auth/logout-all
// ---------------------------------------------------------------------------

export async function handleLogoutAll(request: Request, rt: AuthRuntime): Promise<Response> {
  const refused = crossSiteRefusal(request, rt);
  if (refused) return refused;
  const ctx = await authenticate(request, rt, false);
  if (!ctx) return unauthorized(request, rt);

  const now = rt.now();
  const { ipAddress, userAgent } = clientInfo(request, rt);
  // The sessions are ended and the audit record written together, or not at all.
  const revoked = await rt.db.$transaction(async (tx) => {
    const count = await revokeAllSessionsForUser(tx, ctx.user.id, "logout_all", now);
    await rt.deps.writeAudit(tx, {
      organizationId: ctx.organization?.id ?? null,
      actorUserId: ctx.user.id,
      action: "auth.logout_all",
      entityType: "user",
      entityId: ctx.user.id,
      metadata: { revokedSessions: count },
      ipAddress,
      userAgent,
      now,
    });
    return count;
  });
  return jsonResponse({ ok: true, revokedSessions: revoked }, 200, { cookies: [buildClearedSessionCookie(rt.appOrigin)] });
}

// ---------------------------------------------------------------------------
// GET /api/auth/session   ("who am I?")
// It never moves the idle deadline, so a page polling this cannot keep a session alive forever.
// ---------------------------------------------------------------------------

export async function handleSession(request: Request, rt: AuthRuntime): Promise<Response> {
  const ctx = await authenticate(request, rt, false);
  if (!ctx) return unauthorized(request, rt);
  return jsonResponse({
    user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name },
    organization: ctx.organization,
    roles: ctx.roleKeys,
    // For showing or hiding buttons only. The server checks again on every action.
    permissions: [...ctx.permissions].sort(),
    expiresAt: ctx.expiresAt.toISOString(),
    absoluteExpiresAt: ctx.absoluteExpiresAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// POST /api/auth/organization   (switch the active organization)
// ---------------------------------------------------------------------------

export async function handleSwitchOrganization(request: Request, rt: AuthRuntime): Promise<Response> {
  const refused = crossSiteRefusal(request, rt);
  if (refused) return refused;
  const ctx = await authenticate(request, rt, true);
  if (!ctx) return unauthorized(request, rt);

  const body = await readJsonBody(request, REQUEST_LIMITS.maxBodyBytes);
  if (!body.ok) return errorResponse(body.code, body.status);
  const parsed = switchOrganizationBodySchema.safeParse(body.value);
  if (!parsed.success) return errorResponse("invalid_request", 400);

  const { ipAddress, userAgent } = clientInfo(request, rt);
  const result = await switchActiveOrganization(
    rt.db,
    {
      sessionId: ctx.sessionId,
      userId: ctx.user.id,
      organizationId: parsed.data.organizationId,
      ipAddress,
      userAgent,
      now: rt.now(),
    },
    { writeAudit: rt.deps.writeAudit },
  );
  if (!result.ok) return errorResponse("forbidden", 403); // same answer whether or not the organization exists
  return jsonResponse({ organization: result.organization });
}
