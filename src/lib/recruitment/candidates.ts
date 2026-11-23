import "server-only";
import { type AuthContext, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { readScope } from "@/lib/auth/permissions";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { staffDb } from "@/lib/db-context";
import { phoneMatchKey, type ProfileSnapshot, readSnapshot } from "./application-input";
import { type AppDeps, applicationScope, isUuid } from "./applications";
import { invalid, notFound } from "./errors";
import type { AnyStage } from "./stages";

// The organisation's candidate database.
//
// A person has ONE profile (matched by email) however many jobs they apply for. An organisation
// sees that person through its own record (organization_candidates), and only ever sees:
//   - the applications made to THIS organisation, and
//   - the details submitted with those applications (their snapshots).
// Details the same person may have given to a different organisation are never shown here.

// Reading candidates is all-or-nothing with the three fixed roles: candidate:read (Super Admin,
// HR Manager) sees every candidate of their own organisation; Employees see none.
function candidateScope(ctx: AuthContext): Prisma.OrganizationCandidateWhereInput {
  const organizationId = requireOrganizationId(ctx);
  if (readScope(ctx.permissions, "candidate") === "none") throw new ForbiddenError("missing permission candidate:read");
  // A candidate whose personal data was removed is no longer listed or shown anywhere.
  return { organizationId, removedAt: null };
}

// Which of a candidate's applications the reader may see.
function visibleApplications(ctx: AuthContext): Prisma.ApplicationWhereInput {
  return readScope(ctx.permissions, "application") === "none" ? { id: { in: [] } } : applicationScope(ctx);
}

export type CandidateListItem = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  applicationCount: number;
  lastAppliedAt: Date | null;
  firstSeenAt: Date;
};

export const CANDIDATES_PAGE_SIZE = 25;

export async function listCandidates(
  rawDb: Db,
  ctx: AuthContext,
  filters: { search?: string; page?: number },
): Promise<{ items: CandidateListItem[]; total: number; page: number; pages: number }> {
  const db = staffDb(rawDb, ctx); // the database checks who is asking (row-level security)
  const search = filters.search?.trim().slice(0, 100);
  const digits = search?.replace(/\D/g, "") ?? "";
  const where: Prisma.OrganizationCandidateWhereInput = {
    AND: [
      candidateScope(ctx),
      search
        ? {
            OR: [
              { candidate: { fullName: { contains: search, mode: "insensitive" } } },
              { candidate: { email: { contains: search.toLowerCase() } } },
              ...(digits.length >= 4 ? [{ candidate: { phone: { contains: digits } } }] : []),
              { candidate: { skills: { some: { name: { contains: search.toLowerCase() } } } } },
            ],
          }
        : {},
    ],
  };
  const total = await db.organizationCandidate.count({ where });
  const pages = Math.max(1, Math.ceil(total / CANDIDATES_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(filters.page ?? 1) || 1), pages);
  const rows = await db.organizationCandidate.findMany({
    where,
    select: {
      id: true,
      firstSeenAt: true,
      candidate: { select: { fullName: true, email: true, phone: true } },
      applications: { where: visibleApplications(ctx), select: { appliedAt: true }, orderBy: { appliedAt: "desc" } },
    },
    orderBy: [{ firstSeenAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * CANDIDATES_PAGE_SIZE,
    take: CANDIDATES_PAGE_SIZE,
  });
  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.candidate.fullName,
      email: r.candidate.email,
      phone: r.candidate.phone,
      applicationCount: r.applications.length,
      lastAppliedAt: r.applications[0]?.appliedAt ?? null,
      firstSeenAt: r.firstSeenAt,
    })),
    total,
    page,
    pages,
  };
}

export type CandidateDetail = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  firstSeenAt: Date;
  notes: string | null;
  // The details from the most recent application to this organisation.
  latest: ProfileSnapshot | null;
  latestFrom: { referenceNumber: string; appliedAt: Date } | null;
  // Every distinct education / experience entry and skill given across this organisation's applications.
  educations: NonNullable<ProfileSnapshot["education"]>[];
  experiences: NonNullable<ProfileSnapshot["experience"]>[];
  skills: string[];
  applications: {
    id: string;
    referenceNumber: string;
    stage: AnyStage;
    appliedAt: Date;
    job: { id: string; title: string };
    recruiterName: string | null;
  }[];
  documents: { id: string; name: string; kind: string; sizeBytes: number; uploadedAt: Date; applicationReference: string | null }[];
  // Other people in this organisation's database with the same phone number but a different email.
  possibleDuplicates: { id: string; name: string; email: string }[];
};

