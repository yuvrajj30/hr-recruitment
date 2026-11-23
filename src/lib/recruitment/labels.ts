// Words shown on screen for the values stored in the database.

export const EMPLOYMENT_TYPE_LABELS = {
  FULL_TIME: "Full-time",
  PART_TIME: "Part-time",
  INTERNSHIP: "Internship",
  CONTRACT: "Contract",
} as const;

export const WORK_MODE_LABELS = {
  ON_SITE: "On-site",
  HYBRID: "Hybrid",
  REMOTE: "Remote",
} as const;

export const VISIBILITY_LABELS = {
  PUBLIC: "Public careers page",
  INTERNAL_ONLY: "Internal only",
} as const;

// A date for people to read, in the organisation's time zone: "31 Dec 2026".
export function formatDate(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(value);
}

export function formatDateTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(value);
}

// "₹18,000 – ₹22,000 per month", "From ₹18,000 per month", or null when no pay is given.
export function formatPay(min: string | null, max: string | null, currency: string, period: string | null): string | null {
  if (min === null && max === null) return null;
  const fmt = (v: string) => {
    try {
      return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: Number(v) % 1 === 0 ? 0 : 2 }).format(Number(v));
    } catch {
      return `${currency} ${v}`;
    }
  };
  const range = min !== null && max !== null ? (min === max ? fmt(min) : `${fmt(min)} – ${fmt(max)}`) : min !== null ? `From ${fmt(min)}` : `Up to ${fmt(max!)}`;
  return period ? `${range} ${period}` : range;
}

// "482 KB", "1.3 MB"
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
