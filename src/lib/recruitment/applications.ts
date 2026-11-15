import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { AuditWriter } from "@/lib/auth/audit";
import { type AuthContext, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { readScope } from "@/lib/auth/permissions";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { type ApplicationInput, looksLikeReference, makeReferenceNumber, type ProfileSnapshot, readSnapshot, toSnapshot } from "./application-input";
import { closed, conflict, duplicate, invalid, notFound } from "./errors";
import { endOfDayInTimeZone } from "./job-input";
import type { ResumeKind } from "./resume";
import { type AnyStage, checkMove, PIPELINE_STAGES, type PipelineStage } from "./stages";
import { type FileStorage, newStorageKey } from "./storage";

// Everything that reads or changes applications.
//
// The same rules as the job openings service apply to every function here:
//   - permission first, then the organisation from the server-side session (never from the browser),
//   - people with "assigned only" access get an extra filter on EVERY query, not just on lists,
//   - plain values out (no raw database rows), and an audit row inside the same transaction as each change.

export type AppDeps = {
  db: Db;
  now: Date;
  writeAudit: AuditWriter;
  client: { ipAddress: string | null; userAgent: string | null };
  storage: FileStorage;
};

export type ResumeUpload = { bytes: Uint8Array; kind: ResumeKind; safeName: string };

export const PRIVACY_NOTICE_VERSION = "2026-11";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === "P2002";

// ---------------------------------------------------------------------------
// Who may see what
// ---------------------------------------------------------------------------

// The filter that every application query starts from.
//   application:read            -> everything in the organisation
//   application:read_assigned   -> only applications assigned to this person, or on a job they recruit for
//   neither                     -> not allowed
export function applicationScope(ctx: AuthContext): Prisma.ApplicationWhereInput {
  const organizationId = requireOrganizationId(ctx);
  const scope = readScope(ctx.permissions, "application");
  if (scope === "none") throw new ForbiddenError("missing permission application:read");
  if (scope === "all") return { organizationId };
  return {
    organizationId,
    OR: [{ assignedRecruiterId: ctx.user.id }, { job: { recruiters: { some: { userId: ctx.user.id } } } }],
  };
}

// ---------------------------------------------------------------------------
// Creating applications
// ---------------------------------------------------------------------------

export type CreatedApplication = { id: string; referenceNumber: string; candidateWasKnown: boolean };

// A candidate applying through the public page. No sign-in: the job is found by its public address,
// and it must be published, public and still open.
export async function applyPublicly(
  deps: AppDeps,
  target: { organizationSlug: string; jobSlug: string },
  input: ApplicationInput,
  resume: ResumeUpload,
): Promise<CreatedApplication> {
  const job = await deps.db.jobOpening.findFirst({
    where: { slug: target.jobSlug, organization: { slug: target.organizationSlug, status: "ACTIVE" } },
    select: { id: true, organizationId: true, status: true, visibility: true, applicationDeadline: true },
  });
  // A draft, internal or unknown job looks exactly the same from outside: it does not exist.
  if (!job || job.visibility !== "PUBLIC" || job.status === "DRAFT") throw notFound("That job opening");
  if (job.status !== "PUBLISHED" || (job.applicationDeadline && job.applicationDeadline <= deps.now)) {
    throw closed("This job is no longer accepting applications.");
  }
  return saveApplication(deps, { organizationId: job.organizationId, jobId: job.id, input, resume, actorUserId: null });
}

// An HR user entering an application for someone who applied in person, by phone, by email...
export async function createApplicationManually(
  deps: AppDeps,
  ctx: AuthContext,
  jobId: string,
  input: ApplicationInput,
  resume: ResumeUpload | null,
): Promise<CreatedApplication> {
  requirePermission(ctx, "application:create");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(jobId)) throw invalid("Choose a job from the list.", { jobId: "Choose a job from the list." });
  const job = await deps.db.jobOpening.findFirst({ where: { id: jobId, organizationId }, select: { status: true } });
  if (!job) throw invalid("Choose a job from the list.", { jobId: "Choose a job from the list." });
  if (job.status !== "PUBLISHED") throw closed("Applications can only be added to a published job. Publish or reopen the job first.");
  return saveApplication(deps, { organizationId, jobId, input, resume, actorUserId: ctx.user.id });
}

