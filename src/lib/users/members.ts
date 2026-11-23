import "server-only";
import type { AuditWriter } from "@/lib/auth/audit";
import { type AuthContext, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import { isRoleKey, type RoleKey } from "@/lib/auth/roles";
import { revokeSessionsForMembership } from "@/lib/auth/session-store";
import type { Db } from "@/lib/db";
import { staffDb } from "@/lib/db-context";
import { conflict, invalid, notFound } from "@/lib/recruitment/errors";
import { generateSessionToken, hashToken } from "@/lib/security/tokens";
import { canChangeRole, canInvite, canSetStatus, type Target } from "./rules";

// User and role management for one organisation: the people in it, their roles and status, and
// invitations. Every function checks the rules (./rules.ts) and permissions first; the database checks
// them again (row-level security and triggers), and every change writes an audit record.

export type UserDeps = {
  db: Db;
  now: Date;
  writeAudit: AuditWriter;
  client: { ipAddress: string | null; userAgent: string | null };
  appOrigin: string;
};

export const INVITATION_DAYS = 7;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isCheckViolation = (e: unknown) => /at least one active Super Admin|owner must stay/.test(String((e as Error)?.message));
const isUniqueViolation = (e: unknown) => (e as { code?: unknown } | null)?.code === "P2002";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type Person = {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: RoleKey | null;
  status: "ACTIVE" | "SUSPENDED" | "INVITED";
  accountDisabled: boolean;
  lastLoginAt: Date | null;
  joinedAt: Date | null;
  isSelf: boolean;
  isOwner: boolean;
};

export async function listPeople(rawDb: Db, ctx: AuthContext): Promise<Person[]> {
  requirePermission(ctx, "user:read");
  const organizationId = requireOrganizationId(ctx);
  const db = staffDb(rawDb, ctx);
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { ownerUserId: true } });
  const rows = await db.organizationMember.findMany({
    where: { organizationId },
    select: {
      id: true,
      status: true,
      joinedAt: true,
      user: { select: { id: true, name: true, email: true, status: true, lastLoginAt: true } },
      roles: { select: { role: { select: { key: true } } } },
    },
    orderBy: [{ user: { name: "asc" } }, { id: "asc" }],
  });
  return rows.map((r) => {
    const key = r.roles[0]?.role.key;
    return {
      memberId: r.id,
      userId: r.user.id,
      name: r.user.name,
      email: r.user.email,
      role: isRoleKey(key) ? key : null,
      status: r.status,
      accountDisabled: r.user.status !== "ACTIVE",
      lastLoginAt: r.user.lastLoginAt,
      joinedAt: r.joinedAt,
      isSelf: r.user.id === ctx.user.id,
      isOwner: r.user.id === org?.ownerUserId,
    };
  });
}

export type Invitation = {
  id: string;
  email: string;
  name: string;
  role: RoleKey;
  invitedByName: string | null;
  createdAt: Date;
  expiresAt: Date;
  state: "pending" | "expired" | "accepted" | "revoked";
  closedAt: Date | null;
};

