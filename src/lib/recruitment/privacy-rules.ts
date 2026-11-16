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
