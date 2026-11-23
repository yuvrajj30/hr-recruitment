import "server-only";
import type { SessionTimings } from "@/lib/auth/config";
import { computeInitialDeadlines } from "@/lib/auth/deadlines";
import { isRoleKey, type RoleKey } from "@/lib/auth/roles";
import type { Db } from "@/lib/db";
import { validateNewPassword } from "@/lib/security/password";
import { generateSessionToken, hashToken, isWellFormedToken } from "@/lib/security/tokens";
import { conflict, invalid } from "@/lib/recruitment/errors";

// Accepting an invitation link (the person is not signed in yet).
//
//   * The link holds a random token; only its SHA-256 fingerprint is looked up, through a narrow
//     database function (see the invitation_acceptance migration).
//   * New account: the person chooses their own password (same strength rules as everywhere else).
//   * Existing account (already has a password for another organisation): they must enter THAT
//     password, and the DATABASE checks it. An invitation never replaces anyone's password.
//   * Expired, used, revoked and unknown links all get the same neutral answer.
//   * On success the person is signed straight in to the organisation that invited them.

export type InvitationView = {
  invitationId: string;
  organizationId: string;
  organizationName: string;
  email: string;
  name: string;
  role: RoleKey;
  expiresAt: Date;
  accountExists: boolean;
};

export const LINK_NOT_VALID =
  "This invitation link is not valid. It may have expired, been replaced by a newer one, or already been used. Ask the person who invited you to send a new link.";

type LookupRow = {
  invitation_id: string;
  organization_id: string;
  organization_name: string;
  email: string;
  name: string;
  role_key: string;
  expires_at: Date;
  account_exists: boolean;
};

export async function lookupInvitation(db: Db, token: unknown): Promise<InvitationView | null> {
  if (!isWellFormedToken(token)) return null;
  const rows = await db.$queryRaw<LookupRow[]>`SELECT * FROM "app_invitation_lookup"(${hashToken(token)})`;
  const r = rows[0];
  if (!r || !isRoleKey(r.role_key)) return null;
  return {
    invitationId: r.invitation_id,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    email: r.email,
    name: r.name,
    role: r.role_key,
    expiresAt: r.expires_at,
    accountExists: r.account_exists,
  };
}

export type AcceptDeps = {
  db: Db;
  now: Date;
  timings: SessionTimings;
  client: { ipAddress: string | null; userAgent: string | null };
};

export type AcceptInput = { name?: string; password: string; confirmPassword?: string };

export type Accepted = { sessionToken: string; absoluteExpiresAt: Date; organizationId: string; userId: string };

// Maps the database function's refusals to messages for the person.
function refusal(error: unknown): Error | null {
  const msg = String((error as Error)?.message ?? "");
  if (msg.includes("invitation_invalid")) return invalid(LINK_NOT_VALID);
  if (msg.includes("wrong_password")) {
    return invalid("That password is not right. Enter the password you already use for this account.", { password: "Not the right password." });
  }
  // Two invitations for the same new email accepted at the same moment: the other one created the account first.
  if (msg.includes("users_email_key") || msg.includes("23505")) {
    return conflict("An account for this email address has just been created. Open the link again and enter that account's password.");
  }
  if (msg.includes("already_member")) return conflict("You are already a member of this organisation. Sign in instead.");
  if (msg.includes("account_disabled")) return invalid("This account has been disabled. Ask an administrator for help.");
  return null;
}

export async function acceptInvitation(deps: AcceptDeps, token: unknown, input: AcceptInput): Promise<Accepted> {
  const view = await lookupInvitation(deps.db, token);
  if (!view) throw invalid(LINK_NOT_VALID);
  const tokenHash = hashToken(token as string);

  let name: string | null = null;
  if (!view.accountExists) {
    name = (input.name ?? "").trim();
    const fieldErrors: Record<string, string> = {};
    if (name.length < 2 || name.length > 120) fieldErrors.name = "Enter your name (2 to 120 characters).";
    const check = validateNewPassword(input.password, [view.email, name, view.organizationName]);
    if (!check.ok) fieldErrors.password = check.reason;
    else if (input.password !== input.confirmPassword) fieldErrors.confirmPassword = "The two passwords do not match.";
    if (Object.keys(fieldErrors).length > 0) throw invalid("Check the highlighted fields.", fieldErrors);
  }

  // ONE locked step in the database (see the security_hardening migration): it re-checks the invitation and
  // its sender, checks the password of an existing account (or stores the new account's password as a
  // bcrypt hash), adds the membership with the invited role, marks the invitation as used, creates the
  // person's session and writes the audit record. The app's database account cannot do any of these itself.
  const sessionToken = generateSessionToken();
  const { expiresAt, absoluteExpiresAt } = computeInitialDeadlines(deps.now, deps.timings);
  try {
    const [accepted] = await deps.db.$queryRaw<{ user_id: string; organization_id: string }[]>`
      SELECT "user_id", "organization_id" FROM "app_accept_invitation"(${tokenHash}, ${name}::text, ${input.password},
        ${hashToken(sessionToken)}, ${expiresAt}::timestamptz, ${absoluteExpiresAt}::timestamptz, ${deps.now}::timestamptz,
        ${deps.client.ipAddress}::text, ${deps.client.userAgent}::text)`;
    if (!accepted) throw invalid(LINK_NOT_VALID);
    return { sessionToken, absoluteExpiresAt, organizationId: accepted.organization_id, userId: accepted.user_id };
  } catch (error) {
    throw refusal(error) ?? error;
  }
}
