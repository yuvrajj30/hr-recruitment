import "server-only";
import type { AuditWriter } from "@/lib/auth/audit";
import { type AuthContext, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import { isRoleKey, type RoleKey } from "@/lib/auth/roles";
import type { Db } from "@/lib/db";
import { staffDb } from "@/lib/db-context";
import { invalid, notFound } from "@/lib/recruitment/errors";
import { validateNewPassword } from "@/lib/security/password";

// Self-service: what every signed-in person may see and change about THEMSELVES.
//
// None of these functions takes a user id from the browser: the account is always the one in the
// server-side session (ctx.user.id), so nobody can read or change someone else's details through them.
// Every change is audited.

export type SelfDeps = {
  db: Db;
  now: Date;
  writeAudit: AuditWriter;
  client: { ipAddress: string | null; userAgent: string | null };
};

export type MyAccount = {
  name: string;
  email: string;
  role: RoleKey | null;
  organizationName: string;
  memberSince: Date | null;
  lastLoginAt: Date | null;
};

export async function getMyAccount(db: Db, ctx: AuthContext): Promise<MyAccount> {
  requirePermission(ctx, "self:profile_read");
  const organizationId = requireOrganizationId(ctx);
  const user = await db.user.findUnique({ where: { id: ctx.user.id }, select: { name: true, email: true, lastLoginAt: true } });
  // Read through the signed-in context: the database lets an Employee see only their OWN membership row.
  const member = await staffDb(db, ctx).organizationMember.findFirst({
    where: { organizationId, userId: ctx.user.id },
    select: { joinedAt: true, createdAt: true, roles: { select: { role: { select: { key: true } } } } },
  });
  if (!user || !member) throw notFound("Your account");
  const key = member.roles[0]?.role.key;
  return {
    name: user.name,
    email: user.email,
    role: isRoleKey(key) ? key : null,
    organizationName: ctx.organization?.name ?? "",
    memberSince: member.joinedAt ?? member.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

export async function updateMyName(deps: SelfDeps, ctx: AuthContext, rawName: string): Promise<void> {
  requirePermission(ctx, "self:profile_update");
  const organizationId = requireOrganizationId(ctx);
  const name = rawName.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 120 || !/\p{L}/u.test(name)) {
    throw invalid("Enter your name (2 to 120 characters).", { name: "Enter your name (2 to 120 characters)." });
  }
  // Through the signed-in context: the database lets the app change only the name of the person whose
  // session is asking.
  await staffDb(deps.db, ctx).$transaction(async (tx) => {
    const before = await tx.user.findUnique({ where: { id: ctx.user.id }, select: { name: true } });
    if (!before) throw notFound("Your account");
    if (before.name === name) return;
    await tx.user.update({ where: { id: ctx.user.id }, data: { name }, select: { id: true } });
    await deps.writeAudit(tx, {
      organizationId,
      actorUserId: ctx.user.id,
      action: "self.name_changed",
      entityType: "user",
      entityId: ctx.user.id,
      metadata: { length: name.length }, // the name itself is personal data; the change is what matters
      ...deps.client,
      now: deps.now,
    });
  });
}

export type PasswordChange = { currentPassword: string; newPassword: string; confirmPassword: string };

// Changes the signed-in person's password. Their other sessions (other browsers and devices) are ended;
// the one they are using stays signed in.
export async function changeMyPassword(deps: SelfDeps, ctx: AuthContext, input: PasswordChange): Promise<void> {
  requirePermission(ctx, "self:profile_update");
  const organizationId = requireOrganizationId(ctx);
  // Passwords are checked and stored by the DATABASE, for the person whose session is asking (see the
  // security_hardening migration): the app's database account cannot read or write password hashes.
  const db = staffDb(deps.db, ctx);
  const user = await deps.db.user.findUnique({ where: { id: ctx.user.id }, select: { email: true, name: true } });
  if (!user) throw notFound("Your account");
  const wrongCurrent = () => invalid("Your current password is not right.", { currentPassword: "Not the right password." });
  const [current] = await db.$queryRaw<{ ok: boolean }[]>`SELECT "app_my_password_matches"(${input.currentPassword}) AS ok`;
  if (!current?.ok) throw wrongCurrent();
  const check = validateNewPassword(input.newPassword, [user.email, user.name, ctx.organization?.name ?? ""]);
  if (!check.ok) throw invalid("Choose a stronger password.", { newPassword: check.reason });
  if (input.newPassword !== input.confirmPassword) throw invalid("The two new passwords do not match.", { confirmPassword: "Does not match." });
  await db.$transaction(async (tx) => {
    // One step in the database: re-checks the current password, refuses an unchanged one, stores the new
    // hash and ends the person's OTHER sessions (the one they are using stays signed in).
    let ended: number;
    try {
      const [row] = await tx.$queryRaw<{ ended: number }[]>`
        SELECT "app_change_my_password"(${input.currentPassword}, ${input.newPassword}, ${deps.now}::timestamptz) AS ended`;
      ended = row?.ended ?? 0;
    } catch (error) {
      const msg = String((error as Error)?.message ?? "");
      if (msg.includes("same_password")) {
        throw invalid("The new password must be different from the current one.", { newPassword: "Same as the current password." });
      }
      if (msg.includes("wrong_password")) throw wrongCurrent();
      throw error;
    }
    await deps.writeAudit(tx, {
      organizationId,
      actorUserId: ctx.user.id,
      action: "self.password_changed",
      entityType: "user",
      entityId: ctx.user.id,
      metadata: { otherSessionsEnded: ended },
      ...deps.client,
      now: deps.now,
    });
  });
}
