import "server-only";
import type { AuditWriter } from "@/lib/auth/audit";
import { type AuthContext, requireAnyPermission, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { conflict, invalid, notFound } from "./errors";
import { dateInTimeZone, endOfDayInTimeZone, type JobInput, pickFreeSlug, slugify } from "./job-input";
import { canTransition, isEditable, JOB_TRANSITIONS, type JobAction, type JobStatus } from "./job-status";

// Everything that reads or changes job openings.
//
// Every function:
//   - checks the permission first (pages hide buttons too, but that is only tidiness),
//   - limits every query to the organisation in the server-side session (never one from the browser),
//   - returns plain values safe to hand to the browser (no raw database rows, no Decimal objects),
//   - writes an audit row in the same transaction as the change it records.

export type JobDeps = {
  db: Db;
  now: Date;
  writeAudit: AuditWriter;
  client: { ipAddress: string | null; userAgent: string | null };
};

export type JobListItem = {
  id: string;
  title: string;
  status: JobStatus;
  visibility: "PUBLIC" | "INTERNAL_ONLY";
  employmentType: JobInput["employmentType"];
  workMode: JobInput["workMode"];
  location: string | null;
  departmentName: string | null;
  openingsCount: number;
  applicationDeadline: Date | null;
  applicationCount: number;
  updatedAt: Date;
};

export type JobDetail = JobListItem & {
  slug: string;
  description: string;
  departmentId: string | null;
  requiredSkills: string[];
  qualifications: string | null;
  experienceRequirement: string | null;
  compensationMin: string | null;
  compensationMax: string | null;
  compensationCurrency: string;
  compensationPeriod: string | null;
  internshipMonths: number | null;
  publishedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  createdByName: string;
  // The deadline as a calendar date in the organisation's time zone, ready for a date box.
  applicationDeadlineDate: string | null;
};

export type JobFilters = { status?: JobStatus | "ACTIVE"; search?: string };

const listSelect = {
  id: true,
  title: true,
  status: true,
  visibility: true,
  employmentType: true,
  workMode: true,
  location: true,
  openingsCount: true,
  applicationDeadline: true,
  updatedAt: true,
  department: { select: { name: true } },
  _count: { select: { applications: true } },
} satisfies Prisma.JobOpeningSelect;

type ListRow = Prisma.JobOpeningGetPayload<{ select: typeof listSelect }>;

const toListItem = (row: ListRow): JobListItem => ({
  id: row.id,
  title: row.title,
  status: row.status,
  visibility: row.visibility,
  employmentType: row.employmentType,
  workMode: row.workMode,
  location: row.location,
  departmentName: row.department?.name ?? null,
  openingsCount: row.openingsCount,
  applicationDeadline: row.applicationDeadline,
  applicationCount: row._count.applications,
  updatedAt: row.updatedAt,
});

const MAX_LIST = 200;

export async function listJobs(db: Db, ctx: AuthContext, filters: JobFilters = {}): Promise<JobListItem[]> {
  requirePermission(ctx, "job:read");
  const organizationId = requireOrganizationId(ctx);
  const search = filters.search?.trim().slice(0, 100);
  const where: Prisma.JobOpeningWhereInput = {
    ...(filters.status === "ACTIVE"
      ? { status: { in: ["DRAFT", "PUBLISHED", "CLOSED"] } }
      : filters.status
        ? { status: filters.status }
        : {}),
    ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
    organizationId, // last, so nothing above can point the query at another organisation
  };
  const rows = await db.jobOpening.findMany({
    where,
    select: listSelect,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: MAX_LIST,
  });
  return rows.map(toListItem);
}

// How many jobs are in each status (for the filter tabs).
export async function countJobsByStatus(db: Db, ctx: AuthContext): Promise<Record<JobStatus, number>> {
  requirePermission(ctx, "job:read");
  const organizationId = requireOrganizationId(ctx);
  const groups = await db.jobOpening.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } });
  const counts: Record<JobStatus, number> = { DRAFT: 0, PUBLISHED: 0, CLOSED: 0, ARCHIVED: 0 };
  for (const g of groups) counts[g.status] = g._count._all;
  return counts;
}

