// Candidate privacy rules shared by the server and the forms (no server-only code here).
// Decided 16 Nov 2026; the wording of the notice built from these needs a legal review before production.

// Applicants confirm they are at least this old; no date of birth is collected.
export const MINIMUM_APPLICANT_AGE = 18;

// Which privacy notice an application was made under (stored with every application).
// "2026-11-2": the full notice page, the age confirmation, and no IP address recorded.
export const PRIVACY_NOTICE_VERSION = "2026-11-2";

// Database backups that may contain a removed candidate are deleted after this many days.
export const BACKUP_RETENTION_DAYS = 30;

// How long candidates who were not hired are kept, in months: the allowed range and the default.
export const RETENTION_MONTHS = { min: 1, max: 120, default: 12 } as const;

// Applications in these stages are finished without a hire; a candidate whose applications are ALL in
// these stages may be removed (and becomes due for removal after the retention period).
export const REMOVABLE_STAGES = ["REJECTED", "WITHDRAWN", "OFFER_DECLINED"] as const;

// What an applicant (or HR, on the candidate's word) confirmed with an application.
export type ApplicationConfirmations = { ageConfirmed: boolean };

export const privacyNoticePath = (organizationSlug: string) => `/careers/${organizationSlug}/privacy`;

// The retention cutoff: `months` calendar months before `now`, in UTC, with the day clamped to the end of a shorter
// month (31 March minus 1 month is 28/29 February), exactly as the database's retention job computes it.
export function retentionCutoff(now: Date, months: number): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() - months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(now.getUTCDate(), lastDay),
    now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds()));
}

// For RETENTION_SHORTENING_GRACE_DAYS after an organisation shortens its retention period, the automatic job keeps
// using the longer previous period (the database maintains both values), so a typo cannot remove people overnight.
export const RETENTION_SHORTENING_GRACE_DAYS = 14;
export function effectiveRetentionMonths(
  org: { months: number; previousMonths: number | null; shortenedAt: Date | null },
  now: Date,
): number {
  const inGrace = org.shortenedAt !== null && org.shortenedAt.getTime() > now.getTime() - RETENTION_SHORTENING_GRACE_DAYS * 86_400_000;
  return inGrace ? Math.max(org.months, org.previousMonths ?? 0) : org.months;
}
