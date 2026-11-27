// HR Reports: pure rules (no database). Periods, the figures of each report and CSV writing.
// The figures reuse the attendance and task rules, so a report always agrees with the screens it summarises.
import {
  addDays, type AttendanceStatus, dayStart, isDay, localDay, minutesLate, type Parsed, type RecordLike, recordFlags, workedMinutes,
} from "@/lib/attendance/rules";
import { EMPLOYMENT_TYPE_LABELS, type EmploymentType } from "@/lib/employees/rules";
import { zonedInputToDate } from "@/lib/interviews/rules";
import { type AnyStage, STAGE_LABELS } from "@/lib/recruitment/stages";
import type { TaskStatus } from "@/lib/tasks/rules";

export const REPORT_LIMITS = {
  maxDays: 366, // longest period a report covers
  maxRows: 20_000, // most source rows one report reads; more is refused ("narrow the period"), never cut silently
} as const;

// Refuses (never cuts) a read that came back with more rows than the limit. Reads ask for limit + 1 rows.
export function withinLimit<T>(rows: T[], max: number = REPORT_LIMITS.maxRows): T[] {
  if (rows.length > max) throw new RangeError("report_too_large");
  return rows;
}

export const REPORT_KINDS = ["headcount", "attendance", "leave", "hiring", "tasks"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const isReportKind = (v: unknown): v is ReportKind => typeof v === "string" && (REPORT_KINDS as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// Periods: local days in the organisation's time zone, both ends included.
// ---------------------------------------------------------------------------
export type ReportPeriod = { from: string; to: string };

export const defaultPeriod = (today: string): ReportPeriod => ({ from: `${today.slice(0, 8)}01`, to: today });

const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

export function parsePeriod(raw: { from?: unknown; to?: unknown }, today: string): Parsed<ReportPeriod> {
  const from = typeof raw.from === "string" ? raw.from.trim() : raw.from === undefined ? "" : null;
  const to = typeof raw.to === "string" ? raw.to.trim() : raw.to === undefined ? "" : null;
  if (from === "" && to === "") return { ok: true, value: defaultPeriod(today) };
  if (from === null || !isDay(from)) return { ok: false, errors: { from: "Enter a valid start date." } };
  if (to === null || !isDay(to)) return { ok: false, errors: { to: "Enter a valid end date." } };
  if (to < from) return { ok: false, errors: { to: "The end date cannot be before the start date." } };
  if (dayCount(from, to) > REPORT_LIMITS.maxDays) return { ok: false, errors: { to: `Choose a period of at most ${REPORT_LIMITS.maxDays} days.` } };
  return { ok: true, value: { from, to } };
}

// [first moment of `from`, first moment of the day after `to`).
export const periodRange = (p: ReportPeriod, timeZone: string) => ({ start: dayStart(p.from, timeZone), end: dayStart(addDays(p.to, 1), timeZone) });

// A calendar year for the leave report: this year by default; from 2000 up to next year.
export function parseYear(raw: unknown, today: string): number {
  const current = Number(today.slice(0, 4));
  if (typeof raw !== "string" || !/^\d{4}$/.test(raw)) return current;
  const y = Number(raw);
  return y >= 2000 && y <= current + 1 ? y : current;
}

export type Person = { name: string; code: string };
const UNKNOWN: Person = { name: "Unknown employee", code: "" };
const byName = <T extends { name: string }>(rows: T[]) => rows.sort((a, b) => a.name.localeCompare(b.name) || 0);

// ---------------------------------------------------------------------------
// Headcount
// ---------------------------------------------------------------------------
// exitedOn is the last working day: the person still counts on that day.
export type HcEmployee = { id: string; joinedOn: string; exitedOn: string | null; employmentType: EmploymentType; outlet: string | null; department: string | null };
export type Count = { name: string; count: number };
export type HeadcountReport = {
  atStart: number; atEnd: number; joiners: number; leavers: number; turnoverPercent: number | null;
  byOutlet: Count[]; byDepartment: Count[]; byType: Count[];
};

const employedOn = (e: HcEmployee, day: string) => e.joinedOn <= day && (e.exitedOn === null || e.exitedOn >= day);
function countBy(items: string[]): Count[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function summariseHeadcount(people: HcEmployee[], p: ReportPeriod): HeadcountReport {
  const atStart = people.filter((e) => employedOn(e, p.from)).length;
  const end = people.filter((e) => employedOn(e, p.to));
  const leavers = people.filter((e) => e.exitedOn !== null && e.exitedOn >= p.from && e.exitedOn <= p.to).length;
  const average = (atStart + end.length) / 2;
  return {
    atStart,
    atEnd: end.length,
    joiners: people.filter((e) => e.joinedOn >= p.from && e.joinedOn <= p.to).length,
    leavers,
    turnoverPercent: average > 0 ? Math.round((leavers / average) * 1000) / 10 : null,
    byOutlet: countBy(end.map((e) => e.outlet ?? "No outlet")),
    byDepartment: countBy(end.map((e) => e.department ?? "No department")),
    byType: countBy(end.map((e) => EMPLOYMENT_TYPE_LABELS[e.employmentType])),
  };
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------
export type AttShift = {
  id: string; employeeId: string; startsAt: Date; endsAt: Date; status: "PLANNED" | "CANCELLED"; breakMinutes: number; records: { status: AttendanceStatus }[];
};
export type AttRecord = RecordLike & { employeeId: string; shiftId: string | null };
export type AttendanceRow = {
  employeeId: string; name: string; code: string;
  planned: number; attended: number; missed: number; onLeave: number; upcoming: number;
  late: number; lateMinutes: number; early: number; missingOut: number; unplanned: number; workedMinutes: number;
};

// leaveDays: `${employeeId}|${local day}` for each day of approved leave. A missed shift on such a day is "on leave".
export function summariseAttendance(
  people: Map<string, Person>, shifts: AttShift[], records: AttRecord[], leaveDays: Set<string>, timeZone: string, now: Date,
): AttendanceRow[] {
  const rows = new Map<string, AttendanceRow>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) {
      const p = people.get(id) ?? UNKNOWN;
      rows.set(id, (r = { employeeId: id, name: p.name, code: p.code, planned: 0, attended: 0, missed: 0, onLeave: 0, upcoming: 0,
        late: 0, lateMinutes: 0, early: 0, missingOut: 0, unplanned: 0, workedMinutes: 0 }));
    }
    return r;
  };
  for (const s of shifts) {
    if (s.status !== "PLANNED") continue;
    const r = row(s.employeeId);
    r.planned++;
    if (s.records.some((x) => x.status !== "VOID")) r.attended++;
    else if (s.endsAt.getTime() > now.getTime()) r.upcoming++;
    else if (leaveDays.has(`${s.employeeId}|${localDay(s.startsAt, timeZone)}`)) r.onLeave++;
    else r.missed++;
  }
  for (const rec of records) {
    if (rec.status === "VOID") continue;
    const r = row(rec.employeeId);
    const flags = recordFlags(rec, now);
    if (flags.includes("late")) {
      r.late++;
      r.lateMinutes += minutesLate(rec);
    }
    if (flags.includes("early")) r.early++;
    if (flags.includes("missing_out")) r.missingOut++;
    if (flags.includes("unplanned")) r.unplanned++;
    r.workedMinutes += workedMinutes(rec, now) ?? 0;
  }
  return byName([...rows.values()]);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export type ReportTask = {
  ownerEmployeeId: string; status: TaskStatus; dueOn: string; dueTime: string | null; submittedAt: Date | null; rating: number | null; changesRequested: number;
};
export type TaskRow = {
  employeeId: string; name: string; code: string;
  assigned: number; approved: number; onTime: number; overdue: number; changesRequested: number; averageRating: number | null;
  ratingCount: number; ratingSum: number;
};
const OWNER_TURN: readonly TaskStatus[] = ["ASSIGNED", "IN_PROGRESS", "CHANGES_REQUESTED"];

// The deadline: the due time, or else the end of the due day, in the organisation's time zone.
export function taskDeadline(t: { dueOn: string; dueTime: string | null }, timeZone: string): Date | null {
  return t.dueTime ? zonedInputToDate(`${t.dueOn}T${t.dueTime.slice(0, 5)}`, timeZone) : dayStart(addDays(t.dueOn, 1), timeZone);
}

export function summariseTasks(people: Map<string, Person>, tasks: ReportTask[], timeZone: string, now: Date): TaskRow[] {
  const rows = new Map<string, TaskRow & { ratings: number[] }>();
  for (const t of tasks) {
    if (t.status === "CANCELLED") continue;
    let r = rows.get(t.ownerEmployeeId);
    if (!r) {
      const p = people.get(t.ownerEmployeeId) ?? UNKNOWN;
      rows.set(t.ownerEmployeeId, (r = { employeeId: t.ownerEmployeeId, name: p.name, code: p.code, assigned: 0, approved: 0, onTime: 0, overdue: 0,
        changesRequested: 0, averageRating: null, ratingCount: 0, ratingSum: 0, ratings: [] }));
    }
    const deadline = taskDeadline(t, timeZone);
    r.assigned++;
    r.changesRequested += t.changesRequested;
    if (t.status === "APPROVED") {
      r.approved++;
      if (t.submittedAt && deadline && t.submittedAt.getTime() <= deadline.getTime()) r.onTime++;
      if (t.rating !== null) r.ratings.push(t.rating);
    } else if (OWNER_TURN.includes(t.status) && deadline && now.getTime() > deadline.getTime()) {
      r.overdue++;
    }
  }
  return byName([...rows.values()].map(({ ratings, ...r }) => {
    const sum = ratings.reduce((a, b) => a + b, 0);
    return { ...r, ratingCount: ratings.length, ratingSum: sum, averageRating: ratings.length ? Math.round((sum / ratings.length) * 10) / 10 : null };
  }));
}

// ---------------------------------------------------------------------------
// Hiring: counts only, never who the candidates are.
// ---------------------------------------------------------------------------
export const STAGE_ORDER: readonly AnyStage[] = [
  "APPLIED", "UNDER_REVIEW", "SHORTLISTED", "INTERVIEW_SCHEDULED", "INTERVIEW_COMPLETED", "SELECTED", "OFFER_ISSUED", "OFFER_ACCEPTED", "ONBOARDING",
  "JOINED", "REJECTED", "WITHDRAWN", "OFFER_DECLINED",
];
export type HiringApplication = { jobId: string; stage: AnyStage; appliedAt: Date };
export type HiringHistory = { jobId: string; applicationId: string; toStage: AnyStage; createdAt: Date };
export type HiringJobRow = {
  jobId: string; title: string; received: number; interviewing: number; selected: number; offerAccepted: number; joined: number; rejected: number;
};
export type HiringReport = { jobs: HiringJobRow[]; pipeline: { stage: AnyStage; label: string; count: number }[] };
const MOVES: Partial<Record<AnyStage, keyof Omit<HiringJobRow, "jobId" | "title" | "received">>> = {
  INTERVIEW_SCHEDULED: "interviewing", SELECTED: "selected", OFFER_ACCEPTED: "offerAccepted", JOINED: "joined", REJECTED: "rejected",
};

export function summariseHiring(
  jobs: { id: string; title: string }[], applications: HiringApplication[], history: HiringHistory[], range: { start: Date; end: Date },
): HiringReport {
  const inRange = (d: Date) => d.getTime() >= range.start.getTime() && d.getTime() < range.end.getTime();
  const rows = new Map(jobs.map((j) => [j.id, { jobId: j.id, title: j.title, received: 0, interviewing: 0, selected: 0, offerAccepted: 0, joined: 0, rejected: 0 }]));
  for (const a of applications) {
    const r = rows.get(a.jobId);
    if (r && inRange(a.appliedAt)) r.received++;
  }
  // Each application counts once per stage, even if it moved into that stage twice in the period.
  const seen = new Set<string>();
  for (const h of history) {
    const r = rows.get(h.jobId);
    const field = MOVES[h.toStage];
    const key = `${h.applicationId}|${h.toStage}`;
    if (!r || !field || !inRange(h.createdAt) || seen.has(key)) continue;
    seen.add(key);
    r[field]++;
  }
  const stages = new Map<AnyStage, number>();
  for (const a of applications) if (rows.has(a.jobId)) stages.set(a.stage, (stages.get(a.stage) ?? 0) + 1);
  return {
    jobs: [...rows.values()].sort((a, b) => a.title.localeCompare(b.title)),
    pipeline: STAGE_ORDER.filter((s) => stages.has(s)).map((stage) => ({ stage, label: STAGE_LABELS[stage], count: stages.get(stage)! })),
  };
}

// ---------------------------------------------------------------------------
// CSV: UTF-8 with a byte-order mark and CRLF, as spreadsheet programs expect. Text that a spreadsheet would run as a
// formula (starting with = + - @, a tab or a carriage return) is prefixed with ' so it stays text.
// ---------------------------------------------------------------------------
export type CsvCell = string | number | null;
function cell(v: CsvCell): string {
  if (v === null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export function toCsv(headers: string[], rows: CsvCell[][]): string {
  return `﻿${[headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// The filters in a report's address (?from=&to=&outlet=&year=), read the same way by the pages and the CSV download.
// A bad period falls back to the default and says why; an outlet that is not an id is ignored.
// ---------------------------------------------------------------------------
export type ReportQuery = { period: ReportPeriod; outletId: string | null; year: number; errors: Record<string, string> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readReportQuery(q: Record<string, string | string[] | undefined>, today: string): ReportQuery {
  const one = (v: string | string[] | undefined): unknown => (Array.isArray(v) ? null : v);
  const parsed = parsePeriod({ from: one(q.from) ?? undefined, to: one(q.to) ?? undefined }, today);
  const outlet = one(q.outlet);
  return {
    period: parsed.ok ? parsed.value : defaultPeriod(today),
    outletId: typeof outlet === "string" && UUID_RE.test(outlet) ? outlet : null,
    year: parseYear(one(q.year), today),
    errors: parsed.ok ? {} : parsed.errors,
  };
}
