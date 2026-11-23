import { z } from "zod";
import { parseSkills } from "./job-input";

// What a candidate (public form) or an HR user (manual entry) submits with an application.
// Pure functions only, shared by both entry points, so the rules are identical and unit tested.
//
// The field list is kept in one place (APPLICATION_FIELDS) on purpose: when the configurable
// Form Builder arrives, extra questions can be added beside these fixed ones without changing them.

export const APPLICATION_LIMITS = {
  name: 120,
  email: 254,
  phone: 20,
  city: 80,
  institution: 160,
  course: 120,
  degree: 120,
  skills: 30,
  skillLength: 60,
  company: 120,
  title: 120,
  experience: 2_000,
  url: 300,
  source: 120,
} as const;

const required = (max: number, message: string) => z.string().trim().min(1, message).max(max, `Must be ${max} characters or fewer.`);

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer.`)
    .optional()
    .transform((v) => (v ? v : null));

// Links must be ordinary https web addresses (no javascript:, data: or internal addresses rendered as links).
const optionalUrl = (hostHint: string | null, label: string) =>
  z
    .string()
    .trim()
    .max(APPLICATION_LIMITS.url)
    .optional()
    .transform((v, ctx) => {
      if (!v) return null;
      const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
      let url: URL;
      try {
        url = new URL(withScheme);
      } catch {
        ctx.addIssue({ code: "custom", message: `Enter a valid ${label} link.` });
        return z.NEVER;
      }
      const hostOk = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || !hostOk || url.username || url.password) {
        ctx.addIssue({ code: "custom", message: `Enter a valid ${label} link.` });
        return z.NEVER;
      }
      if (hostHint && !(url.hostname === hostHint || url.hostname.endsWith(`.${hostHint}`))) {
        ctx.addIssue({ code: "custom", message: `This must be a ${hostHint} link.` });
        return z.NEVER;
      }
      url.protocol = "https:";
      return url.toString();
    });

export const applicationInputSchema = z
  .object({
    fullName: required(APPLICATION_LIMITS.name, "Enter the full name.").refine((v) => v.length >= 2 && /\p{L}/u.test(v), "Enter the full name."),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "Enter an email address.")
      .max(APPLICATION_LIMITS.email)
      .pipe(z.email("Enter a valid email address.")),
    phone: z
      .string()
      .trim()
      .min(1, "Enter a phone number.")
      .max(30)
      .transform((v, ctx) => {
        const phone = normalizePhone(v);
        if (!phone) {
          ctx.addIssue({ code: "custom", message: "Enter a valid phone number, with the country code if it is outside India." });
          return z.NEVER;
        }
        return phone;
      }),
    city: optional(APPLICATION_LIMITS.city),
    institution: optional(APPLICATION_LIMITS.institution),
    course: optional(APPLICATION_LIMITS.course),
    degree: optional(APPLICATION_LIMITS.degree),
    graduationYear: z
      .string()
      .trim()
      .optional()
      .transform((v, ctx) => {
        if (!v) return null;
        const year = /^\d{4}$/.test(v) ? Number(v) : NaN;
        if (!(year >= 1950 && year <= 2100)) {
          ctx.addIssue({ code: "custom", message: "Enter the year as four digits, for example 2025." });
          return z.NEVER;
        }
        return year;
      }),
    skills: z
      .string()
      .optional()
      .transform((v, ctx) => {
        const skills = parseSkills(v ?? "");
        if (skills.length > APPLICATION_LIMITS.skills || skills.some((s) => s.length > APPLICATION_LIMITS.skillLength)) {
          ctx.addIssue({ code: "custom", message: `List at most ${APPLICATION_LIMITS.skills} skills, each ${APPLICATION_LIMITS.skillLength} characters or fewer.` });
          return z.NEVER;
        }
        return skills;
      }),
    experienceCompany: optional(APPLICATION_LIMITS.company),
    experienceTitle: optional(APPLICATION_LIMITS.title),
    experienceDescription: optional(APPLICATION_LIMITS.experience),
    linkedinUrl: optionalUrl("linkedin.com", "LinkedIn"),
    portfolioUrl: optionalUrl(null, "portfolio or GitHub"),
    source: optional(APPLICATION_LIMITS.source),
  })
  .superRefine((v, ctx) => {
    if ((v.course || v.degree || v.graduationYear) && !v.institution) {
      ctx.addIssue({ code: "custom", path: ["institution"], message: "Enter the college or university." });
    }
    if (Boolean(v.experienceCompany) !== Boolean(v.experienceTitle)) {
      ctx.addIssue({
        code: "custom",
        path: [v.experienceCompany ? "experienceTitle" : "experienceCompany"],
        message: "Enter both the company and the role, or leave both empty.",
      });
    }
  });

export type ApplicationInput = z.output<typeof applicationInputSchema>;
export type ApplicationField = keyof z.input<typeof applicationInputSchema>;

export const APPLICATION_FIELDS: readonly ApplicationField[] = [
  "fullName",
  "email",
  "phone",
  "city",
  "institution",
  "course",
  "degree",
  "graduationYear",
  "skills",
  "experienceCompany",
  "experienceTitle",
  "experienceDescription",
  "linkedinUrl",
  "portfolioUrl",
  "source",
];

// Only the known text fields are read; a field sent twice or as a file counts as missing.
export function formDataToApplicationFields(formData: FormData): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const field of APPLICATION_FIELDS) {
    const values = formData.getAll(field);
    out[field] = values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
  }
  return out;
}

export type ParsedApplication = { ok: true; value: ApplicationInput } | { ok: false; errors: Record<string, string> };

export function parseApplicationInput(raw: Record<string, string | undefined>): ParsedApplication {
  const result = applicationInputSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !errors[field]) errors[field] = issue.message;
  }
  return { ok: false, errors };
}

// "+91 98765-43210", "098765 43210", "9876543210" -> "+919876543210".
// A number with another country code keeps it ("+44 20 7946 0958" -> "+442079460958").
// Returns null when it cannot be a phone number.
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^[+\d][\d\s().-]*$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  const local = digits.replace(/^0+/, "");
  if (local.length === 10) return `+91${local}`;
  if (local.length === 12 && local.startsWith("91")) return `+${local}`;
  return null;
}

// The part of a phone number used to spot the same person under two emails: its last 10 digits.
export const phoneMatchKey = (phone: string): string => phone.replace(/\D/g, "").slice(-10);

// The copy of what was submitted, stored with the application. It never changes afterwards,
// so the organisation always sees exactly what this application said.
export type ProfileSnapshot = {
  version: 1;
  fullName: string;
  email: string;
  phone: string;
  city: string | null;
  education: { institution: string; course: string | null; degree: string | null; graduationYear: number | null } | null;
  skills: string[];
  experience: { company: string; title: string; description: string | null } | null;
  experienceNote: string | null; // experience described without a company/role
  linkedinUrl: string | null;
  portfolioUrl: string | null;
};

export function toSnapshot(input: ApplicationInput): ProfileSnapshot {
  const hasJob = input.experienceCompany !== null && input.experienceTitle !== null;
  return {
    version: 1,
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
    city: input.city,
    education: input.institution ? { institution: input.institution, course: input.course, degree: input.degree, graduationYear: input.graduationYear } : null,
    skills: input.skills,
    experience: hasJob ? { company: input.experienceCompany!, title: input.experienceTitle!, description: input.experienceDescription } : null,
    experienceNote: hasJob ? null : input.experienceDescription,
    linkedinUrl: input.linkedinUrl,
    portfolioUrl: input.portfolioUrl,
  };
}

// Reads a stored snapshot defensively: it is JSON from the database, so nothing about its shape is assumed.
export function readSnapshot(value: unknown): ProfileSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  if (v.version !== 1 || typeof v.fullName !== "string" || typeof v.email !== "string") return null;
  const edu = v.education && typeof v.education === "object" ? (v.education as Record<string, unknown>) : null;
  const exp = v.experience && typeof v.experience === "object" ? (v.experience as Record<string, unknown>) : null;
  return {
    version: 1,
    fullName: v.fullName,
    email: v.email,
    phone: str(v.phone) ?? "",
    city: str(v.city),
    education:
      edu && typeof edu.institution === "string"
        ? { institution: edu.institution, course: str(edu.course), degree: str(edu.degree), graduationYear: typeof edu.graduationYear === "number" ? edu.graduationYear : null }
        : null,
    skills: Array.isArray(v.skills) ? v.skills.filter((s): s is string => typeof s === "string") : [],
    experience: exp && typeof exp.company === "string" && typeof exp.title === "string" ? { company: exp.company, title: exp.title, description: str(exp.description) } : null,
    experienceNote: str(v.experienceNote),
    linkedinUrl: safeHttpsUrl(v.linkedinUrl),
    portfolioUrl: safeHttpsUrl(v.portfolioUrl),
  };
}

// A stored link is shown as a clickable link only if it is still a plain https address.
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

// "APP-2026-7K3QXM": year plus six characters from an alphabet without look-alikes (no 0/O, 1/I/L).
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function makeReferenceNumber(year: number, randomBytes: Uint8Array): string {
  let code = "";
  for (let i = 0; i < 6; i++) code += REFERENCE_ALPHABET[randomBytes[i]! % REFERENCE_ALPHABET.length];
  return `APP-${year}-${code}`;
}
export const looksLikeReference = (text: string): boolean => /^APP-\d{4}-[2-9A-Z]{1,6}$/i.test(text.trim());