// Open invitations, plus those accepted or revoked in the last 30 days. HR Managers see Employee
// invitations only (the database enforces that too).
export async function listInvitations(rawDb: Db, ctx: AuthContext, now: Date): Promise<Invitation[]> {
  requirePermission(ctx, "user:read");
  const organizationId = requireOrganizationId(ctx);
  if (!ctx.permissions.has("user:invite_employee") && !ctx.permissions.has("user:invite_hr")) return [];
  const db = staffDb(rawDb, ctx);
  const since = new Date(now.getTime() - 30 * 24 * 3600_000);
  const rows = await db.staffInvitation.findMany({
    where: { organizationId, OR: [{ acceptedAt: null, revokedAt: null }, { acceptedAt: { gte: since } }, { revokedAt: { gte: since } }] },
    select: { id: true, email: true, name: true, roleKey: true, createdAt: true, expiresAt: true, acceptedAt: true, revokedAt: true, invitedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.flatMap((r) =>
    isRoleKey(r.roleKey)
      ? [{
          id: r.id,
          email: r.email,
          name: r.name,
          role: r.roleKey,
          invitedByName: r.invitedBy?.name ?? null,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          state: r.acceptedAt ? "accepted" : r.revokedAt ? "revoked" : r.expiresAt <= now ? "expired" : "pending",
          closedAt: r.acceptedAt ?? r.revokedAt,
        } satisfies Invitation]
      : [],
  );
}

export async function getInviteSettings(rawDb: Db, ctx: AuthContext): Promise<{ hrCanInviteEmployees: boolean }> {
  const organizationId = requireOrganizationId(ctx);
  const org = await staffDb(rawDb, ctx).organization.findUnique({ where: { id: organizationId }, select: { hrCanInviteEmployees: true } });
  if (!org) throw notFound("The organisation");
  return { hrCanInviteEmployees: org.hrCanInviteEmployees };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export type InvitationInput = { email: string; name: string; role: RoleKey };

// Returns the one-time link. Only its hash is stored, so the link cannot be shown again later
// (resending creates a new link and stops the old one working).
export async function createInvitation(deps: UserDeps, ctx: AuthContext, input: InvitationInput): Promise<{ id: string; link: string; expiresAt: Date }> {
  const organizationId = requireOrganizationId(ctx);
  const db = staffDb(deps.db, ctx);
  const { hrCanInviteEmployees } = await getInviteSettings(deps.db, ctx);
  const verdict = canInvite(ctx.permissions, input.role, hrCanInviteEmployees);
  if (!verdict.ok) throw invalid(verdict.reason);

  const email = input.email.trim().toLowerCase();
  const existing = await db.organizationMember.findFirst({ where: { organizationId, user: { email } }, select: { status: true } });
  if (existing) {
    throw invalid(
      existing.status === "SUSPENDED" ? "This person is already a member but deactivated. Reactivate them instead." : "This person is already a member of the organisation.",
      { email: "Already a member." },
    );
  }

  const token = generateSessionToken();
  const expiresAt = new Date(deps.now.getTime() + INVITATION_DAYS * 24 * 3600_000);
  try {
    const created = await db.$transaction(async (tx) => {
      // A new invitation replaces any open one for the same person.
      await tx.staffInvitation.updateMany({
        where: { organizationId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: deps.now, revokedById: ctx.user.id },
      });
      const inv = await tx.staffInvitation.create({
        data: { organizationId, email, name: input.name.trim(), roleKey: input.role, tokenHash: hashToken(token), invitedById: ctx.user.id, createdAt: deps.now, expiresAt },
        select: { id: true },
      });
      await deps.writeAudit(tx, {
        organizationId,
        actorUserId: ctx.user.id,
        action: "invitation.created",
        entityType: "staff_invitation",
        entityId: inv.id,
        metadata: { role: input.role, expiresAt: expiresAt.toISOString() },
        ...deps.client,
        now: deps.now,
      });
      return inv;
    });
    return { id: created.id, link: `${deps.appOrigin}/invite/${token}`, expiresAt };
  } catch (error) {
    // An open invitation this person may not see (an HR Manager invitation, as seen by an HR Manager).
    if (isUniqueViolation(error)) throw conflict("An invitation for this email is already pending. Ask a Super Admin.");
    throw error;
  }
}

async function findInvitation(db: Db, organizationId: string, invitationId: string) {
  if (!isUuid(invitationId)) throw notFound("That invitation");
  const inv = await db.staffInvitation.findFirst({
    where: { id: invitationId, organizationId },
    select: { id: true, email: true, name: true, roleKey: true, acceptedAt: true, revokedAt: true },
  });
  if (!inv || !isRoleKey(inv.roleKey)) throw notFound("That invitation");
  return { ...inv, roleKey: inv.roleKey };
}

export async function revokeInvitation(deps: UserDeps, ctx: AuthContext, invitationId: string): Promise<void> {
  const organizationId = requireOrganizationId(ctx);
  const db = staffDb(deps.db, ctx);
  const inv = await findInvitation(db, organizationId, invitationId);
  const verdict = canInvite(ctx.permissions, inv.roleKey, true);
  if (!verdict.ok) throw invalid(verdict.reason);
  if (inv.acceptedAt || inv.revokedAt) throw conflict("This invitation is no longer open.");
  await db.$transaction(async (tx) => {
    const r = await tx.staffInvitation.updateMany({ where: { id: inv.id, organizationId, acceptedAt: null, revokedAt: null }, data: { revokedAt: deps.now, revokedById: ctx.user.id } });
    if (r.count !== 1) throw conflict("This invitation is no longer open.");
    await deps.writeAudit(tx, {
      organizationId, actorUserId: ctx.user.id, action: "invitation.revoked", entityType: "staff_invitation", entityId: inv.id,
      metadata: { role: inv.roleKey }, ...deps.client, now: deps.now,
    });
  });
}

// A fresh link for the same person and role; the previous link stops working.
export async function resendInvitation(deps: UserDeps, ctx: AuthContext, invitationId: string) {
  const organizationId = requireOrganizationId(ctx);
  const inv = await findInvitation(staffDb(deps.db, ctx), organizationId, invitationId);
  if (inv.acceptedAt) throw conflict("This invitation has already been accepted.");
  return createInvitation(deps, ctx, { email: inv.email, name: inv.name, role: inv.roleKey });
}

// ---------------------------------------------------------------------------
// Roles and status
// ---------------------------------------------------------------------------

async function loadTarget(db: Db, organizationId: string, memberId: string): Promise<Target & { memberId: string; status: string }> {
  if (!isUuid(memberId)) throw notFound("That person");
  const [member, org] = await Promise.all([
    db.organizationMember.findFirst({ where: { id: memberId, organizationId }, select: { id: true, userId: true, status: true, roles: { select: { role: { select: { key: true } } } } } }),
    db.organization.findUnique({ where: { id: organizationId }, select: { ownerUserId: true } }),
  ]);
  if (!member) throw notFound("That person");
  const key = member.roles[0]?.role.key;
  return { memberId: member.id, userId: member.userId, status: member.status, role: isRoleKey(key) ? key : null, isOwner: member.userId === org?.ownerUserId };
}

export async function changeRole(deps: UserDeps, ctx: AuthContext, memberId: string, to: RoleKey): Promise<void> {
  const organizationId = requireOrganizationId(ctx);
  const db = staffDb(deps.db, ctx);
  const target = await loadTarget(db, organizationId, memberId);
  const verdict = canChangeRole({ userId: ctx.user.id, permissions: ctx.permissions }, target, to);
  if (!verdict.ok) throw invalid(verdict.reason);
  try {
    await db.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { key: to }, select: { id: true } });
      if (!role) throw invalid("Unknown role.");
      const r = await tx.organizationMemberRole.updateMany({ where: { memberId: target.memberId }, data: { roleId: role.id, assignedAt: deps.now } });
      if (r.count !== 1) throw conflict("This person's role changed in the meantime. Reload and try again.");
      // The new role applies on the person's next request; ending their sessions makes them sign in again.
      await revokeSessionsForMembership(tx, organizationId, target.userId, "membership_changed", deps.now);
      await deps.writeAudit(tx, {
        organizationId, actorUserId: ctx.user.id, action: "member.role_changed", entityType: "organization_member", entityId: target.memberId,
        metadata: { from: target.role, to }, ...deps.client, now: deps.now,
      });
    });
  } catch (error) {
    if (isCheckViolation(error)) throw invalid("This would leave the organisation without an active Super Admin.");
    throw error;
  }
}

