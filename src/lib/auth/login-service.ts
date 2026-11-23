import "server-only";
import type { Db } from "@/lib/db";
import { generateSessionToken, hashIdentifier, hashToken } from "@/lib/security/tokens";
import { type AuditWriter, writeAudit } from "./audit";
import type { SessionTimings } from "./config";
import { computeInitialDeadlines } from "./deadlines";
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

export type SignedInRow = {
  session_id: string;
  user_id: string;
  email: string;
  name: string;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
};

export type SignInArgs = {
  email: string;
  password: string;
  tokenHash: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  now: Date;
  ipAddress: string | null;
  userAgent: string | null;
};
// Checks the password and creates the session. Refuses with an error whose message contains
// "invalid_credentials" (wrong password, unknown email, disabled account, no active workspace: all the same).
export type SignIn = (tx: Pick<Db, "$queryRaw">, args: SignInArgs) => Promise<SignedInRow>;

// The real thing: ONE database function (see the security_hardening migration). The application's
// restricted database account can neither read password hashes nor create sessions itself.
export const signInWithDatabase: SignIn = async (tx, a) => {
  const rows = await tx.$queryRaw<SignedInRow[]>`
    SELECT * FROM "app_sign_in"(${a.email}, ${a.password}, ${a.tokenHash}, ${a.expiresAt}::timestamptz,
      ${a.absoluteExpiresAt}::timestamptz, ${a.now}::timestamptz, ${a.ipAddress}::text, ${a.userAgent}::text)`;
  const row = rows[0];
  if (!row) throw new Error("sign-in returned nothing");
  return row;
};

// Replaceable pieces, so tests can count or delay password checks, or simulate a failing audit write.
export type LoginDeps = { signIn: SignIn; writeAudit: AuditWriter };
const defaultDeps: LoginDeps = { signIn: signInWithDatabase, writeAudit };

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

  // 3-5. ONE database function checks the password and, only if it is right, creates the session
  //      (signInWithDatabase above). The function ALWAYS does a full
  //      password check (a missing or disabled account is checked against a throw-away hash), so every
  //      failure takes about the same time and looks the same: wrong password, unknown email, disabled
  //      account, or no active workspace. The oldest active membership becomes the session's workspace.
  //      One transaction: session + last login time + attempt marked successful + audit row. If any
  //      part fails, none of it is kept and the person is not signed in.
  const token = generateSessionToken(); // a brand-new token on every login (no session fixation)
  const { expiresAt, absoluteExpiresAt } = computeInitialDeadlines(now, input.timings);
  let signedIn: SignedInRow;
  try {
    signedIn = await db.$transaction(async (tx) => {
      const row = await deps.signIn(tx, {
        email,
        password: input.password,
        tokenHash: hashToken(token),
        expiresAt,
        absoluteExpiresAt,
        now,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      await markAttemptSucceeded(tx, attemptId);
      await deps.writeAudit(tx, {
        organizationId: row.organization_id,
        actorUserId: row.user_id,
        action: "auth.login_succeeded",
        entityType: "session",
        entityId: row.session_id,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        now,
      });
      return row;
    });
  } catch (error) {
    // The attempt stays on record as a failure.
    if (String((error as Error)?.message ?? "").includes("invalid_credentials")) return INVALID;
    throw error;
  }

  return {
    ok: true,
    token,
    sessionId: signedIn.session_id,
    expiresAt,
    absoluteExpiresAt,
    user: { id: signedIn.user_id, email: signedIn.email, name: signedIn.name },
    organization: { id: signedIn.organization_id, name: signedIn.organization_name, slug: signedIn.organization_slug },
  };
}
