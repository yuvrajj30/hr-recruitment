import "server-only";
import type { Db } from "@/lib/db";
import { generateSessionToken, hashToken, isWellFormedToken } from "@/lib/security/tokens";
import type { SessionTimings } from "./config";
import { computeInitialDeadlines, extendIdleDeadline, isSessionLive, shouldTouch } from "./deadlines";

// Everything that touches the `sessions` table lives here.
//
// - The browser holds a random token; the database holds only its SHA-256 hash.
// - Functions take the database client and the current time as arguments, so tests can use a
//   fake clock and a transaction can be passed in (login creates its session inside one).
// - Validation checks the session AND the live state of the user, organization and membership
//   on every request, so disabling someone takes effect immediately, even without a revoke call.

// Works with the normal client and with a transaction client.
export type SessionDb = Pick<Db, "session" | "organizationMember">;

export type RevokeReason =
  | "logout"
  | "logout_all"
  | "password_changed"
  | "user_disabled"
  | "membership_changed"
  | "admin_revoked";

const clip = (value: string | null | undefined, max: number): string | null =>
  value ? value.slice(0, max) : null;

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreatedSession = {
  token: string; // the ONLY time the plain token exists on the server: it goes into the cookie
  sessionId: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
};

// NOT used by the running application: its database account cannot insert sessions. A session is created
// only by the database itself, after it has checked the password (app_sign_in) or the invitation
// (app_accept_invitation): see the security_hardening migration. This function remains for the owner
// connection: the seed, maintenance scripts and test fixtures.
export async function createSession(
  db: Pick<Db, "session">,
  input: {
    userId: string;
    activeOrganizationId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    now: Date;
    timings: SessionTimings;
  },
): Promise<CreatedSession> {
  const token = generateSessionToken(); // a brand-new token on every login (no session fixation)
  const { expiresAt, absoluteExpiresAt } = computeInitialDeadlines(input.now, input.timings);
  const row = await db.session.create({
    data: {
      userId: input.userId,
      activeOrganizationId: input.activeOrganizationId,
      tokenHash: hashToken(token),
      expiresAt,
      absoluteExpiresAt,
      lastSeenAt: input.now,
      createdAt: input.now,
      ipAddress: clip(input.ipAddress, 64),
      userAgent: clip(input.userAgent, 512),
    },
    select: { id: true },
  });
  return { token, sessionId: row.id, expiresAt, absoluteExpiresAt };
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export type SessionPrincipal = {
  sessionId: string;
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  organization: { id: string; name: string; slug: string } | null;
  memberId: string | null; // the user's membership in the active organization
  expiresAt: Date;
  absoluteExpiresAt: Date;
};

// The reason is for logs and tests ONLY. Callers must never show it to the browser:
// every failure looks the same from outside ("not signed in").
export type SessionFailure =
  | "malformed"
  | "not_found"
  | "revoked"
  | "expired"
  | "user_inactive"
  | "organization_inactive"
  | "membership_inactive";

export type ValidateResult = { ok: true; principal: SessionPrincipal } | { ok: false; reason: SessionFailure };

export async function validateSession(
  db: SessionDb,
  token: string | null | undefined,
  opts: { now: Date; timings: SessionTimings; touch: boolean },
): Promise<ValidateResult> {
  if (!isWellFormedToken(token)) return { ok: false, reason: "malformed" };
  const { now, timings } = opts;

  const row = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      activeOrganizationId: true,
      expiresAt: true,
      absoluteExpiresAt: true,
      lastSeenAt: true,
      revokedAt: true,
      user: { select: { id: true, email: true, name: true, isPlatformAdmin: true, status: true } },
      activeOrganization: { select: { id: true, name: true, slug: true, status: true } },
    },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (!isSessionLive(now, row)) return { ok: false, reason: "expired" };
  if (row.user.status !== "ACTIVE") return { ok: false, reason: "user_inactive" };

  let memberId: string | null = null;
  let organization: SessionPrincipal["organization"] = null;
  if (row.activeOrganizationId !== null) {
    if (!row.activeOrganization || row.activeOrganization.status !== "ACTIVE") {
      return { ok: false, reason: "organization_inactive" };
    }
    const member = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: row.activeOrganizationId, userId: row.user.id } },
      select: { id: true, status: true },
    });
    if (!member || member.status !== "ACTIVE") return { ok: false, reason: "membership_inactive" };
    memberId = member.id;
    organization = {
      id: row.activeOrganization.id,
      name: row.activeOrganization.name,
      slug: row.activeOrganization.slug,
    };
  }

  // Slide the idle deadline forward, but only every so often (keeps database writes low).
  let expiresAt = row.expiresAt;
  if (opts.touch && shouldTouch(now, row.lastSeenAt, timings)) {
    const extended = extendIdleDeadline(now, row.absoluteExpiresAt, timings);
    const dueBefore = new Date(now.getTime() - timings.touchIntervalMs);
    // The WHERE clause repeats the rules, so two requests racing each other cannot write twice,
    // and a session that has just expired or been revoked can never be revived by a late write.
    const result = await db.session.updateMany({
      where: {
        id: row.id,
        revokedAt: null,
        expiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
        lastSeenAt: { lte: dueBefore },
      },
      data: { lastSeenAt: now, expiresAt: extended },
    });
    if (result.count === 1) expiresAt = extended;
  }

  return {
    ok: true,
    principal: {
      sessionId: row.id,
      user: {
        id: row.user.id,
        email: row.user.email,
        name: row.user.name,
        isPlatformAdmin: row.user.isPlatformAdmin,
      },
      organization,
      memberId,
      expiresAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

export type RevokeOneResult =
  | { revoked: true; userId: string; organizationId: string | null }
  | { revoked: false };

// Ends one session (logout). Safe to call twice or with a token that does not exist.
export async function revokeSessionByToken(
  db: Pick<Db, "session">,
  token: string | null | undefined,
  reason: RevokeReason,
  now: Date,
): Promise<RevokeOneResult> {
  if (!isWellFormedToken(token)) return { revoked: false };
  const tokenHash = hashToken(token);
  const row = await db.session.findUnique({
    where: { tokenHash },
    select: { userId: true, activeOrganizationId: true },
  });
  if (!row) return { revoked: false };
  const result = await db.session.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  });
  return result.count === 1
    ? { revoked: true, userId: row.userId, organizationId: row.activeOrganizationId }
    : { revoked: false };
}

// Ends every open session of a user (password change, account disabled, "log out everywhere").
// Returns how many sessions were ended. Already-ended sessions keep their original reason.
export async function revokeAllSessionsForUser(
  db: Pick<Db, "session">,
  userId: string,
  reason: RevokeReason,
  now: Date,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  const result = await db.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: now, revokedReason: reason },
  });
  return result.count;
}

// Ends a user's open sessions that are working inside one organization
// (their membership was changed or removed there).
export async function revokeSessionsForMembership(
  db: Pick<Db, "session">,
  organizationId: string,
  userId: string,
  reason: RevokeReason,
  now: Date,
): Promise<number> {
  const result = await db.session.updateMany({
    where: { userId, activeOrganizationId: organizationId, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

// Deletes sessions that ended (revoked, or past their idle/hard deadline) more than
// `retentionDays` ago. Sessions that are still usable are never touched.
export async function purgeEndedSessions(
  db: Pick<Db, "session">,
  now: Date,
  retentionDays: number,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const result = await db.session.deleteMany({
    // The idle deadline is never later than the hard deadline, so "idle deadline long past" means "ended".
    where: { OR: [{ revokedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }] },
  });
  return result.count;
}
