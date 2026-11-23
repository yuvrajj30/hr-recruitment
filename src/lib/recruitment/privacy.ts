import "server-only";
import { type AuthContext, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { readScope } from "@/lib/auth/permissions";
import type { Db } from "@/lib/db";
import { staffDb } from "@/lib/db-context";
import { logger } from "@/lib/security/logger";
import type { AppDeps } from "./applications";
import { invalid, notFound } from "./errors";
import { effectiveRetentionMonths, REMOVABLE_STAGES, RETENTION_MONTHS, RETENTION_SHORTENING_GRACE_DAYS, retentionCutoff } from "./privacy-rules";

// Candidate privacy: the organisation's notice settings, the list of candidates due for removal, and
// removing a candidate's personal data. The removal itself is ONE database function
// (app_remove_candidate, migration 20261117000000_candidate_privacy); this file only checks the request,
// calls it, and deletes the files it names.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type PrivacySettings = {
  organizationName: string;
  noticeName: string | null;
  contactEmail: string | null;
  retentionMonths: number;
  canEdit: boolean; // Super Admins (org:update)
  canRemove: boolean; // Super Admins and HR Managers (candidate:delete)
};

export async function getPrivacySettings(rawDb: Db, ctx: AuthContext): Promise<PrivacySettings> {
  if (readScope(ctx.permissions, "candidate") === "none") throw new ForbiddenError("missing permission candidate:read");
  const organizationId = requireOrganizationId(ctx);
  const org = await staffDb(rawDb, ctx).organization.findUnique({
    where: { id: organizationId },
    select: { name: true, privacyNoticeName: true, privacyContactEmail: true, candidateRetentionMonths: true },
  });
  if (!org) throw notFound("The organisation");
  return {
    organizationName: org.name,
    noticeName: org.privacyNoticeName,
    contactEmail: org.privacyContactEmail,
    retentionMonths: org.candidateRetentionMonths,
    canEdit: ctx.permissions.has("org:update"),
    canRemove: ctx.permissions.has("candidate:delete"),
  };
}

export type PrivacySettingsInput = { noticeName: string; contactEmail: string; retentionMonths: string };

export async function updatePrivacySettings(deps: Pick<AppDeps, "db" | "now" | "writeAudit" | "client">, ctx: AuthContext, input: PrivacySettingsInput): Promise<void> {
  requirePermission(ctx, "org:update");
  const organizationId = requireOrganizationId(ctx);
  const noticeName = input.noticeName.trim().replace(/\s+/g, " ");
  const contactEmail = input.contactEmail.trim().toLowerCase();
  const months = Number(input.retentionMonths);
  const fieldErrors: Record<string, string> = {};
  if (noticeName && (noticeName.length < 2 || noticeName.length > 160)) fieldErrors.noticeName = "Use 2 to 160 characters, or leave it empty.";
  if (contactEmail && (!EMAIL.test(contactEmail) || contactEmail.length > 254)) fieldErrors.contactEmail = "Enter a valid email address, or leave it empty.";
  if (!Number.isInteger(months) || months < RETENTION_MONTHS.min || months > RETENTION_MONTHS.max) {
    fieldErrors.retentionMonths = `Enter a whole number of months from ${RETENTION_MONTHS.min} to ${RETENTION_MONTHS.max}.`;
  }
  if (Object.keys(fieldErrors).length > 0) throw invalid("Check the highlighted fields.", fieldErrors);

  await staffDb(deps.db, ctx).$transaction(async (tx) => {
    const r = await tx.organization.updateMany({
      where: { id: organizationId },
      data: { privacyNoticeName: noticeName || null, privacyContactEmail: contactEmail || null, candidateRetentionMonths: months },
    });
    if (r.count !== 1) throw new ForbiddenError("organisation settings not updated");
    await deps.writeAudit(tx, {
      organizationId,
      actorUserId: ctx.user.id,
      action: "organization.privacy_settings_updated",
      entityType: "organization",
      entityId: organizationId,
      // The contact address itself is not copied into the audit log.
      metadata: { retentionMonths: months, noticeNameSet: noticeName !== "", contactSet: contactEmail !== "" },
      ...deps.client,
      now: deps.now,
    });
  });
}

export type DueForRemoval = { id: string; name: string; email: string; applications: number; lastClosedAt: Date };