export async function getJob(db: Db, ctx: AuthContext, jobId: string): Promise<JobDetail> {
  requirePermission(ctx, "job:read");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(jobId)) throw notFound("That job opening");
  const row = await db.jobOpening.findFirst({
    where: { id: jobId, organizationId },
    select: {
      ...listSelect,
      slug: true,
      description: true,
      departmentId: true,
      requiredSkills: true,
      qualifications: true,
      experienceRequirement: true,
      compensationMin: true,
      compensationMax: true,
      compensationCurrency: true,
      compensationPeriod: true,
      internshipMonths: true,
      publishedAt: true,
      closedAt: true,
      createdAt: true,
      createdBy: { select: { name: true } },
      organization: { select: { timezone: true } },
    },
  });
  if (!row) throw notFound("That job opening");
  return {
    ...toListItem(row),
    slug: row.slug,
    description: row.description,
    departmentId: row.departmentId,
    requiredSkills: row.requiredSkills,
    qualifications: row.qualifications,
    experienceRequirement: row.experienceRequirement,
    compensationMin: row.compensationMin?.toFixed(2) ?? null,
    compensationMax: row.compensationMax?.toFixed(2) ?? null,
    compensationCurrency: row.compensationCurrency,
    compensationPeriod: row.compensationPeriod,
    internshipMonths: row.internshipMonths,
    publishedAt: row.publishedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    createdByName: row.createdBy.name,
    applicationDeadlineDate: row.applicationDeadline ? dateInTimeZone(row.applicationDeadline, row.organization.timezone) : null,
  };
}