async function saveApplication(
  deps: AppDeps,
  p: { organizationId: string; jobId: string; input: ApplicationInput; resume: ResumeUpload | null; actorUserId: string | null },
): Promise<CreatedApplication> {
  const { db, now, storage } = deps;
  const { input } = p;
  const snapshot = toSnapshot(input);

  // The file is written first, under a random name. If saving the application fails, it is removed again.
  const storageKey = p.resume ? newStorageKey("resumes", now) : null;
  if (p.resume && storageKey) await storage.put(storageKey, p.resume.bytes);

  try {
    // Two requests can race (same new email, or the very rare reference-number clash). The database's
    // unique rules stop the second one; it simply runs again and then sees the first one's rows.
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.$transaction(async (tx) => {
          // ONE profile per person, matched by the normalised email.
          let profile = await tx.candidateProfile.findUnique({ where: { email: input.email }, select: { id: true } });
          const candidateWasKnown = profile !== null;
          if (!profile) {
            profile = await tx.candidateProfile.create({
              data: {
                email: input.email,
                fullName: input.fullName,
                phone: input.phone,
                city: input.city,
                linkedinUrl: input.linkedinUrl,
                portfolioUrl: input.portfolioUrl,
                educations: snapshot.education ? { create: [snapshot.education] } : undefined,
                experiences: snapshot.experience ? { create: [snapshot.experience] } : undefined,
                skills: { create: [...new Set(input.skills.map((s) => s.toLowerCase()))].map((name) => ({ name })) },
              },
              select: { id: true },
            });
          }
          // An existing profile is NOT overwritten: nobody has proved they own that email address,
          // so what they typed is kept with this application only (the snapshot below).

          const orgCandidate = await tx.organizationCandidate.upsert({
            where: { organizationId_candidateId: { organizationId: p.organizationId, candidateId: profile.id } },
            update: {},
            create: { organizationId: p.organizationId, candidateId: profile.id, firstSeenAt: now },
            select: { id: true },
          });

          const existing = await tx.application.findUnique({
            where: { jobId_organizationCandidateId: { jobId: p.jobId, organizationCandidateId: orgCandidate.id } },
            select: { id: true },
          });
          if (existing) throw duplicate("An application for this job has already been received from this email address.");

          const application = await tx.application.create({
            data: {
              organizationId: p.organizationId,
              referenceNumber: makeReferenceNumber(now.getUTCFullYear(), randomBytes(6)),
              organizationCandidateId: orgCandidate.id,
              jobId: p.jobId,
              stage: "APPLIED",
              stageChangedAt: now,
              source: input.source,
              profileSnapshot: snapshot as unknown as Prisma.InputJsonValue,
              createdById: p.actorUserId,
              consentAcceptedAt: now,
              privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
              appliedAt: now,
            },
            select: { id: true, referenceNumber: true },
          });
          await tx.applicationStatusHistory.create({
            data: { organizationId: p.organizationId, applicationId: application.id, fromStage: null, toStage: "APPLIED", changedById: p.actorUserId, createdAt: now },
          });
          if (p.resume && storageKey) {
            await tx.candidateDocument.create({
              data: {
                candidateId: profile.id,
                organizationId: p.organizationId,
                applicationId: application.id,
                kind: "RESUME",
                originalName: p.resume.safeName,
                storageKey,
                mimeType: p.resume.kind.mimeType,
                sizeBytes: p.resume.bytes.length,
                sha256: createHash("sha256").update(p.resume.bytes).digest("hex"),
                uploadedAt: now,
              },
            });
          }
          await deps.writeAudit(tx, {
            organizationId: p.organizationId,
            actorUserId: p.actorUserId,
            action: p.actorUserId ? "application.created_by_staff" : "application.submitted",
            entityType: "application",
            entityId: application.id,
            metadata: { reference: application.referenceNumber, jobId: p.jobId, knownCandidate: candidateWasKnown, hasResume: p.resume !== null },
            ...deps.client,
            now,
          });
          return { ...application, candidateWasKnown };
        });
      } catch (error) {
        if (isUniqueViolation(error) && attempt < 3) continue;
        throw error;
      }
    }
  } catch (error) {
    if (storageKey) await storage.remove(storageKey).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ApplicationListItem = {
  id: string;
  referenceNumber: string;
  stage: AnyStage;
  appliedAt: Date;
  stageChangedAt: Date;
  candidate: { id: string; name: string; email: string };
  job: { id: string; title: string };
  recruiter: { id: string; name: string } | null;
  enteredByStaff: boolean;
};

const listSelect = {
  id: true,
  referenceNumber: true,
  stage: true,
  appliedAt: true,
  stageChangedAt: true,
  createdById: true,
  organizationCandidate: { select: { id: true, candidate: { select: { fullName: true, email: true } } } },
  job: { select: { id: true, title: true } },
  assignedRecruiter: { select: { id: true, name: true } },
} satisfies Prisma.ApplicationSelect;

type ListRow = Prisma.ApplicationGetPayload<{ select: typeof listSelect }>;

const toListItem = (row: ListRow): ApplicationListItem => ({
  id: row.id,
  referenceNumber: row.referenceNumber,
  stage: row.stage,
  appliedAt: row.appliedAt,
  stageChangedAt: row.stageChangedAt,
  candidate: { id: row.organizationCandidate.id, name: row.organizationCandidate.candidate.fullName, email: row.organizationCandidate.candidate.email },
  job: row.job,
  recruiter: row.assignedRecruiter,
  enteredByStaff: row.createdById !== null,
});

export const APPLICATION_SORTS = ["newest", "oldest", "recently_moved", "candidate", "job"] as const;
export type ApplicationSort = (typeof APPLICATION_SORTS)[number];

export type ApplicationFilters = {
  search?: string;
  jobId?: string;
  stage?: PipelineStage;
  recruiter?: string; // a user id, "unassigned" or "me"
  from?: string; // YYYY-MM-DD, in the organisation's time zone
  to?: string;
  sort?: ApplicationSort;
  page?: number;
};

export const APPLICATIONS_PAGE_SIZE = 25;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Turns the filters into a database condition. The visibility scope is always part of it.
function filterWhere(ctx: AuthContext, filters: ApplicationFilters, timeZone: string): Prisma.ApplicationWhereInput {
  const and: Prisma.ApplicationWhereInput[] = [applicationScope(ctx)];
  const search = filters.search?.trim().slice(0, 100);
  if (search) {
    and.push({
      OR: [
        { organizationCandidate: { candidate: { fullName: { contains: search, mode: "insensitive" } } } },
        { organizationCandidate: { candidate: { email: { contains: search.toLowerCase() } } } },
        ...(looksLikeReference(search) || /^[2-9a-z]{4,6}$/i.test(search) ? [{ referenceNumber: { contains: search.toUpperCase() } }] : []),
      ],
    });
  }
  if (isUuid(filters.jobId)) and.push({ jobId: filters.jobId });
  if (filters.stage) and.push({ stage: filters.stage });
  if (filters.recruiter === "unassigned") and.push({ assignedRecruiterId: null });
  else if (filters.recruiter === "me") and.push({ assignedRecruiterId: ctx.user.id });
  else if (isUuid(filters.recruiter)) and.push({ assignedRecruiterId: filters.recruiter });
  const from = filters.from && ISO_DATE.test(filters.from) ? new Date(endOfDayInTimeZone(filters.from, timeZone).getTime() - DAY_MS + 1) : null;
  const to = filters.to && ISO_DATE.test(filters.to) ? endOfDayInTimeZone(filters.to, timeZone) : null;
  if (from || to) and.push({ appliedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } });
  return { AND: and };
}