// Candidates whose applications to this organisation are ALL finished without a hire, the last of them
// longer ago than the organisation's retention period. Oldest first; at most DUE_LIST_LIMIT are listed, and
// `total` says how many are due in all. (The scheduled retention job, retention.ts, removes them all by itself
// with the same rule in the database.)
export const DUE_LIST_LIMIT = 500;
// The same rule as the automatic job (app_remove_due_candidates): cutoff in UTC with the day clamped, and during the
// grace after a shortening the longer previous period (graceUntil says until when).
export async function listDueForRemoval(
  rawDb: Db,
  ctx: AuthContext,
  now: Date,
): Promise<{ retentionMonths: number; cutoff: Date; graceUntil: Date | null; items: DueForRemoval[]; total: number }> {
  requirePermission(ctx, "candidate:delete");
  const organizationId = requireOrganizationId(ctx);
  const db = staffDb(rawDb, ctx);
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { candidateRetentionMonths: true, candidateRetentionPreviousMonths: true, candidateRetentionShortenedAt: true },
  });
  if (!org) throw notFound("The organisation");
  const months = effectiveRetentionMonths(
    { months: org.candidateRetentionMonths, previousMonths: org.candidateRetentionPreviousMonths, shortenedAt: org.candidateRetentionShortenedAt },
    now,
  );
  const cutoff = retentionCutoff(now, months);
  const graceUntil = months !== org.candidateRetentionMonths && org.candidateRetentionShortenedAt
    ? new Date(org.candidateRetentionShortenedAt.getTime() + RETENTION_SHORTENING_GRACE_DAYS * 86_400_000)
    : null;
  const where = {
    organizationId,
    removedAt: null,
    applications: { some: {}, every: { stage: { in: [...REMOVABLE_STAGES] }, stageChangedAt: { lt: cutoff } } },
  };
  const [rows, total] = await db.$transaction(async (tx) => [
    await tx.organizationCandidate.findMany({
      where,
      select: { id: true, candidate: { select: { fullName: true, email: true } }, applications: { select: { stageChangedAt: true } } },
      orderBy: { firstSeenAt: "asc" },
      take: DUE_LIST_LIMIT,
    }),
    await tx.organizationCandidate.count({ where }),
  ] as const);
  const items = rows
    .map((r) => ({
      id: r.id,
      name: r.candidate.fullName,
      email: r.candidate.email,
      applications: r.applications.length,
      lastClosedAt: new Date(Math.max(...r.applications.map((a) => a.stageChangedAt.getTime()))),
    }))
    .sort((a, b) => a.lastClosedAt.getTime() - b.lastClosedAt.getTime());
  return { retentionMonths: months, cutoff, graceUntil, items, total };
}

export type RemovalResult = { applicationsKept: number; filesDeleted: number; filesNotDeleted: number };

// Removes a candidate's personal data in this organisation (see app_remove_candidate). Permanent.
export async function removeCandidate(deps: Pick<AppDeps, "db" | "now" | "storage">, ctx: AuthContext, organizationCandidateId: string): Promise<RemovalResult> {
  requirePermission(ctx, "candidate:delete");
  requireOrganizationId(ctx);
  if (!UUID.test(organizationCandidateId)) throw notFound("That candidate");
  let row: { storage_keys: string[]; applications_kept: number; files: number } | undefined;
  try {
    [row] = await staffDb(deps.db, ctx).$queryRaw<{ storage_keys: string[]; applications_kept: number; files: number }[]>`
      SELECT "storage_keys", "applications_kept", "files" FROM "app_remove_candidate"(${organizationCandidateId}::uuid, ${deps.now}::timestamptz)`;
  } catch (error) {
    const msg = String((error as Error)?.message ?? "");
    if (msg.includes("candidate_not_found")) throw notFound("That candidate");
    if (msg.includes("applications_open")) {
      throw invalid("This person still has an open application (or was hired). Reject or withdraw their open applications first; hired people's data belongs to their employee record.");
    }
    if (msg.includes("not allowed")) throw new ForbiddenError("candidate:delete refused by the database");
    throw error;
  }
  if (!row) throw new Error("the removal returned nothing");
  // The database has already recorded the files as deleted; now the files themselves go. A file that cannot
  // be deleted is logged by its storage key (a random name, not personal data) so it can be removed by hand.
  let failed = 0;
  for (const key of row.storage_keys) {
    try {
      await deps.storage.remove(key);
    } catch {
      failed++;
      logger.error("recruitment.candidate_file_not_deleted", { storageKey: key });
    }
  }
  return { applicationsKept: row.applications_kept, filesDeleted: row.files - failed, filesNotDeleted: failed };
}
