import "server-only";
import type { Db } from "@/lib/db";
import { type AuditWriter, writeAudit } from "./audit";

// Moves a signed-in person's session to another organization they belong to.
// The switch is stored on the session in the database. Nothing the browser sends can choose an
// organization on its own; it can only ASK, and the server checks the membership every time.

export type SwitchInput = {
  sessionId: string;
  userId: string;
  organizationId: string;
  ipAddress: string | null;
  userAgent: string | null;
  now: Date;
};

export type SwitchResult =
  | { ok: true; organization: { id: string; name: string; slug: string } }
  // Not a member, membership not active, organization suspended and organization does not exist
  // all return this same answer, so it cannot be used to find out which organizations exist.
  | { ok: false; reason: "forbidden" };

const FORBIDDEN = { ok: false, reason: "forbidden" } as const;

export async function switchActiveOrganization(
  db: Db,
  input: SwitchInput,
  deps: { writeAudit: AuditWriter } = { writeAudit },
): Promise<SwitchResult> {
  const membership = await db.organizationMember.findFirst({
    where: {
      userId: input.userId,
      organizationId: input.organizationId,
      status: "ACTIVE",
      organization: { status: "ACTIVE" },
    },
    select: { organization: { select: { id: true, name: true, slug: true } } },
  });
  if (!membership) return FORBIDDEN;
  const organization = membership.organization;

  return db.$transaction(async (tx) => {
    const session = await tx.session.findFirst({
      where: { id: input.sessionId, userId: input.userId, revokedAt: null },
      select: { activeOrganizationId: true },
    });
    if (!session) return FORBIDDEN; // the session ended in the meantime
    if (session.activeOrganizationId === organization.id) return { ok: true as const, organization }; // already there

    const result = await tx.session.updateMany({
      where: { id: input.sessionId, userId: input.userId, revokedAt: null },
      data: { activeOrganizationId: organization.id },
    });
    if (result.count !== 1) return FORBIDDEN;

    await deps.writeAudit(tx, {
      organizationId: organization.id,
      actorUserId: input.userId,
      action: "auth.organization_switched",
      entityType: "session",
      entityId: input.sessionId,
      metadata: { fromOrganizationId: session.activeOrganizationId },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      now: input.now,
    });
    return { ok: true as const, organization };
  });
}