const ORDER: Record<ApplicationSort, Prisma.ApplicationOrderByWithRelationInput[]> = {
  newest: [{ appliedAt: "desc" }, { id: "desc" }],
  oldest: [{ appliedAt: "asc" }, { id: "asc" }],
  recently_moved: [{ stageChangedAt: "desc" }, { id: "desc" }],
  candidate: [{ organizationCandidate: { candidate: { fullName: "asc" } } }, { id: "asc" }],
  job: [{ job: { title: "asc" } }, { appliedAt: "desc" }],
};

export async function listApplications(
  db: Db,
  ctx: AuthContext,
  filters: ApplicationFilters,
  timeZone: string,
): Promise<{ items: ApplicationListItem[]; total: number; page: number; pages: number }> {
  const where = filterWhere(ctx, filters, timeZone);
  const total = await db.application.count({ where });
  const pages = Math.max(1, Math.ceil(total / APPLICATIONS_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(filters.page ?? 1) || 1), pages);
  const rows = await db.application.findMany({
    where,
    select: listSelect,
    orderBy: ORDER[filters.sort ?? "newest"],
    skip: (page - 1) * APPLICATIONS_PAGE_SIZE,
    take: APPLICATIONS_PAGE_SIZE,
  });
  return { items: rows.map(toListItem), total, page, pages };
}