export async function getCandidate(rawDb: Db, ctx: AuthContext, organizationCandidateId: string): Promise<CandidateDetail> {
  const db = staffDb(rawDb, ctx); // the database checks who is asking (row-level security)
  const scope = candidateScope(ctx);
  if (!isUuid(organizationCandidateId)) throw notFound("That candidate");
  const row = await db.organizationCandidate.findFirst({
    where: { AND: [scope, { id: organizationCandidateId }] },
    select: {
      id: true,
      organizationId: true,
      candidateId: true,
      firstSeenAt: true,
      notes: true,
      candidate: { select: { fullName: true, email: true, phone: true } },
      applications: {
        where: visibleApplications(ctx),
        orderBy: { appliedAt: "desc" },
        select: {
          id: true,
          referenceNumber: true,
          stage: true,
          appliedAt: true,
          profileSnapshot: true,
          job: { select: { id: true, title: true } },
          assignedRecruiter: { select: { name: true } },
          ownedDocuments: {
            where: { deletedAt: null },
            select: { id: true, originalName: true, kind: true, sizeBytes: true, uploadedAt: true },
            orderBy: { uploadedAt: "desc" },
          },
        },
      },
    },
  });
  if (!row) throw notFound("That candidate");

  const snapshots = row.applications.map((a) => readSnapshot(a.profileSnapshot));
  const unique = <T,>(items: T[], key: (item: T) => string): T[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const k = key(item).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const lower = (...parts: (string | number | null)[]) => parts.map((p) => p ?? "").join("|");

  // Same phone, different email: probably the same person, but not certain, so it is only flagged.
  // Shown only to people who may see every candidate (otherwise it would reveal hidden ones).
  let possibleDuplicates: CandidateDetail["possibleDuplicates"] = [];
  const key = row.candidate.phone ? phoneMatchKey(row.candidate.phone) : "";
  if (key.length === 10 && readScope(ctx.permissions, "candidate") === "all") {
    const others = await db.organizationCandidate.findMany({
      where: { organizationId: row.organizationId, id: { not: row.id }, candidate: { phone: { endsWith: key } } },
      select: { id: true, candidate: { select: { fullName: true, email: true } } },
      take: 5,
    });
    possibleDuplicates = others.map((o) => ({ id: o.id, name: o.candidate.fullName, email: o.candidate.email }));
  }

  const canSeeDocuments = ctx.permissions.has("document:read");
  const latestIndex = snapshots.findIndex((s) => s !== null);
  return {
    id: row.id,
    name: row.candidate.fullName,
    email: row.candidate.email,
    phone: row.candidate.phone,
    firstSeenAt: row.firstSeenAt,
    notes: ctx.permissions.has("candidate:update") || readScope(ctx.permissions, "candidate") === "all" ? row.notes : null,
    latest: latestIndex >= 0 ? snapshots[latestIndex]! : null,
    latestFrom: latestIndex >= 0 ? { referenceNumber: row.applications[latestIndex]!.referenceNumber, appliedAt: row.applications[latestIndex]!.appliedAt } : null,
    educations: unique(snapshots.flatMap((s) => (s?.education ? [s.education] : [])), (e) => lower(e.institution, e.course, e.degree, e.graduationYear)),
    experiences: unique(snapshots.flatMap((s) => (s?.experience ? [s.experience] : [])), (e) => lower(e.company, e.title)),
    skills: unique(snapshots.flatMap((s) => s?.skills ?? []), (s) => s),
    applications: row.applications.map((a) => ({
      id: a.id,
      referenceNumber: a.referenceNumber,
      stage: a.stage,
      appliedAt: a.appliedAt,
      job: a.job,
      recruiterName: a.assignedRecruiter?.name ?? null,
    })),
    documents: canSeeDocuments
      ? row.applications.flatMap((a) =>
          a.ownedDocuments.map((d) => ({ id: d.id, name: d.originalName, kind: d.kind, sizeBytes: d.sizeBytes, uploadedAt: d.uploadedAt, applicationReference: a.referenceNumber })),
        )
      : [],
    possibleDuplicates,
  };
}

export const MAX_CANDIDATE_NOTES = 8000;

// The organisation's own running notes about a person (separate from notes on one application).
export async function updateCandidateNotes(deps: AppDeps, ctx: AuthContext, organizationCandidateId: string, rawNotes: string): Promise<void> {
  const db = staffDb(deps.db, ctx); // the database checks who is asking (row-level security)
  requirePermission(ctx, "candidate:update");
  const scope = candidateScope(ctx);
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(organizationCandidateId)) throw notFound("That candidate");
  const notes = rawNotes.trim();
  if (notes.length > MAX_CANDIDATE_NOTES) throw invalid(`Keep the notes under ${MAX_CANDIDATE_NOTES} characters.`);
  const exists = await db.organizationCandidate.findFirst({ where: { AND: [scope, { id: organizationCandidateId }] }, select: { id: true } });
  if (!exists) throw notFound("That candidate");
  await db.$transaction(async (tx) => {
    await tx.organizationCandidate.updateMany({ where: { id: organizationCandidateId, organizationId }, data: { notes: notes || null } });
    await deps.writeAudit(tx, {
      organizationId,
      actorUserId: ctx.user.id,
      action: "candidate.notes_updated",
      entityType: "organization_candidate",
      entityId: organizationCandidateId,
      metadata: { length: notes.length },
      ...deps.client,
      now: deps.now,
    });
  });
}