// Departments to choose from in the job form.
export async function listJobDepartments(db: Db, ctx: AuthContext): Promise<{ id: string; name: string }[]> {
  requireAnyPermission(ctx, ["job:create", "job:update", "department:read"]);
  const organizationId = requireOrganizationId(ctx);
  return db.department.findMany({
    where: { organizationId, isActive: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

// The organisation's time zone and currency, which the job form needs.
export async function getOrganizationSettings(db: Db, ctx: AuthContext): Promise<{ timezone: string; currency: string }> {
  const organizationId = requireOrganizationId(ctx);
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { timezone: true, defaultCurrency: true } });
  if (!org) throw notFound("The organisation");
  return { timezone: org.timezone, currency: org.defaultCurrency };
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export async function createJob(deps: JobDeps, ctx: AuthContext, input: JobInput): Promise<{ id: string }> {
  requirePermission(ctx, "job:create");
  const organizationId = requireOrganizationId(ctx);
  const { db } = deps;
  const settings = await getOrganizationSettings(db, ctx);
  await assertDepartment(db, organizationId, input.departmentId);
  const deadline = input.applicationDeadline ? endOfDayInTimeZone(input.applicationDeadline, settings.timezone) : null;

  const base = slugify(input.title);
  // Two people creating "Barista" at the same moment can pick the same slug; the unique index stops
  // the second one, and it simply tries again with the next free number.
  for (let attempt = 0; attempt < 3; attempt++) {
    const taken = await db.jobOpening.findMany({
      where: { organizationId, slug: { startsWith: base } },
      select: { slug: true },
    });
    const slug = pickFreeSlug(base, new Set(taken.map((t) => t.slug)));
    try {
      return await db.$transaction(async (tx) => {
        const job = await tx.jobOpening.create({
          data: {
            organizationId,
            slug,
            createdById: ctx.user.id,
            compensationCurrency: settings.currency,
            status: "DRAFT",
            ...jobData(input, deadline),
          },
          select: { id: true },
        });
        await deps.writeAudit(tx, {
          organizationId,
          actorUserId: ctx.user.id,
          action: "job.created",
          entityType: "job_opening",
          entityId: job.id,
          metadata: { title: input.title.slice(0, 120), slug },
          ...deps.client,
          now: deps.now,
        });
        return job;
      });
    } catch (error) {
      if (isUniqueViolation(error) && attempt < 2) continue;
      throw error;
    }
  }
  throw conflict("Could not save the job. Please try again.");
}

export async function updateJob(deps: JobDeps, ctx: AuthContext, jobId: string, input: JobInput): Promise<void> {
  requirePermission(ctx, "job:update");
  const organizationId = requireOrganizationId(ctx);
  const { db } = deps;
  if (!isUuid(jobId)) throw notFound("That job opening");
  const existing = await db.jobOpening.findFirst({ where: { id: jobId, organizationId }, select: { status: true } });
  if (!existing) throw notFound("That job opening");
  if (!isEditable(existing.status)) throw invalid("Archived jobs cannot be edited.");
  await assertDepartment(db, organizationId, input.departmentId);
  const settings = await getOrganizationSettings(db, ctx);
  const deadline = input.applicationDeadline ? endOfDayInTimeZone(input.applicationDeadline, settings.timezone) : null;
  // A published job must stay open for applications; a past deadline would silently close it.
  if (existing.status === "PUBLISHED" && deadline && deadline <= deps.now) {
    throw invalid("The deadline has already passed.", { applicationDeadline: "Choose a date that has not passed yet." });
  }

  await db.$transaction(async (tx) => {
    // The status is part of the condition, so an edit cannot land on a job archived a moment ago.
    const updated = await tx.jobOpening.updateMany({
      where: { id: jobId, organizationId, status: { not: "ARCHIVED" } },
      data: jobData(input, deadline),
    });
    if (updated.count !== 1) throw conflict("This job changed while you were editing it. Reload and try again.");
    await deps.writeAudit(tx, {
      organizationId,
      actorUserId: ctx.user.id,
      action: "job.updated",
      entityType: "job_opening",
      entityId: jobId,
      metadata: { title: input.title.slice(0, 120) },
      ...deps.client,
      now: deps.now,
    });
  });
}

export async function changeJobStatus(deps: JobDeps, ctx: AuthContext, jobId: string, action: JobAction): Promise<JobStatus> {
  const transition = JOB_TRANSITIONS[action];
  requirePermission(ctx, transition.permission);
  const organizationId = requireOrganizationId(ctx);
  const { db } = deps;
  if (!isUuid(jobId)) throw notFound("That job opening");
  const job = await db.jobOpening.findFirst({
    where: { id: jobId, organizationId },
    select: { status: true, applicationDeadline: true, publishedAt: true },
  });
  if (!job) throw notFound("That job opening");
  if (!canTransition(job.status, action)) {
    throw conflict(`This job is ${job.status.toLowerCase()} and cannot be changed that way. Reload to see its current state.`);
  }
  if (transition.to === "PUBLISHED" && job.applicationDeadline && job.applicationDeadline <= deps.now) {
    throw invalid("The application deadline has passed. Edit the job and set a new deadline first.");
  }

  const data: Prisma.JobOpeningUpdateManyMutationInput = { status: transition.to };
  if (transition.to === "PUBLISHED") {
    data.publishedAt = job.publishedAt ?? deps.now; // first time it went live
    data.closedAt = null;
  }
  if (transition.to === "CLOSED") data.closedAt = deps.now;

  await db.$transaction(async (tx) => {
    // Only moves the job if it is still in the status we checked; a second click or a
    // colleague's change in the meantime makes this a no-op that is reported, not applied twice.
    const updated = await tx.jobOpening.updateMany({ where: { id: jobId, organizationId, status: job.status }, data });
    if (updated.count !== 1) throw conflict("This job was changed by someone else. Reload to see its current state.");
    await deps.writeAudit(tx, {
      organizationId,
      actorUserId: ctx.user.id,
      action: `job.${action}`,
      entityType: "job_opening",
      entityId: jobId,
      metadata: { from: job.status, to: transition.to },
      ...deps.client,
      now: deps.now,
    });
  });
  return transition.to;
}

// ---------------------------------------------------------------------------

function jobData(input: JobInput, deadline: Date | null) {
  return {
    title: input.title,
    description: input.description,
    departmentId: input.departmentId,
    employmentType: input.employmentType,
    workMode: input.workMode,
    visibility: input.visibility,
    location: input.location,
    requiredSkills: input.requiredSkills,
    qualifications: input.qualifications,
    experienceRequirement: input.experienceRequirement,
    compensationMin: input.compensationMin,
    compensationMax: input.compensationMax,
    compensationPeriod: input.compensationPeriod,
    internshipMonths: input.employmentType === "INTERNSHIP" && input.internshipMonths !== null ? Number(input.internshipMonths) : null,
    openingsCount: input.openingsCount,
    applicationDeadline: deadline,
  };
}

async function assertDepartment(db: Db, organizationId: string, departmentId: string | null): Promise<void> {
  if (!departmentId) return;
  const dept = await db.department.findFirst({ where: { id: departmentId, organizationId, isActive: true }, select: { id: true } });
  if (!dept) throw invalid("Choose a department from the list.", { departmentId: "That department is not available." });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === "P2002";