// The board: the same filters, grouped by stage. Each column shows its newest cards and its true total.
export const PIPELINE_COLUMN_LIMIT = 50;

export type PipelineColumn = { stage: PipelineStage; total: number; items: ApplicationListItem[] };

export async function listPipeline(db: Db, ctx: AuthContext, filters: Pick<ApplicationFilters, "search" | "jobId" | "recruiter">, timeZone: string): Promise<PipelineColumn[]> {
  const where = filterWhere(ctx, filters, timeZone);
  const [counts, ...perStage] = await Promise.all([
    db.application.groupBy({ by: ["stage"], where, _count: { _all: true } }),
    ...PIPELINE_STAGES.map((stage) =>
      db.application.findMany({
        where: { AND: [where, { stage }] },
        select: listSelect,
        orderBy: [{ stageChangedAt: "desc" }, { id: "desc" }],
        take: PIPELINE_COLUMN_LIMIT,
      }),
    ),
  ]);
  return PIPELINE_STAGES.map((stage, i) => ({
    stage,
    total: counts.find((c) => c.stage === stage)?._count._all ?? 0,
    items: perStage[i]!.map(toListItem),
  }));
}

// How many applications a job has in each stage (for the job page). Respects the reader's scope.
export async function countApplicationsByStage(db: Db, ctx: AuthContext, jobId: string): Promise<{ stage: AnyStage; count: number }[]> {
  if (!isUuid(jobId)) return [];
  const groups = await db.application.groupBy({ by: ["stage"], where: { AND: [applicationScope(ctx), { jobId }] }, _count: { _all: true } });
  return groups.map((g) => ({ stage: g.stage, count: g._count._all }));
}

export type ApplicationDetail = ApplicationListItem & {
  rejectionReason: string | null;
  source: string | null;
  snapshot: ProfileSnapshot | null;
  candidatePhone: string | null;
  enteredByName: string | null;
  assignedAt: Date | null;
  documents: { id: string; name: string; kind: string; sizeBytes: number; uploadedAt: Date }[];
  notes: { id: string; body: string; authorName: string | null; createdAt: Date }[];
  history: { id: string; from: AnyStage | null; to: AnyStage; byName: string | null; reason: string | null; createdAt: Date }[];
  assignments: { id: string; recruiterName: string | null; unassigned: boolean; byName: string | null; createdAt: Date }[];
};

