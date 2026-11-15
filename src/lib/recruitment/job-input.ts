import { z } from "zod";

// What a person types into the job opening form, checked before anything reaches the database.
// Pure functions only (no database, no Next.js), so every rule here is covered by unit tests.

export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "INTERNSHIP", "CONTRACT"] as const;
export const WORK_MODES = ["ON_SITE", "HYBRID", "REMOTE"] as const;
export const JOB_VISIBILITIES = ["PUBLIC", "INTERNAL_ONLY"] as const;
export const COMPENSATION_PERIODS = ["per month", "per year", "per hour", "one-time"] as const;

export const JOB_LIMITS = {
  title: 120,
  description: 20_000,
  location: 120,
  qualifications: 4_000,
  experience: 500,
  skills: 30,
  skillLength: 60,
  slug: 80,
  maxOpenings: 1_000,
  maxInternshipMonths: 36,
  maxCompensation: 9_999_999_999, // fits Decimal(12, 2)
} as const;

// Empty boxes arrive as "" from a form; treat them as "not given".
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer.`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

const optionalNumber = (opts: { min: number; max: number; int?: boolean; label: string }) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return null;
      const clean = v.replace(/,/g, "");
      if (!/^\d+(\.\d{1,2})?$/.test(clean) || (opts.int && clean.includes("."))) {
        ctx.addIssue({ code: "custom", message: `${opts.label} must be a ${opts.int ? "whole " : ""}number.` });
        return z.NEVER;
      }
      const n = Number(clean);
      if (n < opts.min || n > opts.max) {
        ctx.addIssue({ code: "custom", message: `${opts.label} must be between ${opts.min} and ${opts.max}.` });
        return z.NEVER;
      }
      return clean; // kept as text so money never goes through floating point
    });

export const jobInputSchema = z
  .object({
    title: z.string().trim().min(3, "Give the job a title of at least 3 characters.").max(JOB_LIMITS.title),
    description: z.string().trim().min(20, "Describe the job in at least 20 characters.").max(JOB_LIMITS.description),
    departmentId: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : null))
      .pipe(z.uuid("Choose a department from the list.").nullable()),
    employmentType: z.enum(EMPLOYMENT_TYPES, "Choose an employment type."),
    workMode: z.enum(WORK_MODES, "Choose a work mode."),
    visibility: z.enum(JOB_VISIBILITIES, "Choose who can see this job."),
    location: optionalText(JOB_LIMITS.location),
    requiredSkills: z
      .string()
      .optional()
      .transform((v, ctx) => {
        const skills = parseSkills(v ?? "");
        if (skills.length > JOB_LIMITS.skills) {
          ctx.addIssue({ code: "custom", message: `List at most ${JOB_LIMITS.skills} skills.` });
          return z.NEVER;
        }
        if (skills.some((s) => s.length > JOB_LIMITS.skillLength)) {
          ctx.addIssue({ code: "custom", message: `Each skill must be ${JOB_LIMITS.skillLength} characters or fewer.` });
          return z.NEVER;
        }
        return skills;
      }),
    qualifications: optionalText(JOB_LIMITS.qualifications),
    experienceRequirement: optionalText(JOB_LIMITS.experience),
    compensationMin: optionalNumber({ min: 0, max: JOB_LIMITS.maxCompensation, label: "Minimum pay" }),
    compensationMax: optionalNumber({ min: 0, max: JOB_LIMITS.maxCompensation, label: "Maximum pay" }),
    compensationPeriod: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : null))
      .pipe(z.enum(COMPENSATION_PERIODS, "Choose how often the pay is given.").nullable()),
    internshipMonths: optionalNumber({ min: 1, max: JOB_LIMITS.maxInternshipMonths, int: true, label: "Internship length" }),
    openingsCount: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v === undefined || v === "" ? "1" : v))
      .pipe(
        z
          .string()
          .regex(/^\d+$/, "Number of openings must be a whole number.")
          .transform(Number)
          .pipe(z.number().int().min(1, "There must be at least 1 opening.").max(JOB_LIMITS.maxOpenings)),
      ),
    // A calendar date (YYYY-MM-DD). Applications close at the end of that day in the organisation's time zone.
    applicationDeadline: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : null))
      .pipe(z.iso.date("Enter the deadline as a date.").nullable()),
  })
  .superRefine((v, ctx) => {
    if (v.compensationMin !== null && v.compensationMax !== null && Number(v.compensationMax) < Number(v.compensationMin)) {
      ctx.addIssue({ code: "custom", path: ["compensationMax"], message: "Maximum pay cannot be less than minimum pay." });
    }
    if ((v.compensationMin !== null || v.compensationMax !== null) && v.compensationPeriod === null) {
      ctx.addIssue({ code: "custom", path: ["compensationPeriod"], message: "Say how often the pay is given." });
    }
    if (v.employmentType !== "INTERNSHIP" && v.internshipMonths !== null) {
      ctx.addIssue({ code: "custom", path: ["internshipMonths"], message: "Internship length is only for internships." });
    }
  });

export type JobInput = z.output<typeof jobInputSchema>;
export type JobField = keyof z.input<typeof jobInputSchema>;
export type FieldErrors = Partial<Record<JobField, string>>;

export const JOB_FIELDS: readonly JobField[] = [
  "title",
  "description",
  "departmentId",
  "employmentType",
  "workMode",
  "visibility",
  "location",
  "requiredSkills",
  "qualifications",
  "experienceRequirement",
  "compensationMin",
  "compensationMax",
  "compensationPeriod",
  "internshipMonths",
  "openingsCount",
  "applicationDeadline",
];

// Only the known fields are read from the form; anything else the browser sends is ignored.
// A field sent twice, or a file instead of text, is treated as missing and then fails validation.
export function formDataToJobFields(formData: FormData): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const field of JOB_FIELDS) {
    const values = formData.getAll(field);
    out[field] = values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
  }
  return out;
}

export type ParsedJob = { ok: true; value: JobInput } | { ok: false; errors: FieldErrors };

export function parseJobInput(raw: Record<string, string | undefined>): ParsedJob {
  const result = jobInputSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as JobField | undefined;
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return { ok: false, errors };
}

// "Latte art, Espresso,  latte art" -> ["Latte art", "Espresso"]  (comma or new line separated, duplicates dropped)
export function parseSkills(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const skill = part.trim().replace(/\s+/g, " ");
    const key = skill.toLowerCase();
    if (skill && !seen.has(key)) {
      seen.add(key);
      out.push(skill);
    }
  }
  return out;
}

// "Senior Barista (Night Shift)" -> "senior-barista-night-shift". Matches the database rule
// ^[a-z0-9]+(-[a-z0-9]+)*$. A title with no Latin letters or digits becomes "job".
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, JOB_LIMITS.slug - 6) // leave room for a "-12345" suffix
    .replace(/-+$/g, "");
  return slug || "job";
}

// The first free slug: "barista", then "barista-2", "barista-3", ...
export function pickFreeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// The moment applications close: 23:59:59.999 on the given date in the organisation's time zone.
export function endOfDayInTimeZone(date: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  // Start from that wall-clock time as if it were UTC, then correct by the zone's offset at that moment.
  const guess = Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  const offset = timeZoneOffsetMs(new Date(guess), timeZone);
  const result = guess - offset;
  // Around a daylight-saving change the offset can differ at the corrected moment; adjust once more.
  const offset2 = timeZoneOffsetMs(new Date(result), timeZone);
  return new Date(guess - offset2);
}

// The calendar date (YYYY-MM-DD) of a moment, as seen in the organisation's time zone.
export function dateInTimeZone(moment: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(moment);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function timeZoneOffsetMs(moment: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(moment);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(moment.getTime() / 1000) * 1000;
}
