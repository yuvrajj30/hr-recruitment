// Employee Management: pure input rules (no database, no server-only code), shared by the server and the forms.
// The database enforces the same limits again (migration 20261121000000_employee_management).

export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  FULL_TIME: "Full-time",
  PART_TIME: "Part-time",
  CONTRACT: "Contract",
  INTERNSHIP: "Internship",
};
export const EMPLOYEE_STATUSES = ["ACTIVE", "EXITED"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export type EmployeeInput = {
  employeeCode: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  employmentType: EmploymentType;
  joinedOn: string; // YYYY-MM-DD
  outletId: string | null;
  departmentId: string | null;
  designationId: string | null;
  managerId: string | null;
};
export type StructureInput = { name: string; address: string | null };

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[0-9][0-9 -]{5,19}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const text = (v: unknown): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
const optional = (v: unknown): string | null => text(v) || null;

// A real calendar date in YYYY-MM-DD (2026-02-30 is refused).
export function isCalendarDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const EMPLOYEE_FIELDS = ["employeeCode", "fullName", "email", "phone", "employmentType", "joinedOn", "outletId", "departmentId", "designationId", "managerId"] as const;
export function formDataToEmployeeFields(fd: FormData): Record<string, string | undefined> {
  return Object.fromEntries(EMPLOYEE_FIELDS.map((k) => [k, typeof fd.get(k) === "string" ? (fd.get(k) as string) : undefined]));
}

export function parseEmployeeInput(raw: Record<string, unknown>, today: string): Parsed<EmployeeInput> {
  const errors: Record<string, string> = {};
  const employeeCode = text(raw.employeeCode);
  const fullName = text(raw.fullName);
  const email = optional(raw.email)?.toLowerCase() ?? null;
  const phone = optional(raw.phone);
  const employmentType = text(raw.employmentType) || "FULL_TIME";
  const joinedOn = text(raw.joinedOn);
  if (!CODE.test(employeeCode)) errors.employeeCode = "Use 1 to 32 letters, digits or dashes (for example TTC-014).";
  if (fullName.length < 1 || fullName.length > 120) errors.fullName = "Enter the name (up to 120 characters).";
  if (email && (!EMAIL.test(email) || email.length > 254)) errors.email = "Enter a valid email address, or leave it empty.";
  if (phone && !PHONE.test(phone)) errors.phone = "Enter a phone number with 6 to 20 digits, or leave it empty.";
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(employmentType)) errors.employmentType = "Choose an employment type.";
  if (!isCalendarDate(joinedOn)) errors.joinedOn = "Enter the joining date.";
  else if (joinedOn > addDays(today, 366)) errors.joinedOn = "The joining date can be at most a year ahead.";
  const ref = (k: string) => {
    const v = text(raw[k]);
    if (!v) return null;
    if (!UUID.test(v)) errors[k] = "Choose from the list.";
    return v;
  };
  const value: EmployeeInput = {
    employeeCode, fullName, email, phone, employmentType: employmentType as EmploymentType, joinedOn,
    outletId: ref("outletId"), departmentId: ref("departmentId"), designationId: ref("designationId"), managerId: ref("managerId"),
  };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

export function parseExitDate(raw: unknown, joinedOn: string, today: string): Parsed<string> {
  const d = text(raw);
  if (!isCalendarDate(d)) return { ok: false, errors: { exitedOn: "Enter the last working day." } };
  if (d < joinedOn) return { ok: false, errors: { exitedOn: "The last working day cannot be before the joining date." } };
  if (d > addDays(today, 366)) return { ok: false, errors: { exitedOn: "The last working day can be at most a year ahead." } };
  return { ok: true, value: d };
}

export function parseStructureInput(raw: Record<string, unknown>, withAddress: boolean): Parsed<StructureInput> {
  const errors: Record<string, string> = {};
  const name = text(raw.name);
  const address = withAddress ? optional(raw.address) : null;
  if (name.length < 1 || name.length > 120) errors.name = "Enter a name (up to 120 characters).";
  if (address && address.length > 500) errors.address = "Keep the address under 500 characters.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { name, address } };
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