export async function getApplication(db: Db, ctx: AuthContext, applicationId: string): Promise<ApplicationDetail> {
  const scope = applicationScope(ctx);
  if (!isUuid(applicationId)) throw notFound("That application");
  const row = await db.application.findFirst({
    where: { AND: [scope, { id: applicationId }] },
    select: {
      ...listSelect,
      rejectionReason: true,
      source: true,
      profileSnapshot: true,
      createdBy: { select: { name: true } },
      organizationCandidate: { select: { id: true, candidate: { select: { fullName: true, email: true, phone: true } } } },
      ownedDocuments: {
        where: { deletedAt: null },
        select: { id: true, originalName: true, kind: true, sizeBytes: true, uploadedAt: true },
        orderBy: { uploadedAt: "asc" },
      },
      notes: { select: { id: true, body: true, createdAt: true, author: { select: { name: true } } }, orderBy: { createdAt: "desc" } },
      statusHistory: {
        select: { id: true, fromStage: true, toStage: true, reason: true, createdAt: true, changedById: true, changedBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      },
      assignments: {
        select: { id: true, recruiterId: true, createdAt: true, recruiter: { select: { name: true } }, assignedBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  // Someone else's application and a missing one look the same: not found.
  if (!row) throw notFound("That application");
  const canSeeDocuments = ctx.permissions.has("document:read");
  return {
    ...toListItem(row),
    rejectionReason: row.rejectionReason,
    source: row.source,
    snapshot: readSnapshot(row.profileSnapshot),
    candidatePhone: row.organizationCandidate.candidate.phone,
    enteredByName: row.createdBy?.name ?? null,
    assignedAt: row.assignedRecruiter ? (row.assignments.find((a) => a.recruiterId === row.assignedRecruiter!.id)?.createdAt ?? null) : null,
    documents: canSeeDocuments ? row.ownedDocuments.map((d) => ({ id: d.id, name: d.originalName, kind: d.kind, sizeBytes: d.sizeBytes, uploadedAt: d.uploadedAt })) : [],
    notes: ctx.permissions.has("application:note") || readScope(ctx.permissions, "application") === "all"
      ? row.notes.map((n) => ({ id: n.id, body: n.body, authorName: n.author?.name ?? null, createdAt: n.createdAt }))
      : [],
    history: row.statusHistory.map((h) => ({
      id: h.id,
      from: h.fromStage,
      to: h.toStage,
      // No staff member on the row: the candidate did it themselves (applied through the public page).
      byName: h.changedBy?.name ?? (h.changedById === null && h.fromStage === null ? "The candidate" : null),
      reason: h.reason,
      createdAt: h.createdAt,
    })),
    assignments: row.assignments.map((a) => ({
      id: a.id,
      recruiterName: a.recruiter?.name ?? null,
      unassigned: a.recruiterId === null,
      byName: a.assignedBy?.name ?? null,
      createdAt: a.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export async function moveApplicationStage(deps: AppDeps, ctx: AuthContext, applicationId: string, to: PipelineStage, reason?: string | null): Promise<void> {
  requirePermission(ctx, "application:move_stage");
  const scope = applicationScope(ctx);
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(applicationId)) throw notFound("That application");
  const current = await deps.db.application.findFirst({ where: { AND: [scope, { id: applicationId }] }, select: { stage: true } });
  if (!current) throw notFound("That application");
  const check = checkMove(current.stage, to, reason);
  if (!check.ok) throw current.stage === to ? conflict("This application is already in that stage. Reload to see its current state.") : invalid(check.message);

  await deps.db.$transaction(async (tx) => {
    // Moves only if the application is still where we saw it, so two people cannot both move it.
    const updated = await tx.application.updateMany({
      where: { id: applicationId, organizationId, stage: current.stage },
      data: { stage: to, stageChangedAt: deps.now, rejectionReason: to === "REJECTED" ? check.reason : null },
    });
    if (updated.count !== 1) throw conflict("This application was moved by someone else. Reload to see its current state.");
    // A new history row every time; earlier rows are never changed (the database also refuses edits).
    await tx.applicationStatusHistory.create({
      data: { organizationId, applicationId, fromStage: current.stage, toStage: to, changedById: ctx.user.id, reason: check.reason, createdAt: deps.now },
    });
    await deps.writeAudit(tx, {
      organizationId,
      actorUserId: ctx.user.id,
      action: "application.stage_changed",
      entityType: "application",
      entityId: applicationId,
      metadata: { from: current.stage, to, kind: check.kind },
      ...deps.client,
      now: deps.now,
    });
  });
}

const RECRUITER_PERMISSION = "application:move_stage";

// People who can be given applications: active members whose role lets them work the pipeline.
export async function listAssignableRecruiters(db: Db, ctx: AuthContext): Promise<{ id: string; name: string }[]> {
  const organizationId = requireOrganizationId(ctx);
  if (readScope(ctx.permissions, "application") === "none") throw new ForbiddenError("missing permission application:read");
  const members = await db.organizationMember.findMany({
    where: {
      organizationId,
      status: "ACTIVE",
      user: { status: "ACTIVE" },
      roles: { some: { role: { permissions: { some: { permission: { key: RECRUITER_PERMISSION } } } } } },
    },
    select: { user: { select: { id: true, name: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return members.map((m) => m.user);
}

// recruiterUserId = null removes the current recruiter.
export async function assignRecruiter(deps: AppDeps, ctx: AuthContext, applicationId: string, recruiterUserId: string | null): Promise<void> {
  requirePermission(ctx, "application:assign");
  const scope = applicationScope(ctx);
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(applicationId)) throw notFound("That application");
  const current = await deps.db.application.findFirst({ where: { AND: [scope, { id: applicationId }] }, select: { assignedRecruiterId: true } });
  if (!current) throw notFound("That application");
  if (recruiterUserId !== null) {
    const eligible = isUuid(recruiterUserId) && (await listAssignableRecruiters(deps.db, ctx)).some((r) => r.id === recruiterUserId);
    // Someone from another organisation, a suspended member and a made-up id all get the same answer.
    if (!eligible) throw invalid("Choose a recruiter from the list.");
  }
  if (current.assignedRecruiterId === recruiterUserId) return; // nothing to change, nothing to record

  await deps.db.$transaction(async (tx) => {
    const updated = await tx.application.updateMany({
      where: { id: applicationId, organizationId, assignedRecruiterId: current.assignedRecruiterId },
      data: { assignedRecruiterId: recruiterUserId },
    });
    if (updated.count !== 1) throw conflict("This application was reassigned by someone else. Reload to see its current state.");
    await tx.applicationAssignment.create({
      data: { organizationId, applicationId, recruiterId: recruiterUserId, assignedById: ctx.user.id, createdAt: deps.now },
    });
    await deps.writeAudit(tx, {
      organizationId,
      actorUserId: ctx.user.id,
      action: recruiterUserId ? "application.assigned" : "application.unassigned",
      entityType: "application",
      entityId: applicationId,
      metadata: { from: current.assignedRecruiterId, to: recruiterUserId },
      ...deps.client,
      now: deps.now,
    });
  });
}

export const MAX_NOTE_LENGTH = 4000;

export async function addApplicationNote(deps: AppDeps, ctx: AuthContext, applicationId: string, rawBody: string): Promise<void> {
  requirePermission(ctx, "application:note");
  const scope = applicationScope(ctx);
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(applicationId)) throw notFound("That application");
  const body = rawBody.trim();
  if (!body) throw invalid("Write something before saving the note.");
  if (body.length > MAX_NOTE_LENGTH) throw invalid(`Keep the note under ${MAX_NOTE_LENGTH} characters.`);
  const exists = await deps.db.application.findFirst({ where: { AND: [scope, { id: applicationId }] }, select: { id: true } });
  if (!exists) throw notFound("That application");
  await deps.db.$transaction(async (tx) => {
    const note = await tx.applicationNote.create({ data: { organizationId, applicationId, authorId: ctx.user.id, body, createdAt: deps.now }, select: { id: true } });
    await deps.writeAudit(tx, {
      organizationId,
      actorUserId: ctx.user.id,
      action: "application.note_added",
      entityType: "application",
      entityId: applicationId,
      metadata: { noteId: note.id, length: body.length }, // the note's text is never copied into the audit log
      ...deps.client,
      now: deps.now,
    });
  });
}

// Jobs to choose from in filters and in the "add application" form.
export async function listJobOptions(db: Db, ctx: AuthContext, only?: "published"): Promise<{ id: string; title: string; status: string }[]> {
  const organizationId = requireOrganizationId(ctx);
  if (readScope(ctx.permissions, "application") === "none" && !ctx.permissions.has("application:create")) {
    throw new ForbiddenError("missing permission application:read");
  }
  return db.jobOpening.findMany({
    where: { organizationId, ...(only === "published" ? { status: "PUBLISHED" } : { status: { not: "DRAFT" } }) },
    select: { id: true, title: true, status: true },
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: 500,
  });
}
