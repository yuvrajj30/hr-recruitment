import "server-only";
import type { Db } from "@/lib/db";
import { publicApplyDb } from "@/lib/db-context";
import type { JobInput } from "./job-input";

// What the public careers pages may read. No sign-in is involved, so these functions return ONLY
// jobs that are published and marked public, of an active organisation, and only the fields meant
// for candidates. Draft, internal, closed and archived jobs do not exist as far as the public is concerned.

export type PublicJob = {
  id: string;
  slug: string;
  title: string;
  description: string;
  departmentName: string | null;
  employmentType: JobInput["employmentType"];
  workMode: JobInput["workMode"];
  location: string | null;
  requiredSkills: string[];
  qualifications: string | null;
  experienceRequirement: string | null;
  compensationMin: string | null;
  compensationMax: string | null;
  compensationCurrency: string;
  compensationPeriod: string | null;
  internshipMonths: number | null;
  openingsCount: number;
  applicationDeadline: Date | null;
  accepting: boolean; // false once the deadline has passed
};

export type PublicOrganization = { name: string; slug: string; timezone: string };

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const select = {
  id: true,
  slug: true,
  title: true,
  description: true,
  employmentType: true,
  workMode: true,
  location: true,
  requiredSkills: true,
  qualifications: true,
  experienceRequirement: true,
  compensationMin: true,
  compensationMax: true,
  compensationCurrency: true,
  compensationPeriod: true,
  internshipMonths: true,
  openingsCount: true,
  applicationDeadline: true,
  department: { select: { name: true } },
} as const;

function toPublicJob(
  row: {
    id: string;
    slug: string;
    title: string;
    description: string;
    employmentType: JobInput["employmentType"];
    workMode: JobInput["workMode"];
    location: string | null;
    requiredSkills: string[];
    qualifications: string | null;
    experienceRequirement: string | null;
    compensationMin: { toFixed(n: number): string } | null;
    compensationMax: { toFixed(n: number): string } | null;
    compensationCurrency: string;
    compensationPeriod: string | null;
    internshipMonths: number | null;
    openingsCount: number;
    applicationDeadline: Date | null;
    department: { name: string } | null;
  },
  now: Date,
): PublicJob {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    departmentName: row.department?.name ?? null,
    employmentType: row.employmentType,
    workMode: row.workMode,
    location: row.location,
    requiredSkills: row.requiredSkills,
    qualifications: row.qualifications,
    experienceRequirement: row.experienceRequirement,
    compensationMin: row.compensationMin?.toFixed(2) ?? null,
    compensationMax: row.compensationMax?.toFixed(2) ?? null,
    compensationCurrency: row.compensationCurrency,
    compensationPeriod: row.compensationPeriod,
    internshipMonths: row.internshipMonths,
    openingsCount: row.openingsCount,
    applicationDeadline: row.applicationDeadline,
    accepting: row.applicationDeadline === null || row.applicationDeadline > now,
  };
}

// The public pages cannot read the organisations table at all (its rows hold the owner and settings). One
// narrow database function answers "which ACTIVE organisation has this web address?" with only these fields.
export async function findPublicOrganization(rawDb: Db, organizationSlug: string): Promise<(PublicOrganization & { id: string }) | null> {
  if (!SLUG.test(organizationSlug)) return null;
  const rows = await publicApplyDb(rawDb).$queryRaw<{ id: string; name: string; slug: string; timezone: string }[]>`
    SELECT "id", "name", "slug", "timezone" FROM "app_public_organization"(${organizationSlug})`;
  return rows[0] ?? null;
}

export async function getPublicOrganization(rawDb: Db, organizationSlug: string): Promise<PublicOrganization | null> {
  const org = await findPublicOrganization(rawDb, organizationSlug);
  return org ? { name: org.name, slug: org.slug, timezone: org.timezone } : null;
}

export async function listPublicJobs(rawDb: Db, organizationSlug: string, now: Date): Promise<PublicJob[]> {
  const db = publicApplyDb(rawDb); // public pages: only published, public jobs are readable
  const org = await findPublicOrganization(rawDb, organizationSlug);
  if (!org) return [];
  const rows = await db.jobOpening.findMany({
    where: {
      status: "PUBLISHED",
      visibility: "PUBLIC",
      organizationId: org.id,
      OR: [{ applicationDeadline: null }, { applicationDeadline: { gt: now } }],
    },
    select,
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    take: 200,
  });
  return rows.map((r) => toPublicJob(r, now));
}

export async function getPublicJob(rawDb: Db, organizationSlug: string, jobSlug: string, now: Date): Promise<PublicJob | null> {
  const db = publicApplyDb(rawDb); // public pages: only published, public jobs are readable
  if (!SLUG.test(jobSlug)) return null;
  const org = await findPublicOrganization(rawDb, organizationSlug);
  if (!org) return null;
  const row = await db.jobOpening.findFirst({
    where: { slug: jobSlug, status: "PUBLISHED", visibility: "PUBLIC", organizationId: org.id },
    select,
  });
  return row ? toPublicJob(row, now) : null;
}