export async function setMemberStatus(deps: UserDeps, ctx: AuthContext, memberId: string, status: "ACTIVE" | "SUSPENDED"): Promise<void> {
  const organizationId = requireOrganizationId(ctx);
  const db = staffDb(deps.db, ctx);
  const target = await loadTarget(db, organizationId, memberId);
  const verdict = canSetStatus({ userId: ctx.user.id, permissions: ctx.permissions }, target);
  if (!verdict.ok) throw invalid(verdict.reason);
  if (target.status === status) return;
  try {
    await db.$transaction(async (tx) => {
      const r = await tx.organizationMember.updateMany({ where: { id: target.memberId, organizationId, status: target.status as "ACTIVE" | "SUSPENDED" | "INVITED" }, data: { status } });
      if (r.count !== 1) throw conflict("This person was changed in the meantime. Reload and try again.");
      if (status === "SUSPENDED") await revokeSessionsForMembership(tx, organizationId, target.userId, "membership_changed", deps.now);
      await deps.writeAudit(tx, {
        organizationId, actorUserId: ctx.user.id, action: status === "SUSPENDED" ? "member.deactivated" : "member.reactivated",
        entityType: "organization_member", entityId: target.memberId, metadata: { role: target.role }, ...deps.client, now: deps.now,
      });
    });
  } catch (error) {
    if (isCheckViolation(error)) throw invalid("This would leave the organisation without an active Super Admin.");
    throw error;
  }
}

export async function setHrCanInviteEmployees(deps: UserDeps, ctx: AuthContext, allowed: boolean): Promise<void> {
  requirePermission(ctx, "org:update");
  requirePermission(ctx, "user:manage_super_admin"); // Super Admin only
  const organizationId = requireOrganizationId(ctx);
  const db = staffDb(deps.db, ctx);
  await db.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: organizationId }, data: { hrCanInviteEmployees: allowed } });
    await deps.writeAudit(tx, {
      organizationId, actorUserId: ctx.user.id, action: "settings.hr_can_invite_employees", entityType: "organization", entityId: organizationId,
      metadata: { allowed }, ...deps.client, now: deps.now,
    });
  });
}
