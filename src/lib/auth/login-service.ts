import "server-only";
import type { Db } from "@/lib/db";
import { hashIdentifier } from "@/lib/security/tokens";
import { verifyPassword } from "@/lib/security/password";
import { type AuditWriter, writeAudit } from "./audit";
import type { SessionTimings } from "./config";
import { createSession } from "./session-store";
import { discardAttempt, evaluateThrottle, markAttemptSucceeded, recordAttemptStart } from "./throttle";

// The whole "sign in with email and password" decision, with no web code in it
// (the route in Phase 5 only reads the request and writes the response).

export type LoginInput = {
  email: string;
  password: string;
  ipAddress: string | null; // null unless the address is trusted (see client-ip.ts)
  userAgent: string | null;
  now: Date;
  timings: SessionTimings;
  authSecret: string;
};

export type LoginResult =
  | {
      ok: true;
      token: string; // goes into the cookie, never anywhere else
      sessionId: string;
      expiresAt: Date;
      absoluteExpiresAt: Date;
      user: { id: string; email: string; name: string };
      organization: { id: string; name: string; slug: string };
    }
  // Every kind of failure (wrong password, unknown email, disabled account, no workspace)
  // returns exactly this, so the answer never reveals which accounts exist.
  | { ok: false; reason: "invalid_credentials" }
  | { ok: false; reason: "throttled"; retryAfterSeconds: number };

// Replaceable pieces, so tests can count password checks or simulate a failing audit write.
export type LoginDeps = {
  verifyPassword: (plain: string, storedHash: string | null) => Promise<boolean>;
  writeAudit: AuditWriter;
};
const defaultDeps: LoginDeps = { verifyPassword, writeAudit };

const INVALID = { ok: false, reason: "invalid_credentials" } as const;

export async function loginWithPassword(
  db: Db,
  input: LoginInput,
  deps: LoginDeps = defaultDeps,
): Promise<LoginResult> {
  const { now } = input;
  const email = input.email.trim().toLowerCase();
  const identifierHash = hashIdentifier(email, input.authSecret);

  // 1-2. Write the attempt down, then see whether too many failures are already on record.
  //      This happens BEFORE the slow password check, so refused attempts cost almost nothing.
  const attemptId = await recordAttemptStart(db, { identifierHash, ipAddress: input.ipAddress, now });
  const decision = await evaluateThrottle(db, {
    identifierHash,
    ipAddress: input.ipAddress,
    now,
    ownAttemptId: attemptId,
  });
  if (decision.blocked) {
    await discardAttempt(db, attemptId); // refused attempts are not recorded, so they cannot extend a lock
    return { ok: false, reason: "throttled", retryAfterSeconds: decision.retryAfterSeconds };
  }

  // 3. Look the account up, then ALWAYS do a full password check. A missing, disabled or
  //    password-less account is checked against a throw-away hash, so every failure takes
  //    about the same time and looks the same.
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, passwordHash: true, status: true },
  });
  const usable = user !== null && user.status === "ACTIVE" && Boolean(user.passwordHash);
  const passwordOk = await deps.verifyPassword(input.password, usable ? user.passwordHash : null);
  if (!usable || !passwordOk) return INVALID; // the attempt stays on record as a failure

  // 4. The person must belong to at least one ACTIVE organization that is itself ACTIVE.
  //    The oldest membership becomes the active workspace for this session.
  const membership = await db.organizationMember.findFirst({
    where: { userId: user.id, status: "ACTIVE", organization: { status: "ACTIVE" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { organization: { select: { id: true, name: true, slug: true } } },
  });
  if (!membership) return INVALID;
  const organization = membership.organization;

  // 5. One transaction: new session + last login time + audit row + attempt marked successful.
  //    If any part fails, none of it is kept and the person is not signed in.
  const session = await db.$transaction(async (tx) => {
    const created = await createSession(tx, {
      userId: user.id,
      activeOrganizationId: organization.id,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      now,
      timings: input.timings,
    });
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    await markAttemptSucceeded(tx, attemptId);
    await deps.writeAudit(tx, {
      organizationId: organization.id,
      actorUserId: user.id,
      action: "auth.login_succeeded",
      entityType: "session",
      entityId: created.sessionId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      now,
    });
    return created;
  });

  return {
    ok: true,
    token: session.token,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    user: { id: user.id, email: user.email, name: user.name },
    organization,
  };
}
